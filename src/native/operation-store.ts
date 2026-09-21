import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NativeExecutionOutcome } from "./types.js";

type OperationRecord =
  | Readonly<{
      schema: "jev-cua.native-operation.v1";
      status: "active";
      operationId: string;
      runId: string;
      requestFingerprint: string;
      reconciledAt?: string;
    }>
  | Readonly<{
      schema: "jev-cua.native-operation.v1";
      status: "complete";
      operationId: string;
      runId: string;
      requestFingerprint: string;
      outcome: NativeExecutionOutcome;
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
    if (!metadata.isDirectory())
      throw new Error("native state is not a directory");
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    )
      throw new Error("native state is not owned by the current user");
    if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
      throw new Error("native state directory must have mode 0700");
  } finally {
    await handle.close();
  }
}

async function readPrivateFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("native state is not a regular file");
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    )
      throw new Error("native state is not owned by the current user");
    if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)
      throw new Error("native state file must have mode 0600");
    if (metadata.size > maximumBytes)
      throw new Error("native state exceeds its size limit");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function publishNoReplace(
  path: string,
  data: Buffer | string,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
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

async function replaceAtomically(
  directory: string,
  path: string,
  data: string,
): Promise<void> {
  const temporary = join(
    directory,
    `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  await publishNoReplace(temporary, data);
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function parseRecord(value: Buffer): OperationRecord {
  const parsed = JSON.parse(value.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("native operation record is malformed");
  }
  const record = parsed as Partial<OperationRecord>;
  const hasReconciledAt = Object.prototype.hasOwnProperty.call(
    record,
    "reconciledAt",
  );
  if (
    record.schema !== "jev-cua.native-operation.v1" ||
    (record.status !== "active" && record.status !== "complete") ||
    !/^[a-f0-9]{32}$/u.test(String(record.operationId)) ||
    typeof record.runId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(record.runId) ||
    (hasReconciledAt &&
      (record.status !== "active" ||
        !isCanonicalTimestamp(
          (record as { reconciledAt?: unknown }).reconciledAt,
        ))) ||
    !/^[a-f0-9]{64}$/u.test(String(record.requestFingerprint))
  ) {
    throw new Error("native operation record is malformed");
  }
  if (
    record.status === "complete" &&
    !["verified", "refuted", "unknown", "approval_required", "denied"].includes(
      String(record.outcome),
    )
  ) {
    throw new Error("native operation result is malformed");
  }
  return record as OperationRecord;
}

/**
 * A content-free durable at-most-once ledger. Only keyed digests, opaque IDs,
 * and outcome classes are persisted; action arguments and UI text never are.
 */
export class NativeOperationStore {
  private readonly operationsDirectory: string;
  private readonly identityKeyPath: string;
  private identityKeyPromise: Promise<Buffer> | undefined;

  constructor(private readonly stateDirectory: string) {
    this.operationsDirectory = join(stateDirectory, "native-operations");
    this.identityKeyPath = join(stateDirectory, "native-identity.key");
  }

  private async identityKey(): Promise<Buffer> {
    if (!this.identityKeyPromise)
      this.identityKeyPromise = this.loadIdentityKey();
    try {
      return await this.identityKeyPromise;
    } catch (error: unknown) {
      this.identityKeyPromise = undefined;
      throw error;
    }
  }

  private async loadIdentityKey(): Promise<Buffer> {
    await ensurePrivateDirectory(this.stateDirectory);
    try {
      await publishNoReplace(this.identityKeyPath, randomBytes(32));
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const key = await readPrivateFile(this.identityKeyPath, 32);
    if (key.length !== 32) throw new Error("native identity key is malformed");
    return key;
  }

  private async digest(
    domain: "operation" | "request",
    value: string,
  ): Promise<string> {
    return createHmac("sha256", await this.identityKey())
      .update(`jev-cua:native:v1:${domain}\0`, "utf8")
      .update(value, "utf8")
      .digest("hex");
  }

  async reserve(
    operationKey: string,
    requestIdentity: string,
    runId: string,
  ): Promise<
    | Readonly<{ status: "reserved"; operationId: string }>
    | Readonly<{ status: "active" }>
    | Readonly<{ status: "complete"; outcome: NativeExecutionOutcome }>
  > {
    if (!operationKey.trim() || operationKey.length > 512)
      throw new Error("native operation key is invalid");
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(runId))
      throw new Error("native run ID is invalid");
    await ensurePrivateDirectory(this.operationsDirectory);
    const [operationHash, requestFingerprint] = await Promise.all([
      this.digest("operation", operationKey),
      this.digest("request", requestIdentity),
    ]);
    const path = join(this.operationsDirectory, `${operationHash}.json`);
    const operationId = randomBytes(16).toString("hex");
    const record: OperationRecord = Object.freeze({
      schema: "jev-cua.native-operation.v1",
      status: "active",
      operationId,
      runId,
      requestFingerprint,
    });
    try {
      await publishNoReplace(path, JSON.stringify(record));
      return Object.freeze({ status: "reserved", operationId });
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = parseRecord(await readPrivateFile(path, 16_384));
      if (existing.requestFingerprint !== requestFingerprint)
        throw new Error("native operation key was used for another request");
      return existing.status === "active"
        ? Object.freeze({ status: "active" as const })
        : Object.freeze({
            status: "complete" as const,
            outcome: existing.outcome,
          });
    }
  }

  async lookup(
    operationKey: string,
    requestIdentity: string,
  ): Promise<
    | Readonly<{ status: "missing" }>
    | Readonly<{ status: "active" }>
    | Readonly<{ status: "complete"; outcome: NativeExecutionOutcome }>
  > {
    if (!operationKey.trim() || operationKey.length > 512)
      throw new Error("native operation key is invalid");
    await ensurePrivateDirectory(this.operationsDirectory);
    const [operationHash, requestFingerprint] = await Promise.all([
      this.digest("operation", operationKey),
      this.digest("request", requestIdentity),
    ]);
    let existing: OperationRecord;
    try {
      existing = parseRecord(
        await readPrivateFile(
          join(this.operationsDirectory, `${operationHash}.json`),
          16_384,
        ),
      );
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT"))
        return Object.freeze({ status: "missing" as const });
      throw error;
    }
    if (existing.requestFingerprint !== requestFingerprint)
      throw new Error("native operation key was used for another request");
    return existing.status === "active"
      ? Object.freeze({ status: "active" as const })
      : Object.freeze({
          status: "complete" as const,
          outcome: existing.outcome,
        });
  }

  async executionStatus(): Promise<
    Readonly<{
      blocked: boolean;
      blockerCount: number;
      reasons: readonly string[];
    }>
  > {
    await ensurePrivateDirectory(this.operationsDirectory);
    const entries = await readdir(this.operationsDirectory, {
      withFileTypes: true,
    });
    let blockerCount = 0;
    const reasons: string[] = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        blockerCount += 1;
        reasons.push("unsafe_native_operation_record");
        continue;
      }
      let record: OperationRecord;
      try {
        record = parseRecord(
          await readPrivateFile(
            join(this.operationsDirectory, entry.name),
            16_384,
          ),
        );
      } catch {
        blockerCount += 1;
        reasons.push("unreadable_native_operation_record");
        continue;
      }
      if (record.status === "active" && !record.reconciledAt) {
        blockerCount += 1;
        reasons.push("unresolved_native_operation");
      }
    }
    return Object.freeze({
      blocked: blockerCount > 0,
      blockerCount,
      reasons: Object.freeze([...new Set(reasons)]),
    });
  }

  async assertSafeForExecution(): Promise<void> {
    if ((await this.executionStatus()).blocked) {
      throw new Error(
        "native execution is blocked by unresolved operation state",
      );
    }
  }

  async acknowledgeReconciliation(runId: string): Promise<number> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(runId))
      throw new Error("native run ID is invalid");
    await ensurePrivateDirectory(this.operationsDirectory);
    const entries = await readdir(this.operationsDirectory, {
      withFileTypes: true,
    });
    let acknowledged = 0;
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const path = join(this.operationsDirectory, entry.name);
      let record: OperationRecord;
      try {
        record = parseRecord(await readPrivateFile(path, 16_384));
      } catch {
        continue;
      }
      if (
        record.status !== "active" ||
        record.runId !== runId ||
        record.reconciledAt
      ) {
        continue;
      }
      await replaceAtomically(
        this.operationsDirectory,
        path,
        JSON.stringify({
          ...record,
          reconciledAt: new Date().toISOString(),
        } satisfies OperationRecord),
      );
      acknowledged += 1;
    }
    return acknowledged;
  }

  async complete(
    operationKey: string,
    operationId: string,
    outcome: NativeExecutionOutcome,
  ): Promise<void> {
    await ensurePrivateDirectory(this.operationsDirectory);
    const operationHash = await this.digest("operation", operationKey);
    const path = join(this.operationsDirectory, `${operationHash}.json`);
    const existing = parseRecord(await readPrivateFile(path, 16_384));
    if (existing.operationId !== operationId)
      throw new Error("native operation reservation is not owned by this run");
    if (existing.status === "complete") {
      if (existing.outcome === outcome) return;
      throw new Error("native operation already has another outcome");
    }
    if (existing.reconciledAt) {
      throw new Error("reconciled native operation cannot be completed");
    }
    await replaceAtomically(
      this.operationsDirectory,
      path,
      JSON.stringify({ ...existing, status: "complete", outcome }),
    );
  }
}
