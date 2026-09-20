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

import { DesktopLease, JsonlTraceSink, RunStore } from "../src/state.js";
import type { RunResult } from "../src/types.js";

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
