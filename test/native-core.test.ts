import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DriverToolError } from "../src/cua/client.js";
import { NativeComputerUseCore } from "../src/native/core.js";
import { NativeOperationStore } from "../src/native/operation-store.js";
import { DesktopLease, LiveExecutionBarrier, RunStore } from "../src/state.js";
import type {
  DriverClient,
  DriverToolDescriptor,
  JsonValue,
} from "../src/types.js";

const TARGET = Object.freeze({
  bundleId: "com.apple.calculator",
  pid: 123,
  windowId: 456,
});

const REQUIRED_NATIVE_TOOLS = [
  "start_session",
  "end_session",
  "list_apps",
  "list_windows",
  "get_window_state",
  "click",
  "type_text",
  "set_value",
  "press_key",
  "scroll",
  "invoke_menu",
  "verify_state",
] as const;

class NativeFixtureDriver implements DriverClient {
  readonly calls: Array<{
    tool: string;
    arguments: Record<string, JsonValue>;
  }> = [];
  connected = false;
  stateReads = 0;
  actionCalls = 0;
  appPid: number = TARGET.pid;
  bundleId: string = TARGET.bundleId;
  launchPath = "/System/Applications/Calculator.app";
  elementRole = "AXButton";
  elementLabel = "Approve fixture";
  textRole = "AXTextField";
  textValue: string | null = "private@example.test";
  elementsComplete = true;
  accessibilityAvailable = true;
  accessibilityAvailableAfterAction = true;
  preVerificationStatus: "satisfied" | "unsatisfied" | "unknown" =
    "unsatisfied";
  preVerificationSequence:
    | Array<"satisfied" | "unsatisfied" | "unknown">
    | undefined;
  verificationStatus: "satisfied" | "unsatisfied" | "unknown" = "satisfied";
  malformedPostVerification = false;
  syntheticDeliveryMode: "background" | "not_applicable" = "background";
  throwOnAction = false;
  omitRequiredTool = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async listTools(): Promise<readonly DriverToolDescriptor[]> {
    return REQUIRED_NATIVE_TOOLS.filter(
      (name) => !this.omitRequiredTool || name !== "verify_state",
    ).map((name) => ({ name }));
  }

  async call(
    tool: string,
    arguments_: Record<string, JsonValue>,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ tool, arguments: structuredClone(arguments_) });
    if (tool === "start_session")
      return { session: arguments_.session, active: true };
    if (tool === "end_session")
      return { session: arguments_.session, active: false };
    if (tool === "list_apps") {
      return {
        apps: [
          {
            bundle_id: this.bundleId,
            launch_path: this.launchPath,
            name: "Fixture App",
            running: true,
            active: false,
            pid: this.appPid,
          },
        ],
      };
    }
    if (tool === "list_windows") {
      return {
        windows: [
          {
            pid: this.appPid,
            window_id: TARGET.windowId,
            title: "Private fixture title",
            is_on_screen: true,
            on_current_space: true,
            minimized: false,
          },
        ],
      };
    }
    if (tool === "get_window_state") {
      this.stateReads += 1;
      return {
        pid: this.appPid,
        window_id: TARGET.windowId,
        snapshot_id: `s0000000${this.stateReads}`,
        element_count: 2,
        returned_element_count: 2,
        total_element_count: 2,
        elements_complete: this.elementsComplete,
        truncated: false,
        degraded: false,
        background_input: {
          exact_window: {
            pid: this.appPid,
            window_id: TARGET.windowId,
            status: "matched",
          },
          routes: [
            {
              route: "accessibility",
              status:
                this.accessibilityAvailable &&
                (this.actionCalls === 0 ||
                  this.accessibilityAvailableAfterAction)
                  ? "available"
                  : "unavailable",
            },
          ],
        },
        elements: [
          {
            element_index: 7,
            element_token: `private-token-${this.stateReads}`,
            role: this.elementRole,
            label: this.elementLabel,
            value: "raw-secret-value",
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: null,
          },
          {
            element_index: 8,
            element_token: `private-text-token-${this.stateReads}`,
            role: this.textRole,
            label: "Account email",
            value: this.textValue,
            actions: [],
            enabled: true,
            selected: false,
            parent_index: null,
          },
        ],
      };
    }
    if (
      [
        "click",
        "type_text",
        "set_value",
        "press_key",
        "scroll",
        "invoke_menu",
      ].includes(tool)
    ) {
      this.actionCalls += 1;
      if (this.throwOnAction)
        throw new DriverToolError(tool, true, "fixture dispatch failed");
      if (tool === "set_value" && typeof arguments_.value === "string")
        this.textValue = arguments_.value;
      return {
        effect: "unverifiable",
        route:
          tool === "click" || tool === "set_value" || tool === "invoke_menu"
            ? "accessibility"
            : "synthetic_events",
        delivery: {
          mode:
            tool === "click" || tool === "set_value" || tool === "invoke_menu"
              ? "not_applicable"
              : this.syntheticDeliveryMode,
        },
      };
    }
    if (tool === "verify_state") {
      const status =
        this.actionCalls === 0
          ? (this.preVerificationSequence?.shift() ??
            this.preVerificationStatus)
          : this.verificationStatus;
      return {
        status,
        stable: status === "satisfied",
        elapsed_ms: 0,
        samples:
          typeof arguments_.stable_samples === "number"
            ? arguments_.stable_samples
            : 1,
        predicates: [
          {
            index:
              this.actionCalls > 0 && this.malformedPostVerification ? 1 : 0,
            status,
            unknown_reason:
              status === "unknown" ? "observation_unavailable" : null,
            observed_json: null,
          },
        ],
      };
    }
    throw new Error(`unexpected fixture tool: ${tool}`);
  }

  async close(): Promise<void> {}
}

async function fixture(t: TestContext): Promise<{
  core: NativeComputerUseCore;
  driver: NativeFixtureDriver;
  barrier: LiveExecutionBarrier;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-native-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const driver = new NativeFixtureDriver();
  const barrier = new LiveExecutionBarrier(directory);
  const core = new NativeComputerUseCore({
    driver,
    lease: new DesktopLease(directory),
    executionBarrier: barrier,
    safetyRuns: new RunStore(directory),
    operations: new NativeOperationStore(directory),
    runId: "native-fixture-run",
  });
  t.after(async () => {
    await core.end().catch(() => undefined);
  });
  return { core, driver, barrier, directory };
}

async function readFilesRecursively(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) parts.push(await readFilesRecursively(path));
    else if (entry.isFile()) parts.push(await readFile(path, "utf8"));
  }
  return parts.join("\n");
}

const verification = Object.freeze({
  expect: Object.freeze([
    Object.freeze({
      element: Object.freeze({
        selector: Object.freeze({
          role: "AXStaticText",
          labelContains: "Done",
        }),
        valueEquals: "complete",
      }),
    }),
  ]),
  timeoutMs: 0,
  stableSamples: 1,
});

function executeApproved(
  core: NativeComputerUseCore,
  input: Parameters<NativeComputerUseCore["execute"]>[0],
) {
  return core.execute({
    ...input,
    authorizeConsequentialAction: async () => ({ status: "approved" }),
  });
}

async function observeFixture(core: NativeComputerUseCore) {
  const apps = await core.listApps();
  const app = apps.find((candidate) => candidate.name === "Fixture App");
  assert.ok(app);
  assert.equal("pid" in app, false);
  const windows = await core.listWindows({ appRef: app.appRef });
  const window = windows[0];
  assert.ok(window);
  assert.equal("windowId" in window, false);
  assert.equal("pid" in window, false);
  return core.observe({ windowRef: window.windowRef });
}

test("native core exposes opaque candidates and rebinds immediately before mutation", async (t) => {
  const { core, driver, barrier } = await fixture(t);
  const observation = await observeFixture(core);
  assert.equal(observation.complete, true);
  const button = observation.candidates.find(
    (candidate) => candidate.role === "AXButton",
  );
  assert.ok(button);
  assert.equal(button.valuePresent, true);
  assert.match(button.id, /^ncand_/u);
  const serialized = JSON.stringify(observation);
  assert.doesNotMatch(
    serialized,
    /private-token|element_index|snapshot_id|raw-secret-value|windowId|"pid"/u,
  );
  assert.equal(button.riskByAction.click, "r3_consequential");

  const result = await executeApproved(core, {
    operationKey: "click-once",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });

  assert.equal(result.outcome, "verified");
  assert.equal(result.safeToRetry, false);
  assert.equal(driver.actionCalls, 1);
  assert.equal(
    driver.stateReads,
    3,
    "observe, pre-action rebind, post-action reobserve",
  );
  const click = driver.calls.find((call) => call.tool === "click");
  assert.ok(click);
  assert.equal(click.arguments.element_token, "private-token-2");
  assert.equal(click.arguments.element_index, undefined);
  assert.equal(click.arguments.snapshot_id, undefined);
  assert.equal(click.arguments.x, undefined);
  assert.equal(click.arguments.y, undefined);

  assert.deepEqual(
    await executeApproved(core, {
      operationKey: "click-once",
      observationId: observation.id,
      candidateId: button.id,
      action: { kind: "click" },
      verification,
    }),
    result,
  );
  assert.equal(driver.actionCalls, 1);
  await assert.rejects(
    executeApproved(core, {
      operationKey: "click-once",
      observationId: observation.id,
      candidateId: button.id,
      action: { kind: "click" },
      verification: {
        ...verification,
        expect: [
          {
            element: {
              selector: { role: "AXStaticText", labelContains: "Different" },
              valueEquals: "complete",
            },
          },
        ],
      },
    }),
    /operation key was used for another request/u,
  );

  const ended = await core.end();
  assert.deepEqual(ended, {
    cleanupSucceeded: true,
    reconciliationRequired: false,
  });
  assert.deepEqual(await barrier.status(), { blocked: false });
  assert.equal(
    driver.calls.filter((call) => call.tool === "start_session").length,
    1,
  );
  assert.equal(
    driver.calls.filter((call) => call.tool === "end_session").length,
    1,
  );
});

test("a postcondition that is already satisfied is denied before dispatch", async (t) => {
  const { core, driver, barrier } = await fixture(t);
  driver.preVerificationStatus = "satisfied";
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);

  const result = await executeApproved(core, {
    operationKey: "already-satisfied",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });

  assert.deepEqual(result, {
    outcome: "denied",
    reasonCode: "precondition_already_satisfied",
    mutationAttempted: false,
    reconciliationRequired: false,
    safeToRetry: false,
    replayed: false,
  });
  assert.equal(driver.actionCalls, 0);
  const status = await barrier.status();
  assert.equal(status.state, "active");
  assert.equal(status.runId, core.runId);
});

test("an unknown precondition returns safely before reserving or dispatching", async (t) => {
  const { core, driver, barrier } = await fixture(t);
  driver.preVerificationStatus = "unknown";
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);

  const result = await executeApproved(core, {
    operationKey: "unknown-precondition",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });

  assert.equal(result.reasonCode, "precondition_unknown");
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.safeToRetry, true);
  assert.equal(driver.actionCalls, 0);
  assert.equal((await barrier.status()).state, "active");
});

test("a healthy Cua Accessibility projection remains actionable without claiming exhaustiveness", async (t) => {
  const { core, driver } = await fixture(t);
  driver.elementsComplete = false;
  const observation = await observeFixture(core);
  assert.equal(observation.complete, false);
  assert.equal(observation.actionable, true);
  assert.equal(observation.candidateCount > 0, true);
});

test("native core publishes no actions without an attested Accessibility route", async (t) => {
  const { core, driver } = await fixture(t);
  driver.accessibilityAvailable = false;
  const observation = await observeFixture(core);
  assert.equal(observation.complete, false);
  assert.equal(observation.actionable, false);
  assert.equal(observation.candidateCount, 0);
});

test("native core rejects a changed exact app binding before dispatch", async (t) => {
  const { core, driver } = await fixture(t);
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);
  driver.appPid = 999;

  const result = await executeApproved(core, {
    operationKey: "must-not-dispatch",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });

  assert.equal(result.reasonCode, "stale_observation");
  assert.equal(result.mutationAttempted, false);
  assert.equal(driver.actionCalls, 0);
});

test("native core fails closed when semantic identity changed before dispatch", async (t) => {
  const { core, driver } = await fixture(t);
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);
  driver.elementLabel = "Different control";

  const result = await executeApproved(core, {
    operationKey: "stale-candidate",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });

  assert.equal(result.reasonCode, "stale_observation");
  assert.equal(driver.actionCalls, 0);
});

test("unknown deterministic verification poisons the task and retains the barrier", async (t) => {
  const { core, driver, barrier } = await fixture(t);
  driver.verificationStatus = "unknown";
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);

  const result = await executeApproved(core, {
    operationKey: "unknown-verification",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.deepEqual(
    {
      outcome: result.outcome,
      reason: result.reasonCode,
      reconciliation: result.reconciliationRequired,
      safeToRetry: result.safeToRetry,
    },
    {
      outcome: "unknown",
      reason: "verification_unknown",
      reconciliation: true,
      safeToRetry: false,
    },
  );
  assert.equal((await barrier.status()).state, "reconciliation_required");
  const second = await executeApproved(core, {
    operationKey: "another-operation",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(second.reasonCode, "reconciliation_required");
  assert.equal(driver.actionCalls, 1);

  const ended = await core.end();
  assert.equal(ended.reconciliationRequired, true);
  assert.equal((await barrier.status()).state, "reconciliation_required");
});

test("malformed post-action verification cannot certify success", async (t) => {
  const { core, driver, barrier } = await fixture(t);
  driver.malformedPostVerification = true;
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);

  const result = await executeApproved(core, {
    operationKey: "malformed-verification",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.reasonCode, "verification_unknown");
  assert.equal(result.reconciliationRequired, true);
  assert.equal((await barrier.status()).state, "reconciliation_required");
});

test("a degraded post-action capture fails closed", async (t) => {
  const { core, driver, barrier } = await fixture(t);
  driver.accessibilityAvailableAfterAction = false;
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);

  const result = await executeApproved(core, {
    operationKey: "degraded-post-action",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.reasonCode, "post_action_observation_failed");
  assert.equal(result.reconciliationRequired, true);
  assert.equal((await barrier.status()).state, "reconciliation_required");
});

test("an ambiguous dispatch is never retried and still attempts a post-action reobserve", async (t) => {
  const { core, driver, barrier } = await fixture(t);
  driver.throwOnAction = true;
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);

  const result = await executeApproved(core, {
    operationKey: "ambiguous-operation",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.reasonCode, "ambiguous_dispatch");
  assert.equal(result.safeToRetry, false);
  assert.equal(driver.actionCalls, 1);
  assert.equal(driver.stateReads, 3);
  assert.equal((await barrier.status()).state, "reconciliation_required");

  const duplicate = await executeApproved(core, {
    operationKey: "ambiguous-operation",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(duplicate.reasonCode, "ambiguous_dispatch");
  assert.equal(duplicate.reconciliationRequired, true);
  assert.equal(driver.actionCalls, 1);
});

test("consequential native actions require host authorization before reobserve", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-native-approval-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const driver = new NativeFixtureDriver();
  driver.elementLabel = "Continue";
  const core = new NativeComputerUseCore({
    driver,
    lease: new DesktopLease(directory),
    executionBarrier: new LiveExecutionBarrier(directory),
    safetyRuns: new RunStore(directory),
    operations: new NativeOperationStore(directory),
    runId: "native-approval-run",
  });
  t.after(async () => core.end().catch(() => undefined));
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);

  const result = await core.execute({
    operationKey: "approval-gated",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
    authorizeConsequentialAction: async () => ({ status: "declined" }),
  });
  assert.equal(result.outcome, "denied");
  assert.equal(result.reasonCode, "approval_declined");
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.safeToRetry, false);
  assert.equal(driver.stateReads, 1);
  assert.equal(driver.actionCalls, 0);
});

test("approval is consumed and the postcondition is rechecked before dispatch", async (t) => {
  const { core, driver } = await fixture(t);
  driver.preVerificationSequence = ["unsatisfied", "satisfied"];
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);
  let approvals = 0;

  const result = await core.execute({
    operationKey: "changed-during-approval",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
    authorizeConsequentialAction: async () => {
      approvals += 1;
      return { status: "approved" };
    },
  });

  assert.equal(result.outcome, "denied");
  assert.equal(result.reasonCode, "precondition_already_satisfied");
  assert.equal(result.safeToRetry, false);
  assert.equal(approvals, 1);
  assert.equal(driver.actionCalls, 0);
  assert.equal(driver.stateReads, 1);
  assert.deepEqual(
    await core.execute({
      operationKey: "changed-during-approval",
      observationId: observation.id,
      candidateId: button.id,
      action: { kind: "click" },
      verification,
      authorizeConsequentialAction: async () => {
        approvals += 1;
        return { status: "approved" };
      },
    }),
    result,
  );
  assert.equal(approvals, 1);
});

test("approved set_value stays on Accessibility, verifies the exact bound element, and persists no plaintext", async (t) => {
  const { core, driver, directory } = await fixture(t);
  const observation = await observeFixture(core);
  const field = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(field);
  assert.deepEqual(field.actionKinds, ["set_value"]);
  assert.equal(field.riskByAction.set_value, "r2_private");
  const value = "new-address@example.test";
  const valueVerification = Object.freeze({
    expect: Object.freeze([
      Object.freeze({
        element: Object.freeze({
          selector: Object.freeze({
            role: "AXTextField",
            labelContains: "Account email",
          }),
          valueEquals: value,
        }),
      }),
    ]),
    timeoutMs: 0,
    stableSamples: 2,
  });

  const result = await core.execute({
    operationKey: "set-value-once",
    observationId: observation.id,
    candidateId: field.id,
    action: { kind: "set_value", value },
    verification: valueVerification,
    authorizeConsequentialAction: async () => ({ status: "approved" }),
  });

  assert.equal(result.outcome, "verified");
  assert.equal(result.route, "accessibility");
  assert.equal(driver.actionCalls, 1);
  assert.equal(driver.stateReads, 4);
  const mutation = driver.calls.find((call) => call.tool === "set_value");
  assert.ok(mutation);
  assert.equal(mutation.arguments.value, value);
  assert.doesNotMatch(JSON.stringify(result), /new-address|example\.test/u);
  assert.doesNotMatch(await readFilesRecursively(directory), new RegExp(value));
});

test("set_value approval is consumed when the field changes during consent", async (t) => {
  const { core, driver } = await fixture(t);
  driver.preVerificationSequence = ["unsatisfied", "unsatisfied"];
  const observation = await observeFixture(core);
  const field = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(field);
  const value = "changed-during-consent";
  let approvals = 0;
  const input = {
    operationKey: "set-value-changed-during-consent",
    observationId: observation.id,
    candidateId: field.id,
    action: { kind: "set_value" as const, value },
    verification,
    authorizeConsequentialAction: async () => {
      approvals += 1;
      driver.textValue = value;
      return { status: "approved" as const };
    },
  };

  const result = await core.execute(input);
  assert.equal(result.reasonCode, "precondition_already_satisfied");
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.safeToRetry, false);
  assert.equal(driver.actionCalls, 0);
  assert.deepEqual(await core.execute(input), result);
  assert.equal(approvals, 1);
});

test("startup barrier-clear failure remains quarantined", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "jev-cua-native-startup-barrier-"),
  );
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const driver = new NativeFixtureDriver();
  driver.omitRequiredTool = true;
  const barrier = new LiveExecutionBarrier(directory);
  barrier.clear = async () => {
    throw new Error("fixture barrier clear failure");
  };
  const core = new NativeComputerUseCore({
    driver,
    lease: new DesktopLease(directory),
    executionBarrier: barrier,
    safetyRuns: new RunStore(directory),
    operations: new NativeOperationStore(directory),
    runId: "native-startup-barrier-failure",
  });

  await assert.rejects(core.listApps(), /required native Cua tool/u);
  const ended = await core.end();
  assert.equal(ended.cleanupSucceeded, false);
  assert.equal(ended.reconciliationRequired, true);
  assert.equal((await barrier.status()).state, "cleanup_unconfirmed");
});

test("startup lease-release failure is reported unsafe and retried by end", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "jev-cua-native-startup-lease-"),
  );
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const driver = new NativeFixtureDriver();
  driver.omitRequiredTool = true;
  let releaseAttempts = 0;
  const lease = {
    acquire: async () => async () => {
      releaseAttempts += 1;
      throw new Error("fixture lease release failure");
    },
  } as unknown as DesktopLease;
  const core = new NativeComputerUseCore({
    driver,
    lease,
    executionBarrier: new LiveExecutionBarrier(directory),
    safetyRuns: new RunStore(directory),
    operations: new NativeOperationStore(directory),
    runId: "native-startup-lease-failure",
  });

  await assert.rejects(core.listApps(), /required native Cua tool/u);
  const ended = await core.end();
  assert.equal(ended.cleanupSucceeded, false);
  assert.equal(ended.reconciliationRequired, true);
  assert.equal(releaseAttempts, 2);
});

test("a started core retries a transient desktop-lease release on repeated end", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-native-end-lease-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const driver = new NativeFixtureDriver();
  const barrier = new LiveExecutionBarrier(directory);
  let releaseAttempts = 0;
  const lease = {
    acquire: async () => async () => {
      releaseAttempts += 1;
      if (releaseAttempts === 1)
        throw new Error("fixture transient lease release failure");
    },
  } as unknown as DesktopLease;
  const core = new NativeComputerUseCore({
    driver,
    lease,
    executionBarrier: barrier,
    safetyRuns: new RunStore(directory),
    operations: new NativeOperationStore(directory),
    runId: "native-end-lease-retry",
  });

  await core.listApps();
  const first = await core.end();
  assert.equal(first.cleanupSucceeded, false);
  assert.equal(first.reconciliationRequired, true);
  const second = await core.end();
  assert.deepEqual(second, {
    cleanupSucceeded: true,
    reconciliationRequired: false,
  });
  assert.equal(releaseAttempts, 2);
  assert.deepEqual(await barrier.status(), { blocked: false });
  assert.equal(
    driver.calls.filter((call) => call.tool === "end_session").length,
    1,
  );
});

test("secure or unobservable text fields never publish a set-value action", async (t) => {
  const { core, driver } = await fixture(t);
  driver.textRole = "AXSecureTextField";
  let observation = await observeFixture(core);
  assert.equal(
    observation.candidates.some((candidate) =>
      candidate.actionKinds.includes("set_value"),
    ),
    false,
  );

  const ended = await core.end();
  assert.equal(ended.cleanupSucceeded, true);

  const second = await fixture(t);
  second.driver.textValue = null;
  observation = await observeFixture(second.core);
  assert.equal(
    observation.candidates.some((candidate) =>
      candidate.actionKinds.includes("set_value"),
    ),
    false,
  );
});

test("global menu items are never executable through the window click facade", async (t) => {
  const { core, driver } = await fixture(t);
  driver.elementRole = "AXMenuItem";
  driver.elementLabel = "Shut Down";
  const observation = await observeFixture(core);
  assert.equal(
    observation.candidates.some(
      (candidate) =>
        candidate.role === "AXMenuItem" &&
        candidate.actionKinds.includes("click"),
    ),
    false,
  );
});

test("a locally classified reversible click can run without an approval callback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-native-reversible-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const driver = new NativeFixtureDriver();
  driver.elementLabel = "1";
  const core = new NativeComputerUseCore({
    driver,
    lease: new DesktopLease(directory),
    executionBarrier: new LiveExecutionBarrier(directory),
    safetyRuns: new RunStore(directory),
    operations: new NativeOperationStore(directory),
    runId: "native-reversible-run",
  });
  t.after(async () => core.end().catch(() => undefined));
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);
  assert.equal(button.riskByAction.click, "r1_reversible");

  const result = await core.execute({
    operationKey: "reversible-click",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.outcome, "verified");
  assert.equal(driver.actionCalls, 1);
});

test("a safe-looking control in an unreviewed app is approval-gated", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-native-unreviewed-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const driver = new NativeFixtureDriver();
  driver.launchPath = "/Applications/Counterfeit Calculator.app";
  driver.elementLabel = "1";
  const core = new NativeComputerUseCore({
    driver,
    lease: new DesktopLease(directory),
    executionBarrier: new LiveExecutionBarrier(directory),
    safetyRuns: new RunStore(directory),
    operations: new NativeOperationStore(directory),
    runId: "native-unreviewed-run",
  });
  t.after(async () => core.end().catch(() => undefined));
  const observation = await observeFixture(core);
  const button = observation.candidates.find((candidate) =>
    candidate.actionKinds.includes("click"),
  );
  assert.ok(button);
  assert.equal(button.riskByAction.click, "r3_consequential");

  const result = await core.execute({
    operationKey: "unreviewed-click",
    observationId: observation.id,
    candidateId: button.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.outcome, "approval_required");
  assert.equal(driver.actionCalls, 0);
});
