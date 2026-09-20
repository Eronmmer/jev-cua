import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { RuntimeConfig } from "../src/config.js";
import { DriverToolError } from "../src/cua/client.js";
import { FastpathController } from "../src/engine/controller.js";
import { buildBrowserCandidates } from "../src/policy/candidates.js";
import { DesktopLease, RunStore } from "../src/state.js";
import { buildCompiledWorkflowCandidates } from "../src/workflows/compiler.js";
import {
  bindWorkflowInputs,
  parseWorkflowManifest,
} from "../src/workflows/manifest.js";
import type {
  Candidate,
  CandidateDecision,
  DecisionPolicy,
  DriverClient,
  JsonValue,
  RunRequest,
  TraceSink,
} from "../src/types.js";

const REQUIRED_TOOLS = [
  "get_browser_state",
  "browser_click",
  "browser_type",
  "browser_pointer",
  "browser_prepare",
  "browser_navigate",
  "list_windows",
  "end_session",
] as const;

type DriverCall = Readonly<{
  tool: string;
  arguments: Readonly<Record<string, JsonValue>>;
}>;

class FakeDriver implements DriverClient {
  readonly calls: DriverCall[] = [];
  connectCount = 0;
  closeCount = 0;
  throwAmbiguouslyOnAction = false;
  private observationIndex = 0;

  constructor(
    private readonly observations: readonly Record<string, unknown>[],
  ) {}

  async connect(): Promise<void> {
    this.connectCount += 1;
  }

  async listTools(): Promise<readonly { name: string }[]> {
    return REQUIRED_TOOLS.map((name) => ({ name }));
  }

  async call(
    tool: string,
    arguments_: Record<string, JsonValue>,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ tool, arguments: structuredClone(arguments_) });
    if (tool === "browser_prepare") return { prepared_pid: 7_001 };
    if (tool === "list_windows") {
      return {
        windows: [
          {
            window_id: 81,
            is_on_screen: true,
            bounds: { width: 1200, height: 800 },
          },
        ],
      };
    }
    if (tool === "get_browser_state" && typeof arguments_.pid === "number") {
      return {
        status: "ok",
        mode: "bind",
        binding_quality: "exact",
        mutation_allowed: true,
        target_id: "target-1",
        tabs: [{ tab_id: "tab-1", active: true, title: "Fixture" }],
      };
    }
    if (tool === "get_browser_state") {
      const observation =
        this.observations[
          Math.min(this.observationIndex, this.observations.length - 1)
        ];
      this.observationIndex += 1;
      assert.ok(observation, "a fake observation must be configured");
      return structuredClone(observation);
    }
    if (tool === "browser_click" || tool === "browser_type") {
      if (this.throwAmbiguouslyOnAction) {
        throw new DriverToolError(
          tool,
          true,
          "simulated timeout after dispatch",
        );
      }
      return { status: "ok" };
    }
    if (tool === "browser_navigate" || tool === "end_session")
      return { status: "ok" };
    throw new Error(`unexpected fake driver call: ${tool}`);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  mutatingCalls(): readonly DriverCall[] {
    return this.calls.filter((call) =>
      ["browser_click", "browser_type", "browser_pointer"].includes(call.tool),
    );
  }
}

class MemoryTraceSink implements TraceSink {
  readonly events: Array<Readonly<Record<string, JsonValue>>> = [];

  async append(
    _runId: string,
    event: Readonly<Record<string, JsonValue>>,
  ): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

class FunctionPolicy implements DecisionPolicy {
  calls = 0;

  constructor(private readonly implementation: DecisionPolicy["choose"]) {}

  async choose(
    input: Parameters<DecisionPolicy["choose"]>[0],
  ): Promise<CandidateDecision> {
    this.calls += 1;
    return this.implementation(input);
  }
}

function executable(candidates: readonly Candidate[]): Candidate {
  const match = candidates.find((candidate) => candidate.action !== null);
  assert.ok(match, "expected an executable candidate");
  return match;
}

function decisionFor(
  candidates: readonly Candidate[],
  options: Readonly<{ confidence?: number; selectedProbability?: number }> = {},
): CandidateDecision {
  const selected = executable(candidates);
  const selectedProbability = options.selectedProbability ?? 0.97;
  const remainder = (1 - selectedProbability) / (candidates.length - 1);
  return {
    selectedId: selected.id,
    confidence: options.confidence ?? 0.98,
    probabilities: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        candidate.id === selected.id ? selectedProbability : remainder,
      ]),
    ),
    selectedFit: 0.99,
    model: "jev-1.13.0",
    inputTokens: 13,
    outputTokens: 5,
    latencyMs: 4,
  };
}

function observation(done = false, complete = true): Record<string, unknown> {
  return {
    status: "ok",
    mode: "snapshot",
    target_id: "target-1",
    tab_id: "tab-1",
    page: {
      url: done ? "https://example.test/complete" : "https://example.test/form",
      title: "Fixture",
    },
    outline: done ? "Workflow complete" : "Choose the next step",
    snapshot: { id: done ? "p2" : "p1", format: "semantic_v2", complete },
    refs: [
      {
        ref: "continue-button",
        role: "button",
        name: "Continue",
        actions: ["click"],
        disabled: false,
        frame: "main",
        visibility: "in_viewport",
      },
    ],
  };
}

function config(stateDirectory: string): RuntimeConfig {
  return {
    model: "jev-1.13.0",
    providerTimeoutMs: 1_500,
    maxCandidates: 24,
    labelMaxLength: 120,
    stateDirectory,
    workflowDirectory: join(stateDirectory, "workflows"),
    logLevel: "off",
    thresholds: {
      minimumProbability: 0.9,
      minimumConfidence: 0.8,
      minimumMargin: 0.5,
      minimumFit: 0.9,
    },
  };
}

function isolatedRequest(
  runKey: string,
  overrides: Partial<RunRequest> = {},
): RunRequest {
  return {
    runKey,
    policyFingerprint: "a".repeat(64),
    goal: "Reach the fixture completion state",
    target: {
      kind: "isolated",
      startUrl: "https://example.test/form",
      navigationEffect: "read_only_landing",
    },
    values: [],
    success: {
      kind: "exact_url",
      origin: "https://example.test",
      pathname: "/complete",
    },
    allowedOrigins: ["https://example.test"],
    mode: "live",
    maxSteps: 3,
    maxWallTimeMs: 10_000,
    workflowSteps: [
      {
        semanticKey: `click:${createHash("sha256").update("button\0Continue").digest("hex").slice(0, 16)}`,
        ensures: {
          kind: "exact_url",
          origin: "https://example.test",
          pathname: "/complete",
        },
      },
    ],
    ...overrides,
  };
}

async function stateDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-controller-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function controller(
  directory: string,
  driver: DriverClient,
  policy: DecisionPolicy,
  traces: TraceSink = new MemoryTraceSink(),
): FastpathController {
  return new FastpathController({
    driver,
    policy,
    config: config(directory),
    lease: new DesktopLease(directory),
    runs: new RunStore(directory),
    traces,
    candidateBuilder: buildBrowserCandidates,
    candidateSemanticPrefix: "click:",
    policyFingerprint: "a".repeat(64),
  });
}

function compiledWorkflowFixture() {
  return parseWorkflowManifest({
    schema: "jev-cua.workflow.v1",
    id: "controller-form",
    version: 1,
    enabled: true,
    description: "Controller sequencing fixture.",
    goal: "Enter the approved value and advance.",
    target: {
      kind: "isolated",
      start_url: "https://example.test/form",
      navigation_effect: "read_only_landing",
    },
    allowed_origins: ["https://example.test"],
    inputs: [
      {
        id: "reference",
        description: "Approved public reference",
        target_hints: ["reference"],
        classification: "public",
        max_length: 32,
        pattern: "^[A-Z0-9-]+$",
        allowed_disclosure_origins: ["https://example.test"],
      },
    ],
    success: {
      kind: "exact_url",
      origin: "https://example.test",
      pathname: "/complete",
    },
    steps: [
      {
        id: "enter_reference",
        description:
          "Enter the approved reference into the exact Reference field.",
        page: { origin: "https://example.test", pathname: "/form" },
        requires: [],
        action: {
          kind: "type",
          field: { role: "textbox", name: "Reference" },
          input_id: "reference",
          effect: "public_data_entry",
        },
        ensures: {
          kind: "exact_field_equals",
          page: { origin: "https://example.test", pathname: "/form" },
          field: { role: "textbox", name: "Reference" },
          input_id: "reference",
        },
      },
      {
        id: "advance",
        description: "Advance through the exact Continue control.",
        page: { origin: "https://example.test", pathname: "/form" },
        requires: [
          {
            kind: "field_equals",
            field: { role: "textbox", name: "Reference" },
            input_id: "reference",
          },
        ],
        action: {
          kind: "click",
          control: { role: "button", name: "Continue" },
          input_route: "dom_event",
          effect: "reversible_navigation",
        },
        ensures: {
          kind: "exact_url",
          origin: "https://example.test",
          pathname: "/complete",
        },
      },
    ],
  });
}

function compiledObservation(
  value: string,
  pathname = "/form",
): Record<string, unknown> {
  const final = pathname === "/complete";
  return {
    status: "ok",
    mode: "snapshot",
    target_id: "target-1",
    tab_id: "tab-1",
    page: { url: `https://example.test${pathname}`, title: "Compiled fixture" },
    outline: final ? "Complete" : "Form",
    snapshot: {
      id: `snapshot-${pathname}-${value || "empty"}`,
      format: "semantic_v2",
      complete: true,
    },
    refs: final
      ? []
      : [
          {
            ref: "reference-field",
            role: "textbox",
            name: "Reference",
            value,
            actions: ["type"],
            disabled: false,
            frame: "main",
            visibility: "in_viewport",
          },
          {
            ref: "continue-control",
            role: "button",
            name: "Continue",
            actions: ["click"],
            disabled: false,
            frame: "main",
            visibility: "in_viewport",
          },
        ],
  };
}

function compiledController(
  directory: string,
  driver: DriverClient,
  policy: DecisionPolicy,
) {
  const workflow = compiledWorkflowFixture();
  const invocation = bindWorkflowInputs(workflow, { reference: "ABC-123" });
  const semanticPrefix = `workflow:${workflow.id}:${workflow.version}:`;
  const subject = new FastpathController({
    driver,
    policy,
    config: config(directory),
    lease: new DesktopLease(directory),
    runs: new RunStore(directory),
    traces: new MemoryTraceSink(),
    candidateBuilder: ({ observation, values, completedSemanticKeys }) =>
      buildCompiledWorkflowCandidates({
        workflow,
        observation,
        values,
        completedSemanticKeys,
      }),
    candidateSemanticPrefix: semanticPrefix,
    policyFingerprint: "b".repeat(64),
  });
  const request: RunRequest = {
    runKey: "compiled-run-key",
    policyFingerprint: "b".repeat(64),
    goal: workflow.goal,
    target: workflow.target,
    values: invocation.values,
    success: workflow.success,
    allowedOrigins: workflow.allowedOrigins,
    mode: "live",
    maxSteps: 8,
    maxWallTimeMs: 10_000,
    workflowSteps: workflow.steps.map((step) => ({
      semanticKey: `${semanticPrefix}${step.id}`,
      ensures: step.ensures,
    })),
  };
  return { subject, request };
}

test("shadow mode validates locally without launching a browser or calling the provider", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([observation(false)]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const traces = new MemoryTraceSink();
  const subject = controller(directory, driver, policy, traces);
  const request = isolatedRequest("shadow-run", {
    mode: "shadow",
  });

  const result = await subject.run(request);

  assert.equal(result.outcome, "shadow_complete");
  assert.equal(result.steps.length, 0);
  assert.equal(policy.calls, 0);
  assert.deepEqual(driver.mutatingCalls(), []);
  assert.equal(driver.calls.length, 0);
  assert.equal(driver.connectCount, 0);
  assert.equal(traces.events.length, 0);
});

test("an initially satisfied terminal condition performs no Jev decision or semantic action", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([compiledObservation("", "/complete")]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const { subject, request } = compiledController(directory, driver, policy);

  const result = await subject.run(request);

  assert.equal(result.outcome, "verified");
  assert.equal(policy.calls, 0);
  assert.equal(driver.mutatingCalls().length, 0);
});

test("an already satisfied first step is reconciled and only the second step is dispatched", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    compiledObservation("ABC-123"),
    compiledObservation("ABC-123"),
    compiledObservation("", "/complete"),
  ]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const { subject, request } = compiledController(directory, driver, policy);

  const result = await subject.run(request);

  assert.equal(result.outcome, "verified");
  assert.equal(policy.calls, 1);
  assert.deepEqual(
    driver.mutatingCalls().map((call) => call.tool),
    ["browser_click"],
  );
});

test("a two-step workflow advances only after each exact postcondition", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    compiledObservation(""),
    compiledObservation(""),
    compiledObservation("ABC-123"),
    compiledObservation("ABC-123"),
    compiledObservation("ABC-123"),
    compiledObservation("", "/complete"),
  ]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const { subject, request } = compiledController(directory, driver, policy);

  const result = await subject.run(request);

  assert.equal(result.outcome, "verified");
  assert.equal(policy.calls, 2);
  assert.deepEqual(
    driver.mutatingCalls().map((call) => call.tool),
    ["browser_type", "browser_click"],
  );
});

test("an accepted dispatch with an unchanged page never unlocks the next workflow step", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    compiledObservation(""),
    compiledObservation(""),
    compiledObservation(""),
  ]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const { subject, request } = compiledController(directory, driver, policy);

  const result = await subject.run(request);

  assert.equal(result.outcome, "unknown");
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.frontierFallbackRecommended, false);
  assert.deepEqual(
    driver.mutatingCalls().map((call) => call.tool),
    ["browser_type"],
  );
});

test("a matching field on the wrong allowed page cannot satisfy a workflow postcondition", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    compiledObservation(""),
    compiledObservation(""),
    compiledObservation("ABC-123", "/other"),
  ]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const { subject, request } = compiledController(directory, driver, policy);

  const result = await subject.run(request);

  assert.equal(result.outcome, "unknown");
  assert.equal(result.reconciliationRequired, true);
  assert.deepEqual(
    driver.mutatingCalls().map((call) => call.tool),
    ["browser_type"],
  );
});

test("live mode executes one bounded action and verifies its postcondition", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    observation(false),
    observation(false),
    observation(true),
  ]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const traces = new MemoryTraceSink();
  const subject = controller(directory, driver, policy, traces);

  const result = await subject.run(isolatedRequest("successful-run"));

  assert.equal(result.outcome, "verified");
  assert.equal(result.frontierFallbackRecommended, false);
  assert.equal(result.steps.length, 1);
  assert.equal(policy.calls, 1);
  assert.equal(driver.mutatingCalls().length, 1);
  assert.equal(driver.mutatingCalls()[0]?.tool, "browser_click");
  assert.equal(driver.mutatingCalls()[0]?.arguments.target_id, "target-1");
  assert.equal(driver.mutatingCalls()[0]?.arguments.tab_id, "tab-1");
  assert.match(
    String(driver.mutatingCalls()[0]?.arguments.session),
    /^jev-cua-/,
  );
  assert.equal(
    driver.calls.filter((call) => call.tool === "get_browser_state").length,
    4,
  );
  assert.equal(
    driver.calls.filter((call) => call.tool === "end_session").length,
    1,
  );
  assert.deepEqual(
    traces.events
      .map((event) => event.event)
      .filter((event) => typeof event === "string"),
    [
      "browser_setup_started",
      "browser_setup_returned",
      "decision",
      "action_started",
      "action_returned",
      "postcondition_checked",
    ],
  );
  const postcondition = traces.events.find(
    (event) => event.event === "postcondition_checked",
  );
  assert.equal(postcondition?.step_satisfied, true);
  assert.equal(postcondition?.workflow_satisfied, true);
});

test("a low-confidence decision is rejected without dispatching an action", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([observation(false), observation(false)]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates, { confidence: 0.2 })),
  );
  const traces = new MemoryTraceSink();
  const subject = controller(directory, driver, policy, traces);

  const result = await subject.run(isolatedRequest("low-confidence-run"));

  assert.equal(result.outcome, "unknown");
  assert.match(
    result.reason,
    /did not pass probability, confidence, margin, and fit gates/,
  );
  assert.equal(result.frontierFallbackRecommended, true);
  assert.deepEqual(driver.mutatingCalls(), []);
  assert.ok(
    traces.events.some(
      (event) => event.event === "decision" && event.gate === "reject",
    ),
  );
  assert.ok(!traces.events.some((event) => event.event === "action_started"));
});

test("a partial snapshot can never satisfy the success condition", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([observation(true, false)]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const subject = controller(directory, driver, policy);

  const result = await subject.run(isolatedRequest("partial-success-run"));

  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /partial/i);
  assert.equal(policy.calls, 0);
  assert.deepEqual(driver.mutatingCalls(), []);
});

test("an incomplete post-action observation requires reconciliation", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    observation(false),
    observation(false),
    observation(true, false),
  ]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const subject = controller(directory, driver, policy);

  const result = await subject.run(isolatedRequest("partial-post-action-run"));

  assert.equal(result.outcome, "unknown");
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.safeToRetry, false);
  assert.equal(driver.mutatingCalls().length, 1);
});

test("a changed control between decision and dispatch is never acted on", async (t) => {
  const directory = await stateDirectory(t);
  const changed = structuredClone(observation(false));
  const refs = changed.refs as Array<Record<string, unknown>>;
  refs[0]!.name = "Different action";
  const driver = new FakeDriver([observation(false), changed]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const subject = controller(directory, driver, policy);

  const result = await subject.run(isolatedRequest("stale-control-run"));

  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /stale or ambiguous/i);
  assert.deepEqual(driver.mutatingCalls(), []);
});

test("an ambiguous mutating failure is never retried", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([observation(false)]);
  driver.throwAmbiguouslyOnAction = true;
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const traces = new MemoryTraceSink();
  const subject = controller(directory, driver, policy, traces);

  const result = await subject.run(isolatedRequest("ambiguous-run"));

  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /ambiguous/);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.safeToRetry, false);
  assert.equal(result.frontierFallbackRecommended, false);
  assert.equal(driver.mutatingCalls().length, 1);
  assert.equal(policy.calls, 1);
  const failures = traces.events.filter(
    (event) => event.event === "action_failed",
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.ambiguous, true);
  assert.ok(traces.events.some((event) => event.event === "action_started"));
  assert.ok(!traces.events.some((event) => event.event === "action_returned"));
});

test("a completed idempotency key returns the cached result without reconnecting or acting", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    observation(false),
    observation(false),
    observation(true),
  ]);
  const policy = new FunctionPolicy(({ candidates }) =>
    Promise.resolve(decisionFor(candidates)),
  );
  const subject = controller(directory, driver, policy);
  const request = isolatedRequest("same-idempotency-key");

  const first = await subject.run(request);
  const callsAfterFirst = driver.calls.length;
  const second = await subject.run(request);

  assert.equal(first.outcome, "verified");
  assert.deepEqual(second, first);
  assert.equal(driver.calls.length, callsAfterFirst);
  assert.equal(driver.connectCount, 1);
  assert.equal(policy.calls, 1);
  assert.equal(driver.mutatingCalls().length, 1);
});

test("concurrent runs cannot both acquire the physical desktop lease", async (t) => {
  const directory = await stateDirectory(t);
  const driver = new FakeDriver([
    observation(false),
    observation(false),
    observation(true),
  ]);
  let releasePolicy!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  const policy = new FunctionPolicy(async ({ candidates }) => {
    markEntered();
    await hold;
    return decisionFor(candidates);
  });
  const subject = controller(directory, driver, policy);

  const firstPromise = subject.run(isolatedRequest("concurrent-first"));
  await entered;
  const second = await subject.run(isolatedRequest("concurrent-second"));

  assert.equal(second.outcome, "unknown");
  assert.equal(
    second.reason,
    "The physical desktop is busy with another controller run.",
  );
  assert.equal(driver.mutatingCalls().length, 0);

  releasePolicy();
  const first = await firstPromise;
  assert.equal(first.outcome, "verified");
  assert.equal(driver.mutatingCalls().length, 1);
});
