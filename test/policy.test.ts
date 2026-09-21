import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Thresholds } from "../src/config.js";
import {
  buildBrowserCandidates,
  candidateById,
} from "../src/policy/candidates.js";
import { gateDecision } from "../src/policy/gate.js";
import {
  classifyRisk,
  riskMayExecuteAutomatically,
} from "../src/policy/risk.js";
import type {
  BrowserObservation,
  Candidate,
  CandidateDecision,
  RiskClass,
  ValueSlot,
} from "../src/types.js";

const OBSERVATION_DIGEST = "observation-digest-1";
const PINNED_MODEL = "jev-1.13.0";

const strictThresholds: Thresholds = Object.freeze({
  minimumProbability: 0.8,
  minimumConfidence: 0.8,
  minimumMargin: 0.5,
  minimumFit: 0.9,
});

function observation(
  overrides: Partial<BrowserObservation> = {},
): BrowserObservation {
  return {
    targetId: "target-1",
    tabId: "tab-1",
    snapshotId: "snapshot-1",
    url: "https://example.test/form",
    title: "Example form",
    outline: "Untrusted page outline",
    refs: [
      {
        ref: "ref-submit-private",
        role: "button",
        name: "Continue",
        actions: ["click"],
        disabled: false,
        frame: "main",
        visibility: "in_viewport",
      },
      {
        ref: "ref-email-private",
        role: "textbox",
        name: "Account email",
        actions: ["type"],
        disabled: false,
        frame: "main",
        visibility: "in_viewport",
      },
      {
        ref: "ref-scroll-private",
        role: "region",
        name: "Results",
        actions: ["scroll"],
        disabled: false,
        frame: "main",
        visibility: "in_viewport",
      },
    ],
    complete: true,
    digest: OBSERVATION_DIGEST,
    ...overrides,
  };
}

function buildCandidates(
  input: Readonly<{
    observation?: BrowserObservation;
    values?: readonly ValueSlot[];
    maximum?: number;
    privateState?: boolean;
  }> = {},
): readonly Candidate[] {
  return buildBrowserCandidates({
    observation: input.observation ?? observation(),
    values: input.values ?? [
      {
        id: "account-email",
        description: "account email",
        value: "person@example.test",
        targetHints: ["account", "email"],
        secret: false,
      },
    ],
    maximum: input.maximum ?? 12,
    labelMaxLength: 120,
    privateState: input.privateState ?? false,
  });
}

function candidate(
  input: Readonly<{
    id: string;
    semanticKey?: string;
    risk?: RiskClass;
    observationDigest?: string;
    executable?: boolean;
  }>,
): Candidate {
  return Object.freeze({
    id: input.id,
    semanticKey: input.semanticKey ?? `semantic-${input.id}`,
    description: `Candidate ${input.id}`,
    risk: input.risk ?? "r1_reversible",
    action:
      input.executable === false
        ? null
        : Object.freeze({
            tool: "browser_click",
            arguments: Object.freeze({ ref: input.id }),
          }),
    expectedEffect: "A safe local change occurs.",
    observationDigest: input.observationDigest ?? OBSERVATION_DIGEST,
    actionDigest: input.executable === false ? null : `digest-${input.id}`,
  });
}

function decision(
  candidates: readonly Candidate[],
  selectedId: string,
  probabilities: Readonly<Record<string, number>>,
  overrides: Partial<CandidateDecision> = {},
): CandidateDecision {
  return {
    selectedId,
    confidence: 0.96,
    probabilities,
    selectedFit: 0.97,
    model: PINNED_MODEL,
    inputTokens: 12,
    outputTokens: 3,
    latencyMs: 20,
    ...overrides,
  };
}

function gate(
  candidates: readonly Candidate[],
  selectedId: string,
  probabilities: Readonly<Record<string, number>>,
  overrides: Readonly<{
    decision?: Partial<CandidateDecision>;
    observationDigest?: string;
    expectedModel?: string;
    thresholds?: Thresholds;
  }> = {},
) {
  return gateDecision({
    decision: decision(
      candidates,
      selectedId,
      probabilities,
      overrides.decision,
    ),
    candidates,
    observationDigest: overrides.observationDigest ?? OBSERVATION_DIGEST,
    expectedModel: overrides.expectedModel ?? PINNED_MODEL,
    thresholds: overrides.thresholds ?? strictThresholds,
  });
}

describe("browser candidate construction", () => {
  test("keeps raw values, element refs, and recognizable credentials out of provider-facing text", () => {
    const secret = "DO_NOT_SEND_RAW_SECRET_9fbd2c";
    const rawEmail = "alice@example.com";
    const rawCredential = "sk-AbCdEfGhIjKlMnOp";
    const rawOutline = `Page contains ${secret}`;
    const candidates = buildCandidates({
      observation: observation({
        outline: rawOutline,
        refs: [
          {
            ref: "sensitive-ref-123",
            role: "button",
            name: `Contact ${rawEmail} using ${rawCredential}`,
            actions: ["click"],
            disabled: false,
            frame: "main",
            visibility: "in_viewport",
          },
          {
            ref: "sensitive-input-ref-456",
            role: "textbox",
            name: "API credential",
            value: secret,
            actions: ["type"],
            disabled: false,
            frame: "main",
            visibility: "in_viewport",
          },
        ],
      }),
      values: [
        {
          id: "service-credential",
          description: "API credential",
          value: secret,
          targetHints: ["API", "credential"],
          secret: true,
        },
      ],
    });

    const providerProjection = candidates.map(
      ({
        id,
        semanticKey,
        description,
        risk,
        expectedEffect,
        observationDigest,
      }) => ({
        id,
        semanticKey,
        description,
        risk,
        expectedEffect,
        observationDigest,
      }),
    );
    const providerText = JSON.stringify(providerProjection);

    assert.equal(providerText.includes(secret), false);
    assert.equal(providerText.includes(rawEmail), false);
    assert.equal(providerText.includes(rawCredential), false);
    assert.equal(providerText.includes(rawOutline), false);
    assert.equal(providerText.includes("sensitive-ref-123"), false);
    assert.equal(providerText.includes("sensitive-input-ref-456"), false);
    assert.match(providerText, /\[email\]/u);
    assert.match(providerText, /\[credential\]/u);

    const typeCandidate = candidates.find(
      (entry) => entry.action?.tool === "browser_type",
    );
    assert.ok(typeCandidate?.action);
    assert.equal(
      typeCandidate.action.arguments.text,
      secret,
      "the executable value remains available only in the local action",
    );
  });

  test("deep-freezes the result, candidates, actions, and action arguments", () => {
    const candidates = buildCandidates();
    const executable = candidates.find((entry) => entry.action !== null);
    assert.ok(executable?.action);

    assert.equal(Object.isFrozen(candidates), true);
    assert.equal(Object.isFrozen(executable), true);
    assert.equal(Object.isFrozen(executable.action), true);
    assert.equal(Object.isFrozen(executable.action.arguments), true);
    assert.ok(executable.actionDigest);
    assert.match(executable.actionDigest, /^[a-f0-9]{64}$/u);

    assert.throws(() => {
      (candidates as Candidate[]).pop();
    }, TypeError);
    assert.throws(() => {
      (executable as unknown as { description: string }).description =
        "mutated";
    }, TypeError);
    assert.throws(() => {
      (executable.action!.arguments as Record<string, unknown>).ref =
        "mutated-ref";
    }, TypeError);
  });

  test("generates fresh opaque IDs while preserving deterministic semantic identities", () => {
    const first = buildCandidates();
    const second = buildCandidates();
    const firstIds = new Set(first.map((entry) => entry.id));

    assert.equal(first.length, second.length);
    assert.deepEqual(
      first.map((entry) => entry.semanticKey),
      second.map((entry) => entry.semanticKey),
    );
    assert.equal(
      second.some((entry) => firstIds.has(entry.id)),
      false,
    );
    assert.equal(
      first.every((entry) => /^c_[A-Za-z0-9_-]{16}$/u.test(entry.id)),
      true,
    );
  });

  test("always appends exactly one safe reobserve, abstain, and escalate candidate within the configured cap", () => {
    const candidates = buildCandidates({ maximum: 4 });
    assert.equal(candidates.length, 4);
    assert.deepEqual(
      candidates.slice(-3).map((entry) => entry.semanticKey),
      ["reobserve", "abstain", "escalate"],
    );
    for (const entry of candidates.slice(-3)) {
      assert.equal(entry.action, null);
      assert.equal(entry.actionDigest, null);
      assert.equal(entry.risk, "r0_read_only");
      assert.equal(entry.observationDigest, OBSERVATION_DIGEST);
    }
  });

  test("rejects unknown and duplicate candidate IDs", () => {
    const first = candidate({ id: "duplicate" });
    const second = candidate({ id: "duplicate" });
    assert.throws(
      () => candidateById([first], "unknown"),
      /unknown or duplicate/u,
    );
    assert.throws(
      () => candidateById([first, second], "duplicate"),
      /unknown or duplicate/u,
    );
  });
});

describe("risk classification", () => {
  test("classifies credential entry and forbidden irreversible actions as forbidden", () => {
    assert.equal(
      classifyRisk({
        label: "Username",
        actionKind: "type",
        secretValue: true,
      }),
      "r4_forbidden",
    );
    for (const label of [
      "Delete account",
      "Purchase now",
      "Enter password",
      "Accept legal agreement",
      "Force Quit Calculator",
      "Restart",
      "Shut Down",
      "Lock Screen",
      "Log Out Erons",
    ]) {
      assert.equal(
        classifyRisk({ label, actionKind: "click" }),
        "r4_forbidden",
        label,
      );
    }
  });

  test("classifies external side effects as consequential", () => {
    for (const label of [
      "Send message",
      "Submit application",
      "Upload file",
      "Deploy release",
      "Share report",
    ]) {
      assert.equal(
        classifyRisk({ label, actionKind: "click" }),
        "r3_consequential",
        label,
      );
    }
  });

  test("classifies otherwise safe actions by whether they touch private state", () => {
    assert.equal(
      classifyRisk({ label: "Next page", actionKind: "click" }),
      "r1_reversible",
    );
    assert.equal(
      classifyRisk({ label: "Search", actionKind: "type", privateState: true }),
      "r2_private",
    );
    assert.equal(
      classifyRisk({
        label: "Results",
        actionKind: "scroll",
        privateState: true,
      }),
      "r2_private",
    );
  });

  test("permits automatic execution only for read-only and reversible risks", () => {
    assert.equal(riskMayExecuteAutomatically("r0_read_only"), true);
    assert.equal(riskMayExecuteAutomatically("r1_reversible"), true);
    assert.equal(riskMayExecuteAutomatically("r2_private"), false);
    assert.equal(riskMayExecuteAutomatically("r3_consequential"), false);
    assert.equal(riskMayExecuteAutomatically("r4_forbidden"), false);
  });
});

describe("decision gate", () => {
  const safe = candidate({ id: "safe" });
  const reobserve = candidate({
    id: "fresh",
    semanticKey: "reobserve",
    executable: false,
    risk: "r0_read_only",
  });
  const abstain = candidate({
    id: "stop",
    semanticKey: "abstain",
    executable: false,
    risk: "r0_read_only",
  });
  const candidates = [safe, reobserve, abstain] as const;
  const validProbabilities = { safe: 0.91, fresh: 0.05, stop: 0.04 } as const;

  test("executes an exact, current, pinned-model, high-confidence reversible candidate", () => {
    const result = gate(candidates, safe.id, validProbabilities);
    assert.equal(result.kind, "execute");
    assert.equal(result.candidate, safe);
  });

  test("routes reserved choices without dispatching an action", () => {
    const freshResult = gate(candidates, reobserve.id, {
      safe: 0.05,
      fresh: 0.91,
      stop: 0.04,
    });
    const stopResult = gate(candidates, abstain.id, {
      safe: 0.05,
      fresh: 0.04,
      stop: 0.91,
    });
    assert.equal(freshResult.kind, "reobserve");
    assert.equal(stopResult.kind, "abstain");
  });

  test("throws on incomplete, unknown, invalid, non-normalized, or non-argmax distributions", () => {
    const malformed: ReadonlyArray<
      Readonly<{
        name: string;
        probabilities: Record<string, number>;
        selected: string;
      }>
    > = [
      {
        name: "incomplete",
        probabilities: { safe: 0.95, fresh: 0.05 },
        selected: "safe",
      },
      {
        name: "unknown ID",
        probabilities: { safe: 0.9, fresh: 0.05, intruder: 0.05 },
        selected: "safe",
      },
      {
        name: "negative",
        probabilities: { safe: 1.01, fresh: -0.01, stop: 0 },
        selected: "safe",
      },
      {
        name: "not finite",
        probabilities: { safe: Number.NaN, fresh: 0.05, stop: 0.04 },
        selected: "safe",
      },
      {
        name: "not normalized",
        probabilities: { safe: 0.8, fresh: 0.1, stop: 0.05 },
        selected: "safe",
      },
      {
        name: "non-argmax",
        probabilities: { safe: 0.4, fresh: 0.5, stop: 0.1 },
        selected: "safe",
      },
    ];

    for (const entry of malformed) {
      assert.throws(
        () => gate(candidates, entry.selected, entry.probabilities),
        entry.name,
      );
    }
  });

  test("rejects a candidate from a stale observation", () => {
    const result = gate(candidates, safe.id, validProbabilities, {
      observationDigest: "newer-observation",
    });
    assert.equal(result.kind, "reject");
    assert.match(result.reason, /stale observation/u);
  });

  test("rejects a response from any model other than the calibrated pinned model", () => {
    const result = gate(candidates, safe.id, validProbabilities, {
      decision: { model: "jev-unpinned" },
    });
    assert.equal(result.kind, "reject");
    assert.match(result.reason, /pinned version/u);
  });

  test("rejects each probability, confidence, margin, and fit threshold failure", () => {
    const thresholdCases: ReadonlyArray<
      Readonly<{
        name: string;
        probabilities: Readonly<Record<string, number>>;
        decision?: Partial<CandidateDecision>;
      }>
    > = [
      {
        name: "probability",
        probabilities: { safe: 0.79, fresh: 0.11, stop: 0.1 },
      },
      {
        name: "confidence",
        probabilities: validProbabilities,
        decision: { confidence: 0.79 },
      },
      { name: "margin", probabilities: { safe: 0.7, fresh: 0.25, stop: 0.05 } },
      {
        name: "fit",
        probabilities: validProbabilities,
        decision: { selectedFit: 0.89 },
      },
    ];

    for (const entry of thresholdCases) {
      const result = gate(candidates, safe.id, entry.probabilities, {
        decision: entry.decision ?? {},
      });
      assert.equal(result.kind, "reject", entry.name);
      assert.match(
        result.reason,
        /probability, confidence, margin, and fit/u,
        entry.name,
      );
    }
  });

  test("fails closed on non-finite or out-of-range confidence and fit metrics", () => {
    for (const decisionOverride of [
      { confidence: Number.NaN },
      { confidence: Number.POSITIVE_INFINITY },
      { confidence: 1.01 },
      { confidence: -0.01 },
      { selectedFit: Number.NaN },
      { selectedFit: Number.POSITIVE_INFINITY },
      { selectedFit: 1.01 },
      { selectedFit: -0.01 },
    ]) {
      assert.throws(
        () =>
          gate(candidates, safe.id, validProbabilities, {
            decision: decisionOverride,
          }),
        /invalid (confidence|selected fit)/u,
      );
    }
  });

  test("requires trusted approval for private and consequential actions and denies forbidden actions", () => {
    for (const risk of ["r2_private", "r3_consequential"] as const) {
      const selected = candidate({ id: risk, risk });
      const result = gate([selected], selected.id, { [selected.id]: 1 });
      assert.equal(result.kind, "approval_required", risk);
    }

    const forbidden = candidate({ id: "forbidden", risk: "r4_forbidden" });
    const denied = gate([forbidden], forbidden.id, { forbidden: 1 });
    assert.equal(denied.kind, "denied");
  });

  test("rejects a non-reserved candidate that has no executable action", () => {
    const inert = candidate({ id: "inert", executable: false });
    const result = gate([inert], inert.id, { inert: 1 });
    assert.equal(result.kind, "reject");
    assert.match(result.reason, /not executable/u);
  });
});
