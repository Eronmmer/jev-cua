import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  DesktopLease,
  JsonlTraceSink,
  LiveExecutionBarrier,
  RunStore,
  activeRunRequiresReconciliation,
} from "../src/state.js";
import type { RunResult } from "../src/types.js";

test("every active phase after reservation requires reconciliation", () => {
  assert.equal(activeRunRequiresReconciliation("reserved"), false);
  for (const phase of [
    "browser_setup_started",
    "browser_setup_returned",
    "action_started",
    "action_returned",
  ] as const) {
    assert.equal(activeRunRequiresReconciliation(phase), true);
  }
});

async function stateDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-state-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("desktop lease is exclusive, reports its owner, and releases idempotently", async (t) => {
  const directory = await stateDirectory(t);
  const first = new DesktopLease(directory);
  const second = new DesktopLease(directory);
  const release = await first.acquire("run-one");

  assert.deepEqual(await first.status(), {
    busy: true,
    ownerPid: process.pid,
    runId: "run-one",
  });
  await assert.rejects(
    second.acquire("run-two"),
    /desktop controller is busy with run run-one/,
  );

  await release();
  await release();
  assert.deepEqual(await first.status(), { busy: false });

  const releaseSecond = await second.acquire("run-two");
  assert.equal((await second.status()).runId, "run-two");
  await releaseSecond();
});

test("live execution barrier is durable, owner-bound, and fail-closed", async (t) => {
  const directory = await stateDirectory(t);
  const barrier = new LiveExecutionBarrier(directory);

  assert.deepEqual(await barrier.status(), { blocked: false });
  await barrier.markActive("run-one", "session-one");
  assert.deepEqual(await barrier.status(), {
    blocked: true,
    runId: "run-one",
    session: "session-one",
    state: "active",
    markedAt: (await barrier.status()).markedAt,
    updatedAt: (await barrier.status()).updatedAt,
  });
  await assert.rejects(barrier.assertClear(), /unresolved prior execution/u);
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(join(directory, "live-execution-blocked.json"))).mode & 0o777,
      0o600,
    );
  }

  await barrier.retain("run-one", "session-one", "reconciliation_required");
  assert.equal((await barrier.status()).state, "reconciliation_required");
  await assert.rejects(barrier.clear("other-run", "session-one"), /not owned/u);
  await barrier.clear("run-one", "session-one");
  assert.deepEqual(await barrier.status(), { blocked: false });

  await writeFile(join(directory, "live-execution-blocked.json"), "{bad", {
    mode: 0o600,
  });
  assert.deepEqual(await barrier.status(), { blocked: true });
});

test("live execution barrier refuses a symlink record", async (t) => {
  if (process.platform === "win32") return;
  const directory = await stateDirectory(t);
  const target = join(directory, "attacker-barrier");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, join(directory, "live-execution-blocked.json"));

  const barrier = new LiveExecutionBarrier(directory);
  assert.deepEqual(await barrier.status(), { blocked: true });
  await assert.rejects(barrier.markActive("run", "session"));
  assert.equal(await readFile(target, "utf8"), "{}");
});

test("resolved execution barriers are archived without being deleted", async (t) => {
  const directory = await stateDirectory(t);
  const barrier = new LiveExecutionBarrier(directory);
  await barrier.markActive("run-one", "session-one");
  await barrier.retain("run-one", "session-one", "reconciliation_required");

  const archive = await barrier.archiveResolved("run-one", "session-one");

  assert.deepEqual(await barrier.status(), { blocked: false });
  assert.match(archive, /reconciled-execution-barriers/u);
  assert.match(await readFile(archive, "utf8"), /reconciliation_required/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(archive)).mode & 0o777, 0o600);
  }
});

test("desktop lease preserves and replaces a stale lock", async (t) => {
  const directory = await stateDirectory(t);
  const lockPath = join(directory, "desktop.lock");
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: 2_147_483_647,
      runId: "crashed-run",
      acquiredAt: "2020-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );

  const lease = new DesktopLease(directory);
  const release = await lease.acquire("recovery-run");

  const names = await readdir(directory);
  const staleName = names.find((name) =>
    name.startsWith("desktop.lock.stale."),
  );
  assert.ok(staleName, "the stale lock should be preserved for diagnosis");
  assert.match(
    await readFile(join(directory, staleName), "utf8"),
    /crashed-run/,
  );
  assert.equal((await lease.status()).runId, "recovery-run");
  await release();
});

test("malformed lock data is treated as stale rather than silently overwritten", async (t) => {
  const directory = await stateDirectory(t);
  await writeFile(join(directory, "desktop.lock"), "{not-json", {
    mode: 0o600,
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(join(directory, "desktop.lock"), old, old);

  const lease = new DesktopLease(directory);
  const release = await lease.acquire("replacement-run");

  const names = await readdir(directory);
  const staleName = names.find((name) =>
    name.startsWith("desktop.lock.stale."),
  );
  assert.ok(staleName);
  assert.equal(await readFile(join(directory, staleName), "utf8"), "{not-json");
  await release();
});

test("a fresh malformed lock is treated as busy during the recovery grace window", async (t) => {
  const directory = await stateDirectory(t);
  await writeFile(join(directory, "desktop.lock"), "", { mode: 0o600 });

  const lease = new DesktopLease(directory);
  await assert.rejects(
    lease.acquire("racing-run"),
    /owner metadata is still being written/,
  );
  assert.deepEqual(await readdir(directory), ["desktop.lock"]);
});

test("run store atomically reserves keys and serves completed results", async (t) => {
  const directory = await stateDirectory(t);
  const firstStore = new RunStore(directory);
  const secondStore = new RunStore(directory);
  const requestIdentity = '{"goal":"fixture"}';
  const begun = await firstStore.begin(
    "customer-visible-key",
    requestIdentity,
    "run-one",
  );

  assert.equal(begun.activeElsewhere, false);
  assert.equal(begun.cached, undefined);
  assert.equal(
    begun.runKeyHash,
    await firstStore.runKeyHash("customer-visible-key"),
  );
  assert.ok(!begun.runKeyHash.includes("customer-visible-key"));

  const duplicateActive = await secondStore.begin(
    "customer-visible-key",
    requestIdentity,
    "run-two",
  );
  assert.equal(duplicateActive.activeElsewhere, true);
  assert.equal(duplicateActive.cached, undefined);
  assert.deepEqual(duplicateActive.activeRun, {
    runId: "run-one",
    startedAt: (
      (await firstStore.get("customer-visible-key")) as { startedAt: string }
    ).startedAt,
  });

  const result: RunResult = {
    runId: "run-one",
    runKeyHash: begun.runKeyHash,
    outcome: "verified",
    reason: "fixture verified",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    frontierFallbackRecommended: false,
    reconciliationRequired: false,
    safeToRetry: false,
    cleanupSucceeded: null,
  };
  await firstStore.complete(result);

  const duplicateComplete = await secondStore.begin(
    "customer-visible-key",
    requestIdentity,
    "run-three",
  );
  assert.equal(duplicateComplete.activeElsewhere, false);
  assert.deepEqual(duplicateComplete.cached, result);
  const stored = await secondStore.get("customer-visible-key");
  assert.equal(stored?.status, "complete");
  if (stored?.status !== "complete") assert.fail("expected completed run");
  assert.equal(stored.lastPhase, "reserved");
  assert.match(stored.requestFingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(stored.result, result);

  const runsDirectory = join(directory, "runs");
  if (process.platform !== "win32") {
    assert.equal((await stat(runsDirectory)).mode & 0o777, 0o700);
    const records = await readdir(runsDirectory);
    assert.equal(records.length, 1);
    assert.equal(
      (await stat(join(runsDirectory, records[0]!))).mode & 0o777,
      0o600,
    );
  }
});

test("run store audit is read-only and distinguishes active, complete, and malformed records", async (t) => {
  const absentDirectory = await stateDirectory(t);
  assert.deepEqual(await new RunStore(absentDirectory).auditExisting(), {
    totalRecords: 0,
    activeRecords: 0,
    completeRecords: 0,
    malformedRecords: 0,
  });

  const directory = await stateDirectory(t);
  const store = new RunStore(directory);
  const complete = await store.begin("complete-key", "request", "complete-run");
  await store.complete({
    runId: "complete-run",
    runKeyHash: complete.runKeyHash,
    outcome: "unknown",
    reason: "preflight refusal",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    frontierFallbackRecommended: false,
    reconciliationRequired: false,
    safeToRetry: false,
    cleanupSucceeded: null,
  });
  await store.begin("active-key", "request", "active-run");
  await writeFile(join(directory, "runs", `${"f".repeat(64)}.json`), "{}", {
    mode: 0o600,
  });

  assert.deepEqual(await store.auditExisting(), {
    totalRecords: 3,
    activeRecords: 1,
    completeRecords: 1,
    malformedRecords: 1,
  });
});

test("durable live-run scan ignores reserved refusals and blocks interrupted work", async (t) => {
  const safeDirectory = await stateDirectory(t);
  const safeStore = new RunStore(safeDirectory);
  const safe = await safeStore.begin("reserved-key", "request", "safe-run");
  await safeStore.complete({
    runId: "safe-run",
    runKeyHash: safe.runKeyHash,
    outcome: "unknown",
    reason: "preflight refusal",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    frontierFallbackRecommended: false,
    reconciliationRequired: true,
    safeToRetry: false,
    cleanupSucceeded: null,
  });
  assert.deepEqual(await safeStore.liveExecutionStatus(), {
    blocked: false,
    blockerCount: 0,
    reasons: [],
  });

  const activeDirectory = await stateDirectory(t);
  const activeStore = new RunStore(activeDirectory);
  const active = await activeStore.begin(
    "interrupted-key",
    "request",
    "active-run",
  );
  await activeStore.markPhase(
    active.runKeyHash,
    "active-run",
    "browser_setup_started",
  );
  assert.deepEqual(await activeStore.liveExecutionStatus(), {
    blocked: true,
    blockerCount: 1,
    reasons: ["interrupted_live_run"],
  });
  await assert.rejects(
    activeStore.assertSafeForLiveExecution(),
    /unresolved durable run/u,
  );
});

test("durable live-run scan rejects malformed completed action records", async (t) => {
  const directory = await stateDirectory(t);
  const store = new RunStore(directory);
  const begun = await store.begin("malformed-key", "request", "run-one");
  await store.markPhase(begun.runKeyHash, "run-one", "action_returned");
  const recordPath = join(directory, "runs", `${begun.runKeyHash}.json`);
  const active = JSON.parse(await readFile(recordPath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    recordPath,
    JSON.stringify({
      status: "complete",
      requestFingerprint: active.requestFingerprint,
      lastPhase: "action_returned",
      result: {
        runId: "run-one",
        runKeyHash: begun.runKeyHash,
        outcome: "verified",
        cleanupSucceeded: true,
      },
    }),
    { mode: 0o600 },
  );

  assert.deepEqual(await store.liveExecutionStatus(), {
    blocked: true,
    blockerCount: 1,
    reasons: ["malformed_run_record"],
  });
});

test("a hash-bound reconciliation acknowledgement preserves at-most-once state", async (t) => {
  const directory = await stateDirectory(t);
  const store = new RunStore(directory);
  const requestIdentity = '{"goal":"reconcile"}';
  const begun = await store.begin(
    "uncertain-run-key",
    requestIdentity,
    "uncertain-run",
  );
  await store.markPhase(begun.runKeyHash, "uncertain-run", "action_returned");
  const result: RunResult = {
    runId: "uncertain-run",
    runKeyHash: begun.runKeyHash,
    outcome: "unknown",
    reason: "postcondition was not proven",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    frontierFallbackRecommended: false,
    reconciliationRequired: true,
    safeToRetry: false,
    cleanupSucceeded: true,
  };
  await store.complete(result);
  assert.equal((await store.liveExecutionStatus()).blocked, true);

  const acknowledgement =
    await store.acknowledgeReconciliation("uncertain-run");

  assert.match(acknowledgement.runRecordSha256, /^[a-f0-9]{64}$/u);
  assert.equal((await store.liveExecutionStatus()).blocked, false);
  const duplicate = await store.begin(
    "uncertain-run-key",
    requestIdentity,
    "must-not-run",
  );
  assert.deepEqual(duplicate.cached, result);

  const recordPath = join(directory, "runs", `${begun.runKeyHash}.json`);
  await writeFile(recordPath, `${await readFile(recordPath, "utf8")} `, {
    mode: 0o600,
  });
  assert.deepEqual(await store.liveExecutionStatus(), {
    blocked: true,
    blockerCount: 1,
    reasons: ["workflow_reconciliation_required"],
  });
});

test("a barrier-owned reserved crash can be acknowledged without releasing its run key", async (t) => {
  const directory = await stateDirectory(t);
  const store = new RunStore(directory);
  const begun = await store.begin(
    "reserved-crash-key",
    "request",
    "reserved-crash-run",
  );
  assert.equal((await store.liveExecutionStatus()).blocked, false);

  await assert.rejects(
    store.acknowledgeReconciliation("reserved-crash-run"),
    /does not require reconciliation/u,
  );
  const acknowledgement = await store.acknowledgeReconciliation(
    "reserved-crash-run",
    { barrierOwnerConfirmed: true },
  );

  assert.equal(acknowledgement.reason, "barrier_owned_reserved");
  const duplicate = await store.begin(
    "reserved-crash-key",
    "request",
    "must-not-run",
  );
  assert.equal(duplicate.activeElsewhere, true);
  assert.equal(duplicate.activeRun?.runId, "reserved-crash-run");
  assert.equal(duplicate.runKeyHash, begun.runKeyHash);
});

test("a barrier-owned completed reservation can be acknowledged only with an owner match", async (t) => {
  const directory = await stateDirectory(t);
  const store = new RunStore(directory);
  const begun = await store.begin(
    "completed-reserved-key",
    "request",
    "completed-reserved-run",
  );
  await store.complete({
    runId: "completed-reserved-run",
    runKeyHash: begun.runKeyHash,
    outcome: "unknown",
    reason: "cleanup finalization failed before browser setup",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    frontierFallbackRecommended: false,
    reconciliationRequired: true,
    safeToRetry: false,
    cleanupSucceeded: null,
  });

  assert.equal((await store.liveExecutionStatus()).blocked, false);
  await assert.rejects(
    store.acknowledgeReconciliation("completed-reserved-run"),
    /does not require reconciliation/u,
  );
  const acknowledgement = await store.acknowledgeReconciliation(
    "completed-reserved-run",
    { barrierOwnerConfirmed: true },
  );
  assert.equal(acknowledgement.reason, "barrier_owned_reserved");
});

test("a completed action-started record always requires reconciliation", async (t) => {
  const directory = await stateDirectory(t);
  const store = new RunStore(directory);
  const begun = await store.begin(
    "action-started-key",
    "request",
    "action-started-run",
  );
  await store.markPhase(
    begun.runKeyHash,
    "action-started-run",
    "action_started",
  );
  await store.complete({
    runId: "action-started-run",
    runKeyHash: begun.runKeyHash,
    outcome: "verified",
    reason: "impossible verified result",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    frontierFallbackRecommended: false,
    reconciliationRequired: false,
    safeToRetry: false,
    cleanupSucceeded: true,
  });

  assert.deepEqual(await store.liveExecutionStatus(), {
    blocked: true,
    blockerCount: 1,
    reasons: ["workflow_reconciliation_required"],
  });
});

test("lease release does not remove a lock that has been replaced by another owner", async (t) => {
  const directory = await stateDirectory(t);
  const lease = new DesktopLease(directory);
  const release = await lease.acquire("original-run");
  const lockPath = join(directory, "desktop.lock");
  await chmod(lockPath, 0o600);
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      runId: "replacement-run",
      acquiredAt: new Date().toISOString(),
    }),
  );

  await release();

  assert.match(await readFile(lockPath, "utf8"), /replacement-run/);
});

test("state directories with unsafe permissions are rejected", async (t) => {
  if (process.platform === "win32") return;
  const directory = await stateDirectory(t);
  await chmod(directory, 0o755);
  const lease = new DesktopLease(directory);

  await assert.rejects(lease.acquire("unsafe-state"), /must have mode 0700/u);
});

test("identity keys and run records cannot be supplied through symlinks", async (t) => {
  if (process.platform === "win32") return;
  const directory = await stateDirectory(t);
  const keyTarget = join(directory, "attacker-key");
  await writeFile(keyTarget, Buffer.alloc(32, 7), { mode: 0o600 });
  await symlink(keyTarget, join(directory, "identity.key"));

  const poisonedStore = new RunStore(directory);
  await assert.rejects(poisonedStore.runKeyHash("poisoned-key"));

  await rm(join(directory, "identity.key"));
  const store = new RunStore(directory);
  const runKey = "symlinked-run-key";
  const runKeyHash = await store.runKeyHash(runKey);
  const runsDirectory = join(directory, "runs");
  await mkdir(runsDirectory, { mode: 0o700 });
  const recordTarget = join(directory, "attacker-record");
  await writeFile(recordTarget, "{}", { mode: 0o600 });
  await symlink(recordTarget, join(runsDirectory, `${runKeyHash}.json`));

  await assert.rejects(store.begin(runKey, "request", "run-id"));
});

test("trace append refuses a symlink destination", async (t) => {
  if (process.platform === "win32") return;
  const directory = await stateDirectory(t);
  const tracesDirectory = join(directory, "traces");
  await mkdir(tracesDirectory, { mode: 0o700 });
  const target = join(directory, "attacker-trace");
  await writeFile(target, "do-not-touch\n", { mode: 0o600 });
  await symlink(target, join(tracesDirectory, "run-id.jsonl"));

  await assert.rejects(
    new JsonlTraceSink(directory).append("run-id", { event: "test" }),
  );
  assert.equal(await readFile(target, "utf8"), "do-not-touch\n");
});

test("the same idempotency key cannot cross policy fingerprints", async (t) => {
  const directory = await stateDirectory(t);
  const store = new RunStore(directory);
  await store.begin(
    "policy-bound-key",
    JSON.stringify({ policyFingerprint: "a".repeat(64) }),
    "run-one",
  );

  await assert.rejects(
    store.begin(
      "policy-bound-key",
      JSON.stringify({ policyFingerprint: "b".repeat(64) }),
      "run-two",
    ),
    /different request/u,
  );
});
