import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { NativeOperationStore } from "../src/native/operation-store.js";

async function stateDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-native-store-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("native operation ledger is durable, content-free, and at-most-once", async (t) => {
  const directory = await stateDirectory(t);
  const first = new NativeOperationStore(directory);
  const reserved = await first.reserve(
    "customer-visible-operation-key",
    JSON.stringify({ secret: "must-not-be-stored", action: "click" }),
    "native-test-run",
  );
  assert.equal(reserved.status, "reserved");
  if (reserved.status !== "reserved") assert.fail("expected reservation");
  assert.deepEqual(
    await first.lookup(
      "customer-visible-operation-key",
      JSON.stringify({ secret: "must-not-be-stored", action: "click" }),
    ),
    { status: "active" },
  );

  const second = new NativeOperationStore(directory);
  assert.deepEqual(
    await second.reserve(
      "customer-visible-operation-key",
      JSON.stringify({ secret: "must-not-be-stored", action: "click" }),
      "native-test-run",
    ),
    { status: "active" },
  );
  await first.complete(
    "customer-visible-operation-key",
    reserved.operationId,
    "verified",
  );
  assert.deepEqual(
    await first.lookup(
      "customer-visible-operation-key",
      JSON.stringify({ secret: "must-not-be-stored", action: "click" }),
    ),
    { status: "complete", outcome: "verified" },
  );
  assert.deepEqual(await first.lookup("missing-key", "missing-request"), {
    status: "missing",
  });
  assert.deepEqual(
    await second.reserve(
      "customer-visible-operation-key",
      JSON.stringify({ secret: "must-not-be-stored", action: "click" }),
      "native-test-run",
    ),
    { status: "complete", outcome: "verified" },
  );
  await assert.rejects(
    second.reserve(
      "customer-visible-operation-key",
      JSON.stringify({ secret: "different", action: "click" }),
      "native-test-run",
    ),
    /another request/u,
  );

  const operationFiles = await readdir(join(directory, "native-operations"));
  assert.equal(operationFiles.length, 1);
  assert.doesNotMatch(operationFiles[0]!, /customer-visible/u);
  const recordPath = join(directory, "native-operations", operationFiles[0]!);
  const persisted = await readFile(recordPath, "utf8");
  assert.doesNotMatch(
    persisted,
    /customer-visible|must-not-be-stored|different|click/u,
  );
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(join(directory, "native-operations"))).mode & 0o777,
      0o700,
    );
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
  }
});

test("an unresolved native operation blocks a new execution", async (t) => {
  const directory = await stateDirectory(t);
  const store = new NativeOperationStore(directory);
  await store.reserve(
    "interrupted-operation",
    "request-digest-input",
    "native-interrupted-run",
  );
  await assert.rejects(store.assertSafeForExecution(), /unresolved operation/u);
  assert.equal(
    await store.acknowledgeReconciliation("native-interrupted-run"),
    1,
  );
  assert.deepEqual(await store.executionStatus(), {
    blocked: false,
    blockerCount: 0,
    reasons: [],
  });
  assert.deepEqual(
    await store.reserve(
      "interrupted-operation",
      "request-digest-input",
      "native-interrupted-run",
    ),
    { status: "active" },
  );
  await assert.rejects(
    store.complete("interrupted-operation", "not-the-owner", "verified"),
    /not owned/u,
  );
});

test("reconciliation acknowledges only active operations for the exact run", async (t) => {
  const directory = await stateDirectory(t);
  const store = new NativeOperationStore(directory);
  const first = await store.reserve(
    "first-operation",
    "first-request",
    "run-one",
  );
  const second = await store.reserve(
    "second-operation",
    "second-request",
    "run-two",
  );
  const complete = await store.reserve(
    "completed-operation",
    "completed-request",
    "run-one",
  );
  assert.equal(first.status, "reserved");
  assert.equal(second.status, "reserved");
  assert.equal(complete.status, "reserved");
  if (complete.status !== "reserved") assert.fail("expected reservation");
  await store.complete("completed-operation", complete.operationId, "verified");

  assert.equal(await store.acknowledgeReconciliation("run-one"), 1);
  assert.deepEqual(await store.executionStatus(), {
    blocked: true,
    blockerCount: 1,
    reasons: ["unresolved_native_operation"],
  });
  assert.equal(await store.acknowledgeReconciliation("run-one"), 0);
  assert.equal(await store.acknowledgeReconciliation("missing-run"), 0);
  assert.equal(await store.acknowledgeReconciliation("run-two"), 1);
  assert.deepEqual(await store.executionStatus(), {
    blocked: false,
    blockerCount: 0,
    reasons: [],
  });
});

test("a reconciled active operation can never be completed or replayed", async (t) => {
  const directory = await stateDirectory(t);
  const store = new NativeOperationStore(directory);
  const reserved = await store.reserve(
    "ambiguous-operation",
    "ambiguous-request",
    "ambiguous-run",
  );
  assert.equal(reserved.status, "reserved");
  if (reserved.status !== "reserved") assert.fail("expected reservation");

  assert.equal(await store.acknowledgeReconciliation("ambiguous-run"), 1);
  await assert.rejects(
    store.complete("ambiguous-operation", reserved.operationId, "verified"),
    /cannot be completed/u,
  );
  assert.deepEqual(
    await store.reserve(
      "ambiguous-operation",
      "ambiguous-request",
      "ambiguous-run",
    ),
    { status: "active" },
  );
});

test("malformed native operation state fails closed", async (t) => {
  const directory = await stateDirectory(t);
  const store = new NativeOperationStore(directory);
  await store.reserve("malformed-operation", "request", "malformed-run");
  const [filename] = await readdir(join(directory, "native-operations"));
  assert.ok(filename);
  const path = join(directory, "native-operations", filename);
  const record = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    path,
    JSON.stringify({ ...record, reconciledAt: "not-a-timestamp" }),
    { mode: 0o600 },
  );

  assert.deepEqual(await store.executionStatus(), {
    blocked: true,
    blockerCount: 1,
    reasons: ["unreadable_native_operation_record"],
  });
  await assert.rejects(store.assertSafeForExecution(), /unresolved operation/u);
  assert.equal(await store.acknowledgeReconciliation("malformed-run"), 0);
});
