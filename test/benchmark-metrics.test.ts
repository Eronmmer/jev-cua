import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBalancedSchedule,
  summarizeBenchmark,
  summarizeDistribution,
  summarizeVerifiedCompletion,
  type BenchmarkTrialResult,
} from "../src/benchmark/metrics.js";

test("balanced schedules are seeded, reproducible, adjacent, and immutable", () => {
  const first = buildBalancedSchedule(10, "benchmark-seed");
  const second = buildBalancedSchedule(10, "benchmark-seed");
  const differentSeed = buildBalancedSchedule(10, "different-seed");

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, differentSeed);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.length, 20);
  assert.ok(Object.isFrozen(first));

  let jevFirst = 0;
  let deterministicFirst = 0;
  for (let pairIndex = 0; pairIndex < 10; pairIndex += 1) {
    const firstRun = first[pairIndex * 2];
    const secondRun = first[pairIndex * 2 + 1];
    assert.ok(firstRun);
    assert.ok(secondRun);
    assert.deepEqual(
      [firstRun.runIndex, secondRun.runIndex],
      [pairIndex * 2, pairIndex * 2 + 1],
    );
    assert.equal(firstRun.pairIndex, pairIndex);
    assert.equal(secondRun.pairIndex, pairIndex);
    assert.deepEqual([firstRun.position, secondRun.position], [1, 2]);
    assert.deepEqual(
      new Set([firstRun.arm, secondRun.arm]),
      new Set(["jev", "deterministic"]),
    );
    assert.ok(Object.isFrozen(firstRun));
    if (firstRun.arm === "jev") jevFirst += 1;
    else deterministicFirst += 1;
  }
  assert.equal(jevFirst, 5);
  assert.equal(deterministicFirst, 5);
});

test("odd schedules differ by at most one and empty schedules stay valid", () => {
  const odd = buildBalancedSchedule(9, "odd-seed");
  const firstArms = odd
    .filter((entry) => entry.position === 1)
    .map((entry) => entry.arm);
  const difference = Math.abs(
    firstArms.filter((arm) => arm === "jev").length -
      firstArms.filter((arm) => arm === "deterministic").length,
  );

  assert.equal(difference, 1);
  assert.deepEqual(buildBalancedSchedule(0, "empty"), []);
  assert.throws(() => buildBalancedSchedule(-1, "seed"), RangeError);
  assert.throws(() => buildBalancedSchedule(1.5, "seed"), RangeError);
});

test("verified completion reports a Wilson 95% interval without zero division", () => {
  const empty = summarizeVerifiedCompletion([]);
  assert.deepEqual(empty, {
    runCount: 0,
    verifiedCount: 0,
    rate: null,
    wilson95: null,
  });
  assert.doesNotMatch(JSON.stringify(empty), /NaN|Infinity/u);

  const half = summarizeVerifiedCompletion([
    "verified",
    "verified",
    "verified",
    "verified",
    "verified",
    "refuted",
    "unknown",
    "abstained",
    "denied",
    "budget_exhausted",
  ]);
  assert.equal(half.rate, 0.5);
  assert.ok(half.wilson95);
  assert.ok(Math.abs(half.wilson95.lower - 0.236593090512564) < 1e-12);
  assert.ok(Math.abs(half.wilson95.upper - 0.763406909487436) < 1e-12);

  const none = summarizeVerifiedCompletion(Array(10).fill("refuted"));
  assert.equal(none.wilson95?.lower, 0);
  assert.ok(Math.abs((none.wilson95?.upper ?? 0) - 0.27753279986289) < 1e-12);

  const all = summarizeVerifiedCompletion(Array(10).fill("verified"));
  assert.ok(Math.abs((all.wilson95?.lower ?? 0) - 0.72246720013711) < 1e-12);
  assert.equal(all.wilson95?.upper, 1);
});

test("distribution summary uses arithmetic median and nearest-rank p95", () => {
  assert.deepEqual(summarizeDistribution([]), {
    count: 0,
    median: null,
    p95: null,
  });
  assert.deepEqual(summarizeDistribution([40, 10, 30, 20]), {
    count: 4,
    median: 25,
    p95: 40,
  });
  assert.deepEqual(summarizeDistribution([3, 1, 2]), {
    count: 3,
    median: 2,
    p95: 3,
  });
  assert.throws(() => summarizeDistribution([-1]), RangeError);
  assert.throws(() => summarizeDistribution([Number.NaN]), RangeError);
  assert.throws(
    () => summarizeDistribution([Number.POSITIVE_INFINITY]),
    RangeError,
  );
});

test("benchmark summaries pair by pair index and report per-arm outcomes", () => {
  const results: readonly BenchmarkTrialResult[] = [
    { pairIndex: 1, arm: "deterministic", outcome: "refuted", latencyMs: 120 },
    { pairIndex: 0, arm: "jev", outcome: "verified", latencyMs: 100 },
    { pairIndex: 2, arm: "jev", outcome: "unknown", latencyMs: 55 },
    { pairIndex: 1, arm: "jev", outcome: "verified", latencyMs: 90 },
    {
      pairIndex: 0,
      arm: "deterministic",
      outcome: "verified",
      latencyMs: 80,
    },
  ];
  const original = structuredClone(results);
  const summary = summarizeBenchmark(results);

  assert.deepEqual(results, original, "the input array must not be mutated");
  assert.equal(summary.runCount, 5);
  assert.equal(summary.outcomes.verified, 3);
  assert.equal(summary.outcomes.refuted, 1);
  assert.equal(summary.outcomes.unknown, 1);
  assert.equal(summary.outcomes.approval_required, 0);
  assert.equal(summary.verifiedCompletion.rate, 0.6);
  assert.deepEqual(summary.arms.jev.latencyMs, {
    count: 3,
    median: 90,
    p95: 100,
  });
  assert.equal(summary.arms.jev.verifiedCompletion.rate, 2 / 3);
  assert.equal(summary.arms.deterministic.verifiedCompletion.rate, 1 / 2);
  assert.equal(summary.pairedLatency.pairCount, 2);
  assert.equal(summary.pairedLatency.bothVerifiedPairCount, 1);
  assert.equal(summary.pairedLatency.unmatchedRunCount, 1);
  assert.deepEqual(summary.pairedLatency.deltas, [
    {
      pairIndex: 0,
      jevLatencyMs: 100,
      deterministicLatencyMs: 80,
      jevMinusDeterministicMs: 20,
      bothVerified: true,
    },
    {
      pairIndex: 1,
      jevLatencyMs: 90,
      deterministicLatencyMs: 120,
      jevMinusDeterministicMs: -30,
      bothVerified: false,
    },
  ]);
  assert.deepEqual(summary.pairedLatency.allDeltasMs, {
    count: 2,
    median: -5,
    p95: 20,
  });
  assert.deepEqual(summary.pairedCompletion, {
    pairCount: 2,
    bothVerified: 1,
    jevOnlyVerified: 1,
    deterministicOnlyVerified: 0,
    neitherVerified: 0,
    exactMcNemarTwoSidedP: 1,
  });
  assert.deepEqual(summary.pairedLatency.bothVerifiedDeltasMs, {
    count: 1,
    median: 20,
    p95: 20,
  });
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.arms.jev.outcomes));
  assert.ok(Object.isFrozen(summary.pairedLatency.deltas[0]));
  assert.doesNotMatch(JSON.stringify(summary), /NaN|Infinity/u);
});

test("empty and incomplete benchmark summaries are finite and explicit", () => {
  const empty = summarizeBenchmark([]);
  assert.equal(empty.runCount, 0);
  assert.equal(empty.verifiedCompletion.rate, null);
  assert.equal(empty.arms.jev.latencyMs.median, null);
  assert.equal(empty.pairedLatency.pairCount, 0);
  assert.equal(empty.pairedLatency.unmatchedRunCount, 0);
  assert.equal(empty.pairedLatency.allDeltasMs.p95, null);
  assert.doesNotMatch(JSON.stringify(empty), /NaN|Infinity/u);

  const incomplete = summarizeBenchmark([
    { pairIndex: 7, arm: "deterministic", outcome: "unknown", latencyMs: 0 },
  ]);
  assert.equal(incomplete.pairedLatency.pairCount, 0);
  assert.equal(incomplete.pairedLatency.unmatchedRunCount, 1);
});

test("invalid and duplicate trial results fail closed", () => {
  assert.throws(
    () =>
      summarizeBenchmark([
        { pairIndex: 0, arm: "jev", outcome: "verified", latencyMs: 1 },
        { pairIndex: 0, arm: "jev", outcome: "verified", latencyMs: 2 },
      ]),
    /duplicate jev result/u,
  );
  assert.throws(
    () =>
      summarizeBenchmark([
        { pairIndex: -1, arm: "jev", outcome: "verified", latencyMs: 1 },
      ]),
    RangeError,
  );
  assert.throws(
    () =>
      summarizeBenchmark([
        {
          pairIndex: 0,
          arm: "jev",
          outcome: "verified",
          latencyMs: Number.NaN,
        },
      ]),
    RangeError,
  );
});
