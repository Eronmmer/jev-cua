import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimeConfig } from "../src/config.js";
import { workflowPolicyFingerprint } from "../src/policy/fingerprint.js";

const baseConfig: RuntimeConfig = {
  model: "jev-1.13.0",
  providerTimeoutMs: 1_500,
  maxCandidates: 24,
  labelMaxLength: 120,
  stateDirectory: "/state",
  workflowDirectory: "/workflows",
  logLevel: "off",
  thresholds: {
    minimumProbability: 0.9,
    minimumConfidence: 0.8,
    minimumMargin: 0.5,
    minimumFit: 0.9,
  },
};

test("durable policy fingerprints bind workflow bytes, model, gates, and policy semantics", () => {
  const first = workflowPolicyFingerprint("a".repeat(64), baseConfig);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, workflowPolicyFingerprint("a".repeat(64), baseConfig));
  assert.notEqual(first, workflowPolicyFingerprint("b".repeat(64), baseConfig));
  assert.notEqual(
    first,
    workflowPolicyFingerprint("a".repeat(64), {
      ...baseConfig,
      thresholds: { ...baseConfig.thresholds, minimumConfidence: 0.81 },
    }),
  );
  assert.notEqual(
    first,
    workflowPolicyFingerprint("a".repeat(64), {
      ...baseConfig,
      model: "jev-other",
    }),
  );
});
