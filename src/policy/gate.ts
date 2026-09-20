import type { Candidate, CandidateDecision } from "../types.js";
import type { Thresholds } from "../config.js";
import { candidateById } from "./candidates.js";
import { candidateMayExecuteAutomatically } from "./risk.js";

export type GateResult =
  | Readonly<{ kind: "execute"; candidate: Candidate }>
  | Readonly<{
      kind: "reobserve" | "abstain" | "escalate";
      candidate: Candidate;
      reason: string;
    }>
  | Readonly<{
      kind: "approval_required" | "denied" | "reject";
      candidate: Candidate;
      reason: string;
    }>;

function validateDistribution(
  decision: CandidateDecision,
  candidates: readonly Candidate[],
): void {
  for (const [field, value] of [
    ["confidence", decision.confidence],
    ["selected fit", decision.selectedFit],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`provider returned an invalid ${field}`);
    }
  }
  const ids = new Set(candidates.map((candidate) => candidate.id));
  const entries = Object.entries(decision.probabilities);
  if (entries.length !== candidates.length)
    throw new Error("provider returned an incomplete probability distribution");
  let sum = 0;
  for (const [id, probability] of entries) {
    if (!ids.has(id))
      throw new Error(
        "provider returned a probability for an unknown candidate",
      );
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error("provider returned an invalid probability");
    }
    sum += probability;
  }
  if (Math.abs(sum - 1) > 0.03)
    throw new Error("provider probabilities do not form a distribution");
  const selectedProbability = decision.probabilities[decision.selectedId];
  if (selectedProbability === undefined)
    throw new Error("provider omitted the selected probability");
  const maximum = Math.max(...entries.map(([, probability]) => probability));
  if (selectedProbability + 1e-9 < maximum)
    throw new Error("provider selected a non-maximum-probability candidate");
}

export function gateDecision(
  input: Readonly<{
    decision: CandidateDecision;
    candidates: readonly Candidate[];
    observationDigest: string;
    expectedModel: string;
    thresholds: Thresholds;
  }>,
): GateResult {
  validateDistribution(input.decision, input.candidates);
  const candidate = candidateById(input.candidates, input.decision.selectedId);
  if (candidate.observationDigest !== input.observationDigest) {
    return {
      kind: "reject",
      candidate,
      reason: "candidate belongs to a stale observation",
    };
  }
  if (input.decision.model !== input.expectedModel) {
    return {
      kind: "reject",
      candidate,
      reason: "provider model differs from the calibrated pinned version",
    };
  }
  if (candidate.semanticKey === "reobserve")
    return {
      kind: "reobserve",
      candidate,
      reason: "provider requested a fresh observation",
    };
  if (candidate.semanticKey === "abstain")
    return { kind: "abstain", candidate, reason: "provider abstained" };
  if (candidate.semanticKey === "escalate")
    return {
      kind: "escalate",
      candidate,
      reason: "provider requested frontier-planner recovery",
    };
  if (candidate.risk === "r4_forbidden")
    return {
      kind: "denied",
      candidate,
      reason: "candidate is forbidden in the fast path",
    };
  if (!candidateMayExecuteAutomatically(candidate)) {
    return {
      kind: "approval_required",
      candidate,
      reason: `candidate risk ${candidate.risk} requires trusted approval`,
    };
  }

  const ranked = Object.values(input.decision.probabilities).sort(
    (left, right) => right - left,
  );
  const selectedProbability =
    input.decision.probabilities[input.decision.selectedId]!;
  const margin = selectedProbability - (ranked[1] ?? 0);
  if (
    selectedProbability < input.thresholds.minimumProbability ||
    input.decision.confidence < input.thresholds.minimumConfidence ||
    margin < input.thresholds.minimumMargin ||
    input.decision.selectedFit < input.thresholds.minimumFit
  ) {
    return {
      kind: "reject",
      candidate,
      reason:
        "decision did not pass probability, confidence, margin, and fit gates",
    };
  }
  if (!candidate.action)
    return {
      kind: "reject",
      candidate,
      reason: "selected candidate is not executable",
    };
  return { kind: "execute", candidate };
}
