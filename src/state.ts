import { createHmac, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
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
  } catch {
    // Some platforms do not permit fsync on directories. File fsync and atomic
    // rename still preserve the strongest contract available there.
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
          released = true;
          try {
            const current = await readPrivateJson<Partial<LockRecord>>(
              this.lockPath,
              16_384,
            );
            if (current.pid === record.pid && current.runId === record.runId) {
              await unlink(this.lockPath);
            }
          } catch (error: unknown) {
            if (!isErrno(error, "ENOENT")) throw error;
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

export type RunPhase =
  | "reserved"
  | "browser_setup_started"
  | "browser_setup_returned"
  | "action_started"
  | "action_returned";

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

export class RunStore {
  private readonly runsDirectory: string;
  private readonly identityKeyPath: string;
  private identityKeyPromise: Promise<Buffer> | undefined;

  constructor(stateDirectory: string) {
    this.runsDirectory = join(stateDirectory, "runs");
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
      const handle = await open(this.identityKeyPath, "wx", 0o600);
      try {
        const key = randomBytes(32);
        await handle.writeFile(key);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(stateDirectory);
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
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.runsDirectory);
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
