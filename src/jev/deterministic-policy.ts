import { candidateMayExecuteAutomatically } from "../policy/risk.js";
import type { Candidate, CandidateDecision, DecisionPolicy } from "../types.js";

export const DETERMINISTIC_DECISION_MODEL = "deterministic-closed-set-v1";

function uniqueAbstainCandidate(candidates: readonly Candidate[]): Candidate {
  const abstain = candidates.filter(
    (candidate) =>
      candidate.semanticKey === "abstain" && candidate.action === null,
  );
  if (abstain.length !== 1) {
    throw new Error(
      "deterministic policy requires exactly one closed-set abstain candidate",
    );
  }
  return abstain[0]!;
}

export class DeterministicDecisionPolicy implements DecisionPolicy {
  async choose(
    input: Parameters<DecisionPolicy["choose"]>[0],
  ): Promise<CandidateDecision> {
    input.signal?.throwIfAborted();
    const started = performance.now();
    const ids = input.candidates.map((candidate) => candidate.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("deterministic policy received duplicate candidate IDs");
    }

    const executable = input.candidates.filter(
      (candidate) =>
        candidate.action !== null &&
        candidateMayExecuteAutomatically(candidate),
    );
    const selected =
      executable.length === 1
        ? executable[0]!
        : uniqueAbstainCandidate(input.candidates);
    const probabilities = Object.freeze(
      Object.fromEntries(
        input.candidates.map((candidate) => [
          candidate.id,
          candidate.id === selected.id ? 1 : 0,
        ]),
      ),
    );

    return Object.freeze({
      selectedId: selected.id,
      confidence: 1,
      probabilities,
      selectedFit: 1,
      model: DETERMINISTIC_DECISION_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
    });
  }
}
