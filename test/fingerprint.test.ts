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

test("Jev policy fingerprints bind workflow bytes, model, gates, and policy semantics", () => {
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

test("deterministic policy fingerprints ignore only the unrelated Jev model", () => {
  const identity = "deterministic-closed-set-v1";
  const first = workflowPolicyFingerprint("a".repeat(64), baseConfig, identity);

  assert.notEqual(workflowPolicyFingerprint("a".repeat(64), baseConfig), first);
  assert.equal(
    first,
    workflowPolicyFingerprint(
      "a".repeat(64),
      {
        ...baseConfig,
        model: "jev-other",
      },
      identity,
    ),
  );
  assert.notEqual(
    first,
    workflowPolicyFingerprint(
      "a".repeat(64),
      {
        ...baseConfig,
        thresholds: { ...baseConfig.thresholds, minimumConfidence: 0.81 },
      },
      identity,
    ),
  );
  assert.notEqual(
    first,
    workflowPolicyFingerprint(
      "a".repeat(64),
      { ...baseConfig, maxCandidates: baseConfig.maxCandidates + 1 },
      identity,
    ),
  );
  assert.notEqual(
    first,
    workflowPolicyFingerprint("b".repeat(64), baseConfig, identity),
  );
  assert.notEqual(
    first,
    workflowPolicyFingerprint("a".repeat(64), baseConfig, "deterministic-v2"),
  );
});
