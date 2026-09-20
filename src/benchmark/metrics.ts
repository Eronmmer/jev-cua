import { createHash } from "node:crypto";

import type { Outcome } from "../types.js";
import { deepFreeze } from "../util.js";

export const BENCHMARK_ARMS = Object.freeze(["jev", "deterministic"] as const);
export type BenchmarkArm = (typeof BENCHMARK_ARMS)[number];

export const BENCHMARK_OUTCOMES = Object.freeze([
  "verified",
  "refuted",
  "unknown",
  "abstained",
  "approval_required",
  "denied",
  "budget_exhausted",
  "setup_required",
  "shadow_complete",
] as const satisfies readonly Outcome[]);

export type BenchmarkScheduleEntry = Readonly<{
  runIndex: number;
  pairIndex: number;
  position: 1 | 2;
  arm: BenchmarkArm;
}>;

export type BenchmarkTrialResult = Readonly<{
  pairIndex: number;
  arm: BenchmarkArm;
  outcome: Outcome;
  latencyMs: number;
}>;

export type WilsonInterval = Readonly<{
  lower: number;
  upper: number;
}>;

export type VerifiedCompletionSummary = Readonly<{
  runCount: number;
  verifiedCount: number;
  rate: number | null;
  wilson95: WilsonInterval | null;
}>;

export type DistributionSummary = Readonly<{
  count: number;
  median: number | null;
  p95: number | null;
}>;

export type OutcomeCounts = Readonly<Record<Outcome, number>>;

export type BenchmarkArmSummary = Readonly<{
  runCount: number;
  outcomes: OutcomeCounts;
  verifiedCompletion: VerifiedCompletionSummary;
  latencyMs: DistributionSummary;
}>;

export type PairedLatencyDelta = Readonly<{
  pairIndex: number;
  jevLatencyMs: number;
  deterministicLatencyMs: number;
  jevMinusDeterministicMs: number;
  bothVerified: boolean;
}>;

export type PairedLatencySummary = Readonly<{
  pairCount: number;
  bothVerifiedPairCount: number;
  unmatchedRunCount: number;
  deltas: readonly PairedLatencyDelta[];
  allDeltasMs: DistributionSummary;
  bothVerifiedDeltasMs: DistributionSummary;
}>;

export type PairedCompletionSummary = Readonly<{
  pairCount: number;
  bothVerified: number;
  jevOnlyVerified: number;
  deterministicOnlyVerified: number;
  neitherVerified: number;
  exactMcNemarTwoSidedP: number | null;
}>;

export type BenchmarkSummary = Readonly<{
  runCount: number;
  outcomes: OutcomeCounts;
  verifiedCompletion: VerifiedCompletionSummary;
  arms: Readonly<Record<BenchmarkArm, BenchmarkArmSummary>>;
  pairedCompletion: PairedCompletionSummary;
  pairedLatency: PairedLatencySummary;
}>;

const WILSON_95_Z = 1.959963984540054;
const OUTCOME_SET = new Set<string>(BENCHMARK_OUTCOMES);

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a finite non-negative number`);
}

function seededRank(seed: string, label: string): string {
  return createHash("sha256")
    .update(seed, "utf8")
    .update("\0", "utf8")
    .update(label, "utf8")
    .digest("hex");
}

/**
 * Builds adjacent paired trials. Every pair contains one run per arm. Even
 * pair counts have exactly as many Jev-first pairs as deterministic-first
 * pairs; odd counts differ by one, with the extra order selected by the seed.
 */
export function buildBalancedSchedule(
  pairCount: number,
  seed: string,
): readonly BenchmarkScheduleEntry[] {
  assertNonNegativeSafeInteger(pairCount, "pairCount");

  const jevFirstCount =
    Math.floor(pairCount / 2) +
    (pairCount % 2 === 1 &&
    Number.parseInt(seededRank(seed, "extra-order").slice(0, 2), 16) % 2 === 0
      ? 1
      : 0);

  const orders = Array.from({ length: pairCount }, (_, index) => ({
    order: index < jevFirstCount ? "jev_first" : "deterministic_first",
    rank: seededRank(seed, `pair-order:${index}`),
    sourceIndex: index,
  })).sort(
    (left, right) =>
      (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0) ||
      left.sourceIndex - right.sourceIndex,
  );

  const schedule: BenchmarkScheduleEntry[] = [];
  for (const [pairIndex, pair] of orders.entries()) {
    const first: BenchmarkArm =
      pair.order === "jev_first" ? "jev" : "deterministic";
    const second: BenchmarkArm = first === "jev" ? "deterministic" : "jev";
    schedule.push(
      {
        runIndex: schedule.length,
        pairIndex,
        position: 1,
        arm: first,
      },
      {
        runIndex: schedule.length + 1,
        pairIndex,
        position: 2,
        arm: second,
      },
    );
  }

  return deepFreeze(schedule);
}

export function summarizeVerifiedCompletion(
  outcomes: readonly Outcome[],
): VerifiedCompletionSummary {
  for (const outcome of outcomes) assertOutcome(outcome);

  const runCount = outcomes.length;
  const verifiedCount = outcomes.filter(
    (outcome) => outcome === "verified",
  ).length;

  if (runCount === 0) {
    return deepFreeze({
      runCount,
      verifiedCount,
      rate: null,
      wilson95: null,
    });
  }

  const rate = verifiedCount / runCount;
  const zSquared = WILSON_95_Z ** 2;
  const denominator = 1 + zSquared / runCount;
  const center = (rate + zSquared / (2 * runCount)) / denominator;
  const halfWidth =
    (WILSON_95_Z *
      Math.sqrt(
        (rate * (1 - rate)) / runCount + zSquared / (4 * runCount ** 2),
      )) /
    denominator;

  return deepFreeze({
    runCount,
    verifiedCount,
    rate,
    wilson95: {
      lower: verifiedCount === 0 ? 0 : Math.max(0, center - halfWidth),
      upper: verifiedCount === runCount ? 1 : Math.min(1, center + halfWidth),
    },
  });
}

export function summarizeDistribution(
  values: readonly number[],
): DistributionSummary {
  for (const [index, value] of values.entries())
    assertFiniteNonNegative(value, `values[${index}]`);

  if (values.length === 0)
    return deepFreeze({ count: 0, median: null, p95: null });

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? requireNumber(sorted[middle])
      : (requireNumber(sorted[middle - 1]) + requireNumber(sorted[middle])) / 2;
  const p95Index = Math.ceil(0.95 * sorted.length) - 1;

  return deepFreeze({
    count: sorted.length,
    median,
    p95: requireNumber(sorted[p95Index]),
  });
}

export function summarizeBenchmark(
  results: readonly BenchmarkTrialResult[],
): BenchmarkSummary {
  const validated = results.map((result, index) => {
    assertNonNegativeSafeInteger(
      result.pairIndex,
      `results[${index}].pairIndex`,
    );
    assertArm(result.arm);
    assertOutcome(result.outcome);
    assertFiniteNonNegative(result.latencyMs, `results[${index}].latencyMs`);
    return result;
  });

  const jev = validated.filter((result) => result.arm === "jev");
  const deterministic = validated.filter(
    (result) => result.arm === "deterministic",
  );
  const pairs = new Map<
    number,
    Partial<Record<BenchmarkArm, BenchmarkTrialResult>>
  >();

  for (const result of validated) {
    const pair = pairs.get(result.pairIndex) ?? {};
    if (pair[result.arm] !== undefined)
      throw new Error(
        `duplicate ${result.arm} result for pair ${result.pairIndex}`,
      );
    pair[result.arm] = result;
    pairs.set(result.pairIndex, pair);
  }

  const deltas: PairedLatencyDelta[] = [];
  let unmatchedRunCount = 0;
  for (const [pairIndex, pair] of [...pairs.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (pair.jev === undefined || pair.deterministic === undefined) {
      unmatchedRunCount += pair.jev === undefined ? 0 : 1;
      unmatchedRunCount += pair.deterministic === undefined ? 0 : 1;
      continue;
    }
    deltas.push({
      pairIndex,
      jevLatencyMs: pair.jev.latencyMs,
      deterministicLatencyMs: pair.deterministic.latencyMs,
      jevMinusDeterministicMs:
        pair.jev.latencyMs - pair.deterministic.latencyMs,
      bothVerified:
        pair.jev.outcome === "verified" &&
        pair.deterministic.outcome === "verified",
    });
  }

  const bothVerifiedDeltas = deltas.filter((delta) => delta.bothVerified);
  const completePairs = [...pairs.values()].filter(
    (pair): pair is Record<BenchmarkArm, BenchmarkTrialResult> =>
      pair.jev !== undefined && pair.deterministic !== undefined,
  );
  const bothVerified = completePairs.filter(
    (pair) =>
      pair.jev.outcome === "verified" &&
      pair.deterministic.outcome === "verified",
  ).length;
  const jevOnlyVerified = completePairs.filter(
    (pair) =>
      pair.jev.outcome === "verified" &&
      pair.deterministic.outcome !== "verified",
  ).length;
  const deterministicOnlyVerified = completePairs.filter(
    (pair) =>
      pair.jev.outcome !== "verified" &&
      pair.deterministic.outcome === "verified",
  ).length;
  return deepFreeze({
    runCount: validated.length,
    outcomes: countOutcomes(validated.map((result) => result.outcome)),
    verifiedCompletion: summarizeVerifiedCompletion(
      validated.map((result) => result.outcome),
    ),
    arms: {
      jev: summarizeArm(jev),
      deterministic: summarizeArm(deterministic),
    },
    pairedCompletion: {
      pairCount: completePairs.length,
      bothVerified,
      jevOnlyVerified,
      deterministicOnlyVerified,
      neitherVerified:
        completePairs.length -
        bothVerified -
        jevOnlyVerified -
        deterministicOnlyVerified,
      exactMcNemarTwoSidedP: exactMcNemarTwoSided(
        jevOnlyVerified,
        deterministicOnlyVerified,
      ),
    },
    pairedLatency: {
      pairCount: deltas.length,
      bothVerifiedPairCount: bothVerifiedDeltas.length,
      unmatchedRunCount,
      deltas,
      allDeltasMs: summarizeSignedDistribution(
        deltas.map((delta) => delta.jevMinusDeterministicMs),
      ),
      bothVerifiedDeltasMs: summarizeSignedDistribution(
        bothVerifiedDeltas.map((delta) => delta.jevMinusDeterministicMs),
      ),
    },
  });
}

function exactMcNemarTwoSided(
  jevOnlyVerified: number,
  deterministicOnlyVerified: number,
): number | null {
  const discordant = jevOnlyVerified + deterministicOnlyVerified;
  if (discordant === 0) return null;
  const lowerTail = Math.min(jevOnlyVerified, deterministicOnlyVerified);
  let probability = 2 ** -discordant;
  let cumulative = probability;
  for (let successes = 1; successes <= lowerTail; successes += 1) {
    probability *= (discordant - successes + 1) / successes;
    cumulative += probability;
  }
  return Math.min(1, 2 * cumulative);
}

function summarizeArm(
  results: readonly BenchmarkTrialResult[],
): BenchmarkArmSummary {
  const outcomes = results.map((result) => result.outcome);
  return deepFreeze({
    runCount: results.length,
    outcomes: countOutcomes(outcomes),
    verifiedCompletion: summarizeVerifiedCompletion(outcomes),
    latencyMs: summarizeDistribution(results.map((result) => result.latencyMs)),
  });
}

function countOutcomes(outcomes: readonly Outcome[]): OutcomeCounts {
  const counts = Object.fromEntries(
    BENCHMARK_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<Outcome, number>;
  for (const outcome of outcomes) {
    assertOutcome(outcome);
    counts[outcome] += 1;
  }
  return deepFreeze(counts);
}

function summarizeSignedDistribution(
  values: readonly number[],
): DistributionSummary {
  // Paired deltas may legitimately be negative. Reuse the quantile convention
  // while retaining stricter non-negative validation for elapsed latencies.
  for (const [index, value] of values.entries()) {
    if (!Number.isFinite(value))
      throw new RangeError(`values[${index}] must be finite`);
  }
  if (values.length === 0)
    return deepFreeze({ count: 0, median: null, p95: null });

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? requireNumber(sorted[middle])
      : (requireNumber(sorted[middle - 1]) + requireNumber(sorted[middle])) / 2;
  const p95Index = Math.ceil(0.95 * sorted.length) - 1;
  return deepFreeze({
    count: sorted.length,
    median,
    p95: requireNumber(sorted[p95Index]),
  });
}

function assertArm(arm: string): asserts arm is BenchmarkArm {
  if (arm !== "jev" && arm !== "deterministic")
    throw new Error(`unsupported benchmark arm: ${arm}`);
}

function assertOutcome(outcome: string): asserts outcome is Outcome {
  if (!OUTCOME_SET.has(outcome))
    throw new Error(`unsupported benchmark outcome: ${outcome}`);
}

function requireNumber(value: number | undefined): number {
  if (value === undefined) throw new Error("missing distribution value");
  return value;
}
