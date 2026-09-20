import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadRuntimeConfig } from "../src/config.js";
import { TypeSafeDecisionPolicy } from "../src/jev/typesafe-policy.js";
import type { BrowserObservation, Candidate } from "../src/types.js";

function fixture() {
  const observation: BrowserObservation = Object.freeze({
    targetId: "local-target-ref-never-egress",
    tabId: "local-tab-ref-never-egress",
    snapshotId: "local-snapshot-never-egress",
    url: "https://example.test/private/path?token=do-not-send",
    title: "Account for alice@example.test",
    outline: "Raw private outline DO_NOT_SEND_OUTLINE",
    refs: Object.freeze([]),
    complete: true,
    digest: "digest-1",
  });
  const candidates: readonly Candidate[] = Object.freeze([
    Object.freeze({
      id: "c_one",
      semanticKey: "click:one",
      description: 'Click the enabled button labelled "Continue".',
      risk: "r1_reversible",
      action: Object.freeze({
        tool: "browser_type",
        arguments: Object.freeze({
          ref: "p1:secret-ref",
          text: "DO_NOT_SEND_VALUE",
        }),
      }),
      actionDigest: "local-action-digest",
      expectedEffect: "Continue.",
      observationDigest: observation.digest,
    }),
    Object.freeze({
      id: "c_two",
      semanticKey: "abstain",
      description: "Stop without acting.",
      risk: "r0_read_only",
      action: null,
      actionDigest: null,
      expectedEffect: "No action.",
      observationDigest: observation.digest,
    }),
  ]);
  return { observation, candidates };
}

describe("TypeSafe policy projection", () => {
  test("sends only the bounded provider projection and parses a valid answer", async () => {
    const captured: unknown[] = [];
    const fakeClient = {
      systemOne: async (request: unknown) => {
        captured.push(request);
        return {
          model: "jev-1.13.0",
          answers: {
            next_action: {
              type: "choice",
              choice: "c_one",
              confidence: 0.98,
              probabilities: { c_one: 0.96, c_two: 0.04 },
            },
            fits_c_one: { type: "noul", noul: 0.99 },
            fits_c_two: { type: "noul", noul: 0.01 },
          },
          usage: { input_tokens: 50, output_tokens: 5 },
        };
      },
    };
    const policy = new TypeSafeDecisionPolicy(
      fakeClient as never,
      loadRuntimeConfig({}),
    );
    const { observation, candidates } = fixture();
    const result = await policy.choose({
      goal: "Continue to the next step",
      observation,
      candidates,
    });

    assert.equal(result.selectedId, "c_one");
    assert.equal(result.selectedFit, 0.99);
    const payload = JSON.stringify(captured[0]);
    assert.equal(payload.includes("DO_NOT_SEND_VALUE"), false);
    assert.equal(payload.includes("DO_NOT_SEND_OUTLINE"), false);
    assert.equal(payload.includes("p1:secret-ref"), false);
    assert.equal(payload.includes("local-target-ref-never-egress"), false);
    assert.equal(payload.includes("local-tab-ref-never-egress"), false);
    assert.equal(payload.includes("/private/path"), false);
    assert.equal(payload.includes("token=do-not-send"), false);
    assert.equal(payload.includes("alice@example.test"), false);
    assert.doesNotMatch(payload, /\[email\]/u);
    assert.equal(payload.includes("https://example.test"), false);
  });

  test("rejects an unknown probability key", async () => {
    const fakeClient = {
      systemOne: async () => ({
        model: "jev-1.13.0",
        answers: {
          next_action: {
            type: "choice",
            choice: "c_one",
            confidence: 0.98,
            probabilities: { c_one: 0.9, c_two: 0.05, injected: 0.05 },
          },
          fits_c_one: { type: "noul", noul: 0.99 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    const policy = new TypeSafeDecisionPolicy(
      fakeClient as never,
      loadRuntimeConfig({}),
    );
    await assert.rejects(
      () => policy.choose({ ...fixture(), goal: "Continue" }),
      /unknown probability key/u,
    );
  });

  test("rejects a response from a different model", async () => {
    const fakeClient = {
      systemOne: async () => ({
        model: "jev-latest",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    const policy = new TypeSafeDecisionPolicy(
      fakeClient as never,
      loadRuntimeConfig({}),
    );
    await assert.rejects(
      () => policy.choose({ ...fixture(), goal: "Continue" }),
      /pinned model/u,
    );
  });
});
