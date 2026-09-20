import assert from "node:assert/strict";
import test from "node:test";

import {
  DETERMINISTIC_DECISION_MODEL,
  DeterministicDecisionPolicy,
} from "../src/jev/deterministic-policy.js";
import type { BrowserObservation, Candidate, RiskClass } from "../src/types.js";

const OBSERVATION_DIGEST = "f".repeat(64);

const observation: BrowserObservation = Object.freeze({
  targetId: "target-1",
  tabId: "tab-1",
  snapshotId: "snapshot-1",
  url: "https://example.test/form",
  refs: Object.freeze([]),
  complete: true,
  digest: OBSERVATION_DIGEST,
});

function reserved(
  id: string,
  semanticKey: "reobserve" | "abstain" | "escalate",
): Candidate {
  return Object.freeze({
    id,
    semanticKey,
    description: semanticKey,
    risk: "r0_read_only",
    action: null,
    actionDigest: null,
    expectedEffect: "No action is dispatched.",
    observationDigest: OBSERVATION_DIGEST,
  });
}

function executable(
  id: string,
  risk: RiskClass = "r1_reversible",
  authorization?: Candidate["authorization"],
): Candidate {
  return Object.freeze({
    id,
    semanticKey: `workflow:fixture:1:${id}`,
    description: `Execute ${id}`,
    risk,
    action: Object.freeze({
      tool: "browser_click",
      arguments: Object.freeze({ ref: id }),
    }),
    actionDigest: `digest-${id}`,
    ...(authorization ? { authorization } : {}),
    expectedEffect: `${id} executes.`,
    observationDigest: OBSERVATION_DIGEST,
  });
}

function candidates(...actions: Candidate[]): readonly Candidate[] {
  return Object.freeze([
    ...actions,
    reserved("reserved-reobserve", "reobserve"),
    reserved("reserved-abstain", "abstain"),
    reserved("reserved-escalate", "escalate"),
  ]);
}

async function choose(
  candidateSet: readonly Candidate[],
  signal?: AbortSignal,
) {
  return new DeterministicDecisionPolicy().choose({
    goal: "Execute the exact reviewed next step.",
    observation,
    candidates: candidateSet,
    ...(signal ? { signal } : {}),
  });
}

test("selects the sole automatically executable candidate with a complete point distribution", async () => {
  const candidateSet = candidates(executable("only-action"));

  const decision = await choose(candidateSet);

  assert.equal(decision.selectedId, "only-action");
  assert.equal(decision.model, DETERMINISTIC_DECISION_MODEL);
  assert.equal(decision.model, "deterministic-closed-set-v1");
  assert.equal(decision.confidence, 1);
  assert.equal(decision.selectedFit, 1);
  assert.equal(decision.inputTokens, 0);
  assert.equal(decision.outputTokens, 0);
  assert.ok(Number.isFinite(decision.latencyMs));
  assert.ok(decision.latencyMs >= 0);
  assert.deepEqual(Object.keys(decision.probabilities), [
    "only-action",
    "reserved-reobserve",
    "reserved-abstain",
    "reserved-escalate",
  ]);
  assert.equal(
    Object.values(decision.probabilities).reduce(
      (sum, probability) => sum + probability,
      0,
    ),
    1,
  );
  assert.equal(decision.probabilities["only-action"], 1);
  assert.equal(decision.probabilities["reserved-abstain"], 0);
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.probabilities));
});

test("treats an approved private workflow action as automatically executable", async () => {
  const candidateSet = candidates(
    executable("approved-private", "r2_private", "approved_workflow"),
    executable("unapproved-private", "r2_private"),
    executable("consequential", "r3_consequential", "approved_workflow"),
  );

  const decision = await choose(candidateSet);

  assert.equal(decision.selectedId, "approved-private");
  assert.equal(decision.probabilities["approved-private"], 1);
});

test("selects abstain when no candidate may execute automatically", async () => {
  const candidateSet = candidates(
    executable("private", "r2_private"),
    executable("forbidden", "r4_forbidden"),
  );

  const decision = await choose(candidateSet);

  assert.equal(decision.selectedId, "reserved-abstain");
  assert.equal(decision.probabilities["reserved-abstain"], 1);
});

test("selects abstain when multiple candidates may execute automatically", async () => {
  const candidateSet = candidates(
    executable("first-action"),
    executable("second-action"),
  );

  const decision = await choose(candidateSet);

  assert.equal(decision.selectedId, "reserved-abstain");
  assert.equal(decision.probabilities["reserved-abstain"], 1);
  assert.equal(decision.probabilities["first-action"], 0);
  assert.equal(decision.probabilities["second-action"], 0);
});

test("rejects duplicate candidate IDs instead of returning a lossy distribution", async () => {
  const candidateSet = candidates(executable("duplicate"));
  const duplicate = Object.freeze({
    ...reserved("duplicate", "reobserve"),
  });

  await assert.rejects(
    choose(Object.freeze([...candidateSet, duplicate])),
    /duplicate candidate IDs/,
  );
});

test("fails closed when abstention is unavailable or ambiguous", async (t) => {
  await t.test("missing abstain candidate", async () => {
    await assert.rejects(
      choose(
        Object.freeze([
          reserved("reserved-reobserve", "reobserve"),
          reserved("reserved-escalate", "escalate"),
        ]),
      ),
      /exactly one closed-set abstain candidate/,
    );
  });

  await t.test("multiple abstain candidates", async () => {
    await assert.rejects(
      choose(
        Object.freeze([
          reserved("abstain-1", "abstain"),
          reserved("abstain-2", "abstain"),
          reserved("reserved-reobserve", "reobserve"),
          reserved("reserved-escalate", "escalate"),
        ]),
      ),
      /exactly one closed-set abstain candidate/,
    );
  });
});

test("honors an already-aborted decision signal", async () => {
  const signal = AbortSignal.abort(new Error("benchmark decision cancelled"));

  await assert.rejects(
    choose(candidates(executable("only-action")), signal),
    /benchmark decision cancelled/,
  );
});
