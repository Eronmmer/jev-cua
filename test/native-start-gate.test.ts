import assert from "node:assert/strict";
import test from "node:test";

import { classifyNativeStartSafety } from "../src/native/start-gate.js";

const clearInput = Object.freeze({
  barrier: Object.freeze({ blocked: false }),
  lease: Object.freeze({ busy: false }),
  durableRunsBlocked: false,
  nativeOperationsBlocked: false,
});

test("native start treats only a matched live active owner as busy", () => {
  assert.equal(
    classifyNativeStartSafety({
      ...clearInput,
      barrier: { blocked: true, state: "active", runId: "run-one" },
      lease: { busy: true, runId: "run-one" },
    }),
    "busy",
  );
  for (const lease of [
    { busy: false },
    { busy: true },
    { busy: true, runId: "run-two" },
  ]) {
    assert.equal(
      classifyNativeStartSafety({
        ...clearInput,
        barrier: { blocked: true, state: "active", runId: "run-one" },
        lease,
      }),
      "reconciliation_required",
    );
  }
});

test("native start fails closed on quarantines and distinguishes a lease-only owner", () => {
  assert.equal(classifyNativeStartSafety(clearInput), "clear");
  assert.equal(
    classifyNativeStartSafety({
      ...clearInput,
      lease: { busy: true, runId: "other-controller" },
    }),
    "busy",
  );
  assert.equal(
    classifyNativeStartSafety({
      ...clearInput,
      barrier: {
        blocked: true,
        state: "cleanup_unconfirmed",
        runId: "run-one",
      },
      lease: { busy: true, runId: "run-one" },
    }),
    "reconciliation_required",
  );
  assert.equal(
    classifyNativeStartSafety({
      ...clearInput,
      durableRunsBlocked: true,
    }),
    "reconciliation_required",
  );
  assert.equal(
    classifyNativeStartSafety({
      ...clearInput,
      nativeOperationsBlocked: true,
    }),
    "reconciliation_required",
  );
});
