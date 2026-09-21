import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue, RunResult, TraceSink } from "./types.js";

type LockRecord = Readonly<{
  pid: number;
  runId: string;
  acquiredAt: string;
}>;

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error(`${path} is not a directory`);
    assertOwnedByCurrentUser(path, metadata.uid);
    if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700) {
      throw new Error(`${path} must have mode 0700`);
    }
  } finally {
    await handle.close();
  }
}

function assertOwnedByCurrentUser(path: string, ownerUid: number): void {
  if (typeof process.getuid === "function" && ownerUid !== process.getuid()) {
    throw new Error(`${path} is not owned by the current user`);
  }
}

function assertPrivateFile(path: string, metadata: Stats): void {
  if (!metadata.isFile()) throw new Error(`${path} is not a regular file`);
  assertOwnedByCurrentUser(path, metadata.uid);
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${path} must have mode 0600`);
  }
}

async function readPrivateFile(
  path: string,
  maximumBytes: number,
): Promise<{ data: Buffer; modifiedMs: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    assertPrivateFile(path, metadata);
    if (metadata.size > maximumBytes)
      throw new Error(`${path} exceeds its size limit`);
    return { data: await handle.readFile(), modifiedMs: metadata.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function readPrivateJson<T>(
  path: string,
  maximumBytes = 1_048_576,
): Promise<T> {
  const { data } = await readPrivateFile(path, maximumBytes);
  return JSON.parse(data.toString("utf8")) as T;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    // Some filesystems explicitly do not implement directory fsync. Propagate
    // real I/O and capacity failures rather than silently weakening durability.
    if (
      isErrno(error, "EINVAL") ||
      isErrno(error, "ENOTSUP") ||
      isErrno(error, "EOPNOTSUPP") ||
      (process.platform === "win32" &&
        (isErrno(error, "EBADF") || isErrno(error, "EPERM")))
    ) {
      return;
    }
    throw error;
  }
}

async function atomicWriteJson(
  path: string,
  directory: string,
  value: unknown,
): Promise<void> {
  await ensurePrivateDirectory(directory);
  const temporary = join(
    directory,
    `.tmp-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function publishPrivateFileNoReplace(
  path: string,
  directory: string,
  data: string | Buffer,
): Promise<void> {
  await ensurePrivateDirectory(directory);
  const preparedPath = join(
    directory,
    `.prepared-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
  );
  const handle = await open(preparedPath, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A hard link publishes the fully fsynced inode atomically and refuses to
    // replace an existing safety authority file.
    await link(preparedPath, path);
    await syncDirectory(directory);
  } catch (error: unknown) {
    await unlink(preparedPath).catch(() => undefined);
    throw error;
  }
  // The final pathname is already durable. A stranded prepared hard link is
  // harmless and ignored by scanners if cleanup itself is interrupted.
  await unlink(preparedPath).catch(() => undefined);
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrno(error, "EPERM");
  }
}

export class DesktopLease {
  private readonly lockPath: string;

  constructor(private readonly stateDirectory: string) {
    this.lockPath = join(stateDirectory, "desktop.lock");
  }

  async acquire(runId: string): Promise<() => Promise<void>> {
    await ensurePrivateDirectory(this.stateDirectory);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record: LockRecord = Object.freeze({
        pid: process.pid,
        runId,
        acquiredAt: new Date().toISOString(),
      });
      const preparedPath = join(
        this.stateDirectory,
        `.desktop-lock-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
      );
      try {
        // Publish a fully written lock with an atomic, no-replace hard link.
        // Contenders can never observe an ownerless live lock.
        const handle = await open(preparedPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(record), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(preparedPath, this.lockPath);
        await unlink(preparedPath);
        let released = false;
        return async () => {
          if (released) return;
          try {
            const current = await readPrivateJson<Partial<LockRecord>>(
              this.lockPath,
              16_384,
            );
            if (current.pid === record.pid && current.runId === record.runId) {
              await unlink(this.lockPath);
            }
            released = true;
          } catch (error: unknown) {
            if (isErrno(error, "ENOENT")) {
              released = true;
              return;
            }
            // Preserve retryability when reading or removing the exact owned
            // lock fails. Marking this released before success can strand a
            // live-process lock forever inside a long-running MCP server.
            throw error;
          }
        };
      } catch (error: unknown) {
        await unlink(preparedPath).catch(() => undefined);
        if (!isErrno(error, "EEXIST")) throw error;
        let existing: Partial<LockRecord> = {};
        let ageMs = 0;
        try {
          const result = await readPrivateFile(this.lockPath, 16_384);
          ageMs = Math.max(0, Date.now() - result.modifiedMs);
          existing = JSON.parse(
            result.data.toString("utf8"),
          ) as Partial<LockRecord>;
        } catch {
          // A malformed fresh lock is never reclaimed inside the grace window.
        }
        if (
          typeof existing.pid === "number" &&
          (await processIsAlive(existing.pid))
        ) {
          throw new Error(
            `desktop controller is busy with run ${existing.runId ?? "unknown"}`,
          );
        }
        if (typeof existing.pid !== "number" && ageMs < 30_000) {
          throw new Error(
            "desktop controller is busy with a lock whose owner metadata is still being written",
          );
        }
        try {
          await rename(
            this.lockPath,
            `${this.lockPath}.stale.${Date.now()}.${attempt}`,
          );
        } catch (renameError: unknown) {
          if (!isErrno(renameError, "ENOENT")) throw renameError;
        }
      }
    }
    throw new Error("could not acquire the desktop controller lease");
  }

  async status(): Promise<{
    busy: boolean;
    ownerPid?: number;
    runId?: string;
  }> {
    try {
      const existing = await readPrivateJson<Partial<LockRecord>>(
        this.lockPath,
        16_384,
      );
      const busy =
        typeof existing.pid === "number" &&
        (await processIsAlive(existing.pid));
      return {
        busy,
        ...(busy && typeof existing.pid === "number"
          ? { ownerPid: existing.pid }
          : {}),
        ...(busy && typeof existing.runId === "string"
          ? { runId: existing.runId }
          : {}),
      };
    } catch {
      try {
        const metadata = await lstat(this.lockPath);
        return { busy: Date.now() - metadata.mtimeMs < 30_000 };
      } catch {
        return { busy: false };
      }
    }
  }
}

type ExecutionBarrierState =
  | "active"
  | "cleanup_unconfirmed"
  | "reconciliation_required";

type ExecutionBarrierRecord = Readonly<{
  schema: "jev-cua.execution-safety-barrier.v1";
  runId: string;
  session: string;
  state: ExecutionBarrierState;
  markedAt: string;
  updatedAt: string;
}>;

export class LiveExecutionBarrier {
  private readonly path: string;

  constructor(private readonly stateDirectory: string) {
    this.path = join(stateDirectory, "live-execution-blocked.json");
  }

  async assertClear(): Promise<void> {
    const status = await this.status();
    if (status.blocked) {
      throw new Error(
        "live computer-use execution is blocked by an unresolved prior execution",
      );
    }
  }

  async markActive(runId: string, session: string): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory);
    const now = new Date().toISOString();
    const record: ExecutionBarrierRecord = Object.freeze({
      schema: "jev-cua.execution-safety-barrier.v1",
      runId,
      session,
      state: "active",
      markedAt: now,
      updatedAt: now,
    });
    await publishPrivateFileNoReplace(
      this.path,
      this.stateDirectory,
      JSON.stringify(record),
    );
  }

  async retain(
    runId: string,
    session: string,
    state: Exclude<ExecutionBarrierState, "active">,
  ): Promise<void> {
    const record = await this.readOwnedRecord(runId, session);
    await atomicWriteJson(this.path, this.stateDirectory, {
      ...record,
      state,
      updatedAt: new Date().toISOString(),
    } satisfies ExecutionBarrierRecord);
  }

  async clear(runId: string, session: string): Promise<void> {
    await this.readOwnedRecord(runId, session);
    await unlink(this.path);
    await syncDirectory(this.stateDirectory);
  }

  async archiveResolved(runId: string, session: string): Promise<string> {
    await this.readOwnedRecord(runId, session);
    const archiveDirectory = join(
      this.stateDirectory,
      "reconciled-execution-barriers",
    );
    await ensurePrivateDirectory(archiveDirectory);
    const destination = join(
      archiveDirectory,
      `${new Date().toISOString().replace(/[^0-9]/gu, "")}-${createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 16)}-${randomBytes(4).toString("hex")}.json`,
    );
    await rename(this.path, destination);
    await Promise.all([
      syncDirectory(this.stateDirectory),
      syncDirectory(archiveDirectory),
    ]);
    return destination;
  }

  async status(): Promise<
    Readonly<{
      blocked: boolean;
      runId?: string;
      session?: string;
      state?: ExecutionBarrierState;
      markedAt?: string;
      updatedAt?: string;
    }>
  > {
    try {
      const record = await readPrivateJson<Partial<ExecutionBarrierRecord>>(
        this.path,
        16_384,
      );
      if (
        record.schema !== "jev-cua.execution-safety-barrier.v1" ||
        typeof record.runId !== "string" ||
        typeof record.session !== "string" ||
        !isExecutionBarrierState(record.state) ||
        typeof record.markedAt !== "string" ||
        typeof record.updatedAt !== "string"
      ) {
        return Object.freeze({ blocked: true });
      }
      return Object.freeze({
        blocked: true,
        runId: record.runId,
        session: record.session,
        state: record.state,
        markedAt: record.markedAt,
        updatedAt: record.updatedAt,
      });
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return Object.freeze({ blocked: false });
      // A malformed, unsafe, or unreadable barrier must fail closed.
      return Object.freeze({ blocked: true });
    }
  }

  private async readOwnedRecord(
    runId: string,
    session: string,
  ): Promise<ExecutionBarrierRecord> {
    const record = await readPrivateJson<Partial<ExecutionBarrierRecord>>(
      this.path,
      16_384,
    );
    if (
      record.schema !== "jev-cua.execution-safety-barrier.v1" ||
      record.runId !== runId ||
      record.session !== session ||
      !isExecutionBarrierState(record.state) ||
      typeof record.markedAt !== "string" ||
      typeof record.updatedAt !== "string"
    ) {
      throw new Error(
        "execution safety barrier is not owned by this browser session",
      );
    }
    return record as ExecutionBarrierRecord;
  }
}

function isExecutionBarrierState(
  value: unknown,
): value is ExecutionBarrierState {
  return (
    value === "active" ||
    value === "cleanup_unconfirmed" ||
    value === "reconciliation_required"
  );
}

export type RunPhase =
  | "reserved"
  | "browser_setup_started"
  | "browser_setup_returned"
  | "action_started"
  | "action_returned";

export function activeRunRequiresReconciliation(phase: RunPhase): boolean {
  return phase !== "reserved";
}

export type RunOperationDescriptor = Readonly<{
  policyFingerprint: string;
  semanticStep: string;
  actionClass: string;
  operationId: string;
}>;

export type StoredRun =
  | Readonly<{
      status: "active";
      runId: string;
      runKeyHash: string;
      requestFingerprint: string;
      startedAt: string;
      pid: number;
      phase: RunPhase;
      operation?: RunOperationDescriptor;
    }>
  | Readonly<{
      status: "complete";
      requestFingerprint: string;
      lastPhase: RunPhase;
      result: RunResult;
    }>;

type ReconciliationAcknowledgement = Readonly<{
  schema: "jev-cua.reconciliation-acknowledgement.v1";
  runId: string;
  runRecordSha256: string;
  reason:
    | "barrier_owned_reserved"
    | "interrupted_live_run"
    | "cleanup_unconfirmed"
    | "workflow_reconciliation_required";
  acknowledgedAt: string;
}>;

export class RunStore {
  private readonly runsDirectory: string;
  private readonly reconciliationsDirectory: string;
  private readonly identityKeyPath: string;
  private identityKeyPromise: Promise<Buffer> | undefined;

  constructor(stateDirectory: string) {
    this.runsDirectory = join(stateDirectory, "runs");
    this.reconciliationsDirectory = join(stateDirectory, "reconciliations");
    this.identityKeyPath = join(stateDirectory, "identity.key");
  }

  private async identityKey(): Promise<Buffer> {
    if (!this.identityKeyPromise)
      this.identityKeyPromise = this.loadOrCreateIdentityKey();
    try {
      return await this.identityKeyPromise;
    } catch (error: unknown) {
      this.identityKeyPromise = undefined;
      throw error;
    }
  }

  private async loadOrCreateIdentityKey(): Promise<Buffer> {
    const stateDirectory = join(this.runsDirectory, "..");
    await ensurePrivateDirectory(stateDirectory);
    try {
      await publishPrivateFileNoReplace(
        this.identityKeyPath,
        stateDirectory,
        randomBytes(32),
      );
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const { data: key } = await readPrivateFile(this.identityKeyPath, 32);
    if (key.length !== 32)
      throw new Error("jev-cua state identity key is malformed");
    return key;
  }

  private async keyedDigest(
    domain: "run-key" | "request",
    value: string,
  ): Promise<string> {
    const key = await this.identityKey();
    return createHmac("sha256", key)
      .update(`jev-cua:v1:${domain}\0`, "utf8")
      .update(value, "utf8")
      .digest("hex");
  }

  async runKeyHash(runKey: string): Promise<string> {
    return this.keyedDigest("run-key", runKey);
  }

  private pathFor(runKeyHash: string): string {
    return join(this.runsDirectory, `${runKeyHash}.json`);
  }

  async begin(
    runKey: string,
    requestIdentity: string,
    runId: string,
  ): Promise<{
    cached?: RunResult;
    activeElsewhere: boolean;
    runKeyHash: string;
    activeRun?: Readonly<{ runId: string; startedAt: string }>;
  }> {
    await ensurePrivateDirectory(this.runsDirectory);
    const [runKeyHash, requestFingerprint] = await Promise.all([
      this.runKeyHash(runKey),
      this.keyedDigest("request", requestIdentity),
    ]);
    const path = this.pathFor(runKeyHash);
    const record: StoredRun = Object.freeze({
      status: "active",
      runId,
      runKeyHash,
      requestFingerprint,
      startedAt: new Date().toISOString(),
      pid: process.pid,
      phase: "reserved",
    });
    try {
      await publishPrivateFileNoReplace(
        path,
        this.runsDirectory,
        JSON.stringify(record),
      );
      return { activeElsewhere: false, runKeyHash };
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readPrivateJson<StoredRun>(path);
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error(
          "idempotency key was already used for a different request",
        );
      }
      if (existing.status === "complete")
        return { cached: existing.result, activeElsewhere: false, runKeyHash };
      return {
        activeElsewhere: true,
        runKeyHash,
        activeRun: Object.freeze({
          runId: existing.runId,
          startedAt: existing.startedAt,
        }),
      };
    }
  }

  async markPhase(
    runKeyHash: string,
    runId: string,
    phase: RunPhase,
    operation?: RunOperationDescriptor,
  ): Promise<void> {
    await ensurePrivateDirectory(this.runsDirectory);
    const path = this.pathFor(runKeyHash);
    const existing = await readPrivateJson<StoredRun>(path);
    if (existing.status !== "active" || existing.runId !== runId) {
      throw new Error(
        "cannot update a run record that is not owned by this execution",
      );
    }
    await atomicWriteJson(path, this.runsDirectory, {
      ...existing,
      phase,
      ...(operation ? { operation } : {}),
    } satisfies StoredRun);
  }

  async complete(result: RunResult): Promise<void> {
    await ensurePrivateDirectory(this.runsDirectory);
    const path = this.pathFor(result.runKeyHash);
    const existing = await readPrivateJson<StoredRun>(path);
    if (existing.status === "complete") {
      if (existing.result.runId === result.runId) return;
      throw new Error(
        "run record is already complete under a different execution",
      );
    }
    if (existing.runId !== result.runId)
      throw new Error("run completion does not own its reservation");
    await atomicWriteJson(path, this.runsDirectory, {
      status: "complete",
      requestFingerprint: existing.requestFingerprint,
      lastPhase: existing.phase,
      result,
    } satisfies StoredRun);
  }

  async get(runKey: string): Promise<StoredRun | undefined> {
    await ensurePrivateDirectory(this.runsDirectory);
    const path = this.pathFor(await this.runKeyHash(runKey));
    try {
      return await readPrivateJson<StoredRun>(path);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async auditExisting(): Promise<
    Readonly<{
      totalRecords: number;
      activeRecords: number;
      completeRecords: number;
      malformedRecords: number;
    }>
  > {
    try {
      await assertPrivateDirectory(this.runsDirectory);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) {
        return Object.freeze({
          totalRecords: 0,
          activeRecords: 0,
          completeRecords: 0,
          malformedRecords: 0,
        });
      }
      throw error;
    }

    let totalRecords = 0;
    let activeRecords = 0;
    let completeRecords = 0;
    let malformedRecords = 0;
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      totalRecords += 1;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        malformedRecords += 1;
        continue;
      }
      let value: unknown;
      try {
        value = await readPrivateJson<unknown>(
          join(this.runsDirectory, entry.name),
        );
      } catch {
        malformedRecords += 1;
        continue;
      }
      if (liveExecutionBlockReason(value) === "malformed_run_record") {
        malformedRecords += 1;
        continue;
      }
      const record = value as Record<string, unknown>;
      if (record.status === "active") activeRecords += 1;
      else if (record.status === "complete") completeRecords += 1;
      else malformedRecords += 1;
    }
    return Object.freeze({
      totalRecords,
      activeRecords,
      completeRecords,
      malformedRecords,
    });
  }

  async liveExecutionStatus(): Promise<
    Readonly<{
      blocked: boolean;
      blockerCount: number;
      reasons: readonly string[];
    }>
  > {
    await ensurePrivateDirectory(this.runsDirectory);
    const reasons: string[] = [];
    let blockerCount = 0;
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        blockerCount += 1;
        reasons.push("unsafe_run_record");
        continue;
      }
      let value: unknown;
      let runRecordSha256: string;
      try {
        const { data } = await readPrivateFile(
          join(this.runsDirectory, entry.name),
          1_048_576,
        );
        runRecordSha256 = createHash("sha256").update(data).digest("hex");
        value = JSON.parse(data.toString("utf8")) as unknown;
      } catch {
        blockerCount += 1;
        reasons.push("unreadable_run_record");
        continue;
      }
      const reason = liveExecutionBlockReason(value);
      const runId = storedRunId(value);
      if (
        reason &&
        (!reasonMayBeAcknowledged(reason) ||
          !runId ||
          !(await this.hasReconciliationAcknowledgement(
            runId,
            runRecordSha256,
            reason,
          )))
      ) {
        blockerCount += 1;
        reasons.push(reason);
      }
    }
    return Object.freeze({
      blocked: blockerCount > 0,
      blockerCount,
      reasons: Object.freeze([...new Set(reasons)]),
    });
  }

  async assertSafeForLiveExecution(): Promise<void> {
    const status = await this.liveExecutionStatus();
    if (status.blocked) {
      throw new Error(
        "live browser execution is blocked by an unresolved durable run record",
      );
    }
  }

  async acknowledgeReconciliation(
    runId: string,
    options: Readonly<{ barrierOwnerConfirmed?: boolean }> = {},
  ): Promise<ReconciliationAcknowledgement> {
    if (!isNonemptyString(runId)) throw new Error("run ID cannot be empty");
    await ensurePrivateDirectory(this.runsDirectory);
    const matches: Array<{ value: unknown; sha256: string }> = [];
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      try {
        const { data } = await readPrivateFile(
          join(this.runsDirectory, entry.name),
          1_048_576,
        );
        const value = JSON.parse(data.toString("utf8")) as unknown;
        if (storedRunId(value) === runId) {
          matches.push({
            value,
            sha256: createHash("sha256").update(data).digest("hex"),
          });
        }
      } catch {
        // A malformed record is not eligible for acknowledgement. The normal
        // scanner continues to fail closed on it.
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        "the exact run ID did not identify one durable run record",
      );
    }
    const match = matches[0]!;
    const reason = reconciliationReasonForRecovery(
      match.value,
      options.barrierOwnerConfirmed === true,
    );
    if (!reason) {
      throw new Error("the identified run does not require reconciliation");
    }
    const acknowledgement: ReconciliationAcknowledgement = Object.freeze({
      schema: "jev-cua.reconciliation-acknowledgement.v1",
      runId,
      runRecordSha256: match.sha256,
      reason,
      acknowledgedAt: new Date().toISOString(),
    });
    await ensurePrivateDirectory(this.reconciliationsDirectory);
    await atomicWriteJson(
      this.reconciliationPath(runId),
      this.reconciliationsDirectory,
      acknowledgement,
    );
    return acknowledgement;
  }

  private reconciliationPath(runId: string): string {
    const digest = createHash("sha256").update(runId, "utf8").digest("hex");
    return join(this.reconciliationsDirectory, `${digest}.json`);
  }

  private async hasReconciliationAcknowledgement(
    runId: string,
    runRecordSha256: string,
    reason: string,
  ): Promise<boolean> {
    try {
      const acknowledgement = await readPrivateJson<
        Partial<ReconciliationAcknowledgement>
      >(this.reconciliationPath(runId), 16_384);
      return (
        acknowledgement.schema ===
          "jev-cua.reconciliation-acknowledgement.v1" &&
        acknowledgement.runId === runId &&
        acknowledgement.runRecordSha256 === runRecordSha256 &&
        acknowledgement.reason === reason &&
        typeof acknowledgement.acknowledgedAt === "string"
      );
    } catch {
      return false;
    }
  }
}

function storedRunId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.status === "active") {
    return isNonemptyString(record.runId) ? record.runId : undefined;
  }
  if (
    record.status !== "complete" ||
    !record.result ||
    typeof record.result !== "object" ||
    Array.isArray(record.result)
  ) {
    return;
  }
  const runId = (record.result as Record<string, unknown>).runId;
  return isNonemptyString(runId) ? runId : undefined;
}

function reasonMayBeAcknowledged(reason: string): boolean {
  return (
    reason === "interrupted_live_run" ||
    reason === "cleanup_unconfirmed" ||
    reason === "workflow_reconciliation_required"
  );
}

function reconciliationReasonForRecovery(
  value: unknown,
  barrierOwnerConfirmed: boolean,
): ReconciliationAcknowledgement["reason"] | undefined {
  const reason = liveExecutionBlockReason(value);
  if (reason && reasonMayBeAcknowledged(reason)) {
    return reason as ReconciliationAcknowledgement["reason"];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    barrierOwnerConfirmed &&
    ((record.status === "active" && record.phase === "reserved") ||
      (record.status === "complete" && record.lastPhase === "reserved"))
  ) {
    return "barrier_owned_reserved";
  }
  return;
}

function liveExecutionBlockReason(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "malformed_run_record";
  }
  const record = value as Record<string, unknown>;
  if (record.status === "active") {
    if (
      !isRunPhase(record.phase) ||
      !isNonemptyString(record.runId) ||
      !isSha256(record.runKeyHash) ||
      !isSha256(record.requestFingerprint) ||
      !isNonemptyString(record.startedAt) ||
      !Number.isSafeInteger(record.pid) ||
      Number(record.pid) <= 0
    ) {
      return "malformed_run_record";
    }
    return activeRunRequiresReconciliation(record.phase)
      ? "interrupted_live_run"
      : undefined;
  }
  if (
    record.status !== "complete" ||
    !isRunPhase(record.lastPhase) ||
    !isSha256(record.requestFingerprint)
  ) {
    return "malformed_run_record";
  }
  if (
    !record.result ||
    typeof record.result !== "object" ||
    Array.isArray(record.result)
  ) {
    return "malformed_run_record";
  }
  const result = record.result as Record<string, unknown>;
  if (
    !isNonemptyString(result.runId) ||
    !isSha256(result.runKeyHash) ||
    !isOutcome(result.outcome) ||
    typeof result.reconciliationRequired !== "boolean" ||
    (result.cleanupSucceeded !== null &&
      typeof result.cleanupSucceeded !== "boolean")
  ) {
    return "malformed_run_record";
  }
  // A reservation alone cannot have launched a browser or dispatched input.
  // Preflight refusals may conservatively report reconciliationRequired, but
  // they must not poison later live work after the real blocker is resolved.
  if (record.lastPhase === "reserved") return undefined;
  if (result.cleanupSucceeded === false) return "cleanup_unconfirmed";
  if (result.cleanupSucceeded !== true) {
    return "cleanup_unconfirmed";
  }
  if (result.reconciliationRequired === true) {
    return "workflow_reconciliation_required";
  }
  if (record.lastPhase === "action_started") {
    return "workflow_reconciliation_required";
  }
  if (record.lastPhase === "action_returned" && result.outcome !== "verified") {
    return "workflow_reconciliation_required";
  }
  return undefined;
}

function isRunPhase(value: unknown): value is RunPhase {
  return (
    value === "reserved" ||
    value === "browser_setup_started" ||
    value === "browser_setup_returned" ||
    value === "action_started" ||
    value === "action_returned"
  );
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isOutcome(value: unknown): boolean {
  return [
    "verified",
    "refuted",
    "unknown",
    "abstained",
    "approval_required",
    "denied",
    "budget_exhausted",
    "setup_required",
    "shadow_complete",
  ].includes(String(value));
}

export class JsonlTraceSink implements TraceSink {
  private readonly traceDirectory: string;

  constructor(stateDirectory: string) {
    this.traceDirectory = join(stateDirectory, "traces");
  }

  async append(
    runId: string,
    event: Readonly<Record<string, JsonValue>>,
  ): Promise<void> {
    await ensurePrivateDirectory(this.traceDirectory);
    const path = join(this.traceDirectory, `${runId}.jsonl`);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      assertPrivateFile(path, await handle.stat());
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function pathIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
