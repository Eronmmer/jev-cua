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
  DriverCallResult,
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
  "launch_app",
  "zoom",
  "click",
  "type_text",
  "set_value",
  "press_key",
  "scroll",
  "invoke_menu",
  "verify_state",
] as const;

function visualPng(width = 640, height = 480, revision = 0): Buffer {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = revision;
  return bytes;
}

function visualJpeg(width = 276, height = 288): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

class NativeFixtureDriver implements DriverClient {
  readonly calls: Array<{
    tool: string;
    arguments: Record<string, JsonValue>;
  }> = [];
  connected = false;
  stateReads = 0;
  actionCalls = 0;
  launchCalls = 0;
  appPid: number = TARGET.pid;
  appRunning = true;
  bundleId: string = TARGET.bundleId;
  launchPath = "/System/Applications/Calculator.app";
  elementRole = "AXButton";
  elementLabel = "Approve fixture";
  textRole = "AXTextField";
  textValue: string | null = "private@example.test";
  appMenuRootLabel = "Fixture";
  menuRootLabel = "View";
  includeMenuTree = false;
  duplicateMenuLeaf = false;
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
  visualRevision = 0;
  visualChangesAfterClick = true;
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
            running: this.appRunning,
            active: false,
            pid: this.appRunning ? this.appPid : 0,
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
    if (tool === "launch_app") {
      this.launchCalls += 1;
      this.appRunning = true;
      this.appPid = 789;
      return {
        bundle_id: this.bundleId,
        name: "Fixture App",
        pid: this.appPid,
        launch_state: {
          requested: true,
          process_running: true,
          window_ready: true,
        },
        self_activation_suppressed: true,
      };
    }
    if (tool === "get_window_state") {
      this.stateReads += 1;
      const elements: Array<Record<string, JsonValue>> = [
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
      ];
      if (this.includeMenuTree) {
        elements.push(
          {
            element_index: 20,
            element_token: `menu-bar-${this.stateReads}`,
            role: "AXMenuBar",
            label: null,
            value: null,
            actions: [],
            enabled: true,
            selected: false,
            parent_index: null,
          },
          {
            element_index: 21,
            element_token: `apple-root-${this.stateReads}`,
            role: "AXMenuBarItem",
            label: "Apple",
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 20,
          },
          {
            element_index: 22,
            element_token: `apple-menu-${this.stateReads}`,
            role: "AXMenu",
            label: "Apple",
            value: null,
            actions: [],
            enabled: true,
            selected: false,
            parent_index: 21,
          },
          {
            element_index: 23,
            element_token: `shutdown-${this.stateReads}`,
            role: "AXMenuItem",
            label: "Shut Down\u2026",
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 22,
          },
          {
            element_index: 28,
            element_token: `app-root-${this.stateReads}`,
            role: "AXMenuBarItem",
            label: this.appMenuRootLabel,
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 20,
          },
          {
            element_index: 29,
            element_token: `app-menu-${this.stateReads}`,
            role: "AXMenu",
            label: this.appMenuRootLabel,
            value: null,
            actions: [],
            enabled: true,
            selected: false,
            parent_index: 28,
          },
          {
            element_index: 30,
            element_token: `localized-quit-${this.stateReads}`,
            role: "AXMenuItem",
            label: "Beenden",
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 29,
          },
          {
            element_index: 24,
            element_token: `menu-root-${this.stateReads}`,
            role: "AXMenuBarItem",
            label: this.menuRootLabel,
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 20,
          },
          {
            element_index: 25,
            element_token: `view-menu-${this.stateReads}`,
            role: "AXMenu",
            label: this.menuRootLabel,
            value: null,
            actions: [],
            enabled: true,
            selected: false,
            parent_index: 24,
          },
          {
            element_index: 26,
            element_token: `sidebar-item-${this.stateReads}`,
            role: "AXMenuItem",
            label: "Show Sidebar",
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 25,
          },
          {
            element_index: 27,
            element_token: `services-item-${this.stateReads}`,
            role: "AXMenuItem",
            label: "Services",
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 25,
          },
        );
        if (this.duplicateMenuLeaf) {
          elements.push({
            element_index: 31,
            element_token: `sidebar-item-duplicate-${this.stateReads}`,
            role: "AXMenuItem",
            label: "Show Sidebar",
            value: null,
            actions: ["AXPress"],
            enabled: true,
            selected: false,
            parent_index: 25,
          });
        }
      }
      return {
        pid: this.appPid,
        window_id: TARGET.windowId,
        snapshot_id: `s0000000${this.stateReads}`,
        element_count: elements.length,
        returned_element_count: elements.length,
        total_element_count: elements.length,
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
        elements,
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
      if (tool === "type_text" && typeof arguments_.text === "string")
        this.textValue = arguments_.text;
      if (
        tool === "click" &&
        arguments_.from_zoom === true &&
        this.visualChangesAfterClick
      )
        this.visualRevision += 1;
      return {
        effect: "unverifiable",
        route:
          (tool === "click" && arguments_.from_zoom !== true) ||
          tool === "set_value" ||
          tool === "invoke_menu"
            ? "accessibility"
            : "synthetic_events",
        delivery: {
          mode:
            (tool === "click" && arguments_.from_zoom !== true) ||
            tool === "set_value" ||
            tool === "invoke_menu"
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

  async callWithContent(
    tool: string,
    arguments_: Record<string, JsonValue>,
  ): Promise<DriverCallResult> {
    this.calls.push({ tool, arguments: structuredClone(arguments_) });
    if (tool === "get_window_state") {
      const bytes = visualPng(640, 480, this.visualRevision);
      return {
        structuredContent: {
          pid: this.appPid,
          window_id: TARGET.windowId,
          screenshot_frame_valid: true,
          screenshot_width: 640,
          screenshot_height: 480,
          screenshot_mime_type: "image/png",
        },
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: bytes.toString("base64"),
          },
        ],
      };
    }
    if (tool === "zoom") {
      const bytes = visualJpeg();
      return {
        structuredContent: {
          format: "jpeg",
          mime_type: "image/jpeg",
          width: 276,
          height: 288,
        },
        images: [
          {
            type: "image",
            mimeType: "image/jpeg",
            data: bytes.toString("base64"),
          },
        ],
      };
    }
    throw new Error(`unexpected fixture content tool: ${tool}`);
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

test("exact stopped app launch is background-only, verified, and at-most-once", async (t) => {
  const { core, driver } = await fixture(t);
  driver.appRunning = false;
  driver.appPid = 0;
  const apps = await core.listApps();
  const app = apps[0];
  assert.ok(app);
  assert.equal(app.running, false);
  const first = await core.launchApp({
    appRef: app.appRef,
    operationKey: "launch-fixture-once",
  });
  assert.equal(first.outcome, "verified");
  assert.equal(first.reasonCode, "app_launched");
  assert.equal(first.app?.running, true);
  assert.equal(first.app?.appRef, app.appRef);
  assert.equal(driver.launchCalls, 1);
  const launch = driver.calls.find((call) => call.tool === "launch_app");
  assert.deepEqual(launch?.arguments, { bundle_id: TARGET.bundleId });

  const replay = await core.launchApp({
    appRef: app.appRef,
    operationKey: "launch-fixture-once",
  });
  assert.deepEqual(replay, first);
  assert.equal(driver.launchCalls, 1);
  const windows = await core.listWindows({ appRef: app.appRef });
  assert.equal(windows.length, 1);
});

test("visual grid clicks keep coordinates local and require semantic verification", async (t) => {
  const { core, driver } = await fixture(t);
  const apps = await core.listApps();
  const app = apps.find((candidate) => candidate.name === "Fixture App");
  assert.ok(app);
  const windows = await core.listWindows({ appRef: app.appRef });
  const window = windows[0];
  assert.ok(window);

  const overview = await core.observeVisual({ windowRef: window.windowRef });
  assert.equal(overview.image.mimeType, "image/png");
  assert.equal(overview.regions.length, 64);
  assert.deepEqual(
    [
      ...new Set(overview.regions.flatMap((region) => Object.keys(region))),
    ].sort(),
    ["id", "label"],
  );
  const detail = await core.refineVisual({
    overviewId: overview.id,
    regionId: overview.regions[0]!.id,
  });
  assert.equal(detail.image.mimeType, "image/jpeg");
  assert.equal(detail.observation.candidateCount, 64);
  const cell = detail.observation.candidates[0];
  assert.ok(cell);
  assert.equal(cell.targetKind, "visual_cell");
  assert.equal(cell.riskByAction.click, "r3_consequential");
  for (const candidate of detail.observation.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), [
      "actionKinds",
      "enabled",
      "id",
      "label",
      "riskByAction",
      "role",
      "selected",
      "targetKind",
      "untrustedText",
      "valuePresent",
    ]);
  }

  const result = await executeApproved(core, {
    operationKey: "visual-click-once",
    observationId: detail.observation.id,
    candidateId: cell.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.outcome, "verified");
  const click = driver.calls.find(
    (call) => call.tool === "click" && call.arguments.from_zoom === true,
  );
  assert.ok(click);
  assert.equal(typeof click.arguments.x, "number");
  assert.equal(typeof click.arguments.y, "number");
  assert.equal(click.arguments.element_token, undefined);
  assert.equal(click.arguments.delivery_mode, "background");
  assert.equal(driver.calls.filter((call) => call.tool === "zoom").length, 2);
});

test("visual click refuses a changed screenshot before dispatch", async (t) => {
  const { core, driver } = await fixture(t);
  const apps = await core.listApps();
  const app = apps[0];
  assert.ok(app);
  const windows = await core.listWindows({ appRef: app.appRef });
  const window = windows[0];
  assert.ok(window);
  const overview = await core.observeVisual({ windowRef: window.windowRef });
  const detail = await core.refineVisual({
    overviewId: overview.id,
    regionId: overview.regions[0]!.id,
  });
  driver.visualRevision = 1;
  const result = await executeApproved(core, {
    operationKey: "visual-stale-no-click",
    observationId: detail.observation.id,
    candidateId: detail.observation.candidates[0]!.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.reasonCode, "stale_observation");
  assert.equal(result.mutationAttempted, false);
  assert.equal(
    driver.calls.some((call) => call.tool === "click"),
    false,
  );
});

test("a visual click is refused when its semantic precondition is unobservable", async (t) => {
  const { core, driver } = await fixture(t);
  driver.preVerificationStatus = "unknown";
  const apps = await core.listApps();
  const windows = await core.listWindows({ appRef: apps[0]!.appRef });
  const overview = await core.observeVisual({
    windowRef: windows[0]!.windowRef,
  });
  const detail = await core.refineVisual({
    overviewId: overview.id,
    regionId: overview.regions[0]!.id,
  });
  const result = await executeApproved(core, {
    operationKey: "visual-no-ax-change",
    observationId: detail.observation.id,
    candidateId: detail.observation.candidates[0]!.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.reasonCode, "precondition_unknown");
  assert.equal(result.mutationAttempted, false);
  assert.equal(driver.actionCalls, 0);
});

test("a visual click is refuted when its semantic postcondition is unsatisfied", async (t) => {
  const { core, driver } = await fixture(t);
  driver.visualChangesAfterClick = false;
  driver.verificationStatus = "unsatisfied";
  const apps = await core.listApps();
  const windows = await core.listWindows({ appRef: apps[0]!.appRef });
  const overview = await core.observeVisual({
    windowRef: windows[0]!.windowRef,
  });
  const detail = await core.refineVisual({
    overviewId: overview.id,
    regionId: overview.regions[0]!.id,
  });
  const result = await executeApproved(core, {
    operationKey: "visual-no-change",
    observationId: detail.observation.id,
    candidateId: detail.observation.candidates[0]!.id,
    action: { kind: "click" },
    verification,
  });
  assert.equal(result.outcome, "refuted");
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.safeToRetry, false);
});

test("visual pixel change is not accepted as a verification predicate", async (t) => {
  const { core, driver } = await fixture(t);
  const apps = await core.listApps();
  const windows = await core.listWindows({ appRef: apps[0]!.appRef });
  const overview = await core.observeVisual({
    windowRef: windows[0]!.windowRef,
  });
  const detail = await core.refineVisual({
    overviewId: overview.id,
    regionId: overview.regions[0]!.id,
  });

  await assert.rejects(
    executeApproved(core, {
      operationKey: "visual-pixel-change-not-proof",
      observationId: detail.observation.id,
      candidateId: detail.observation.candidates[0]!.id,
      action: { kind: "click" },
      verification: {
        expect: [{ visual: { changed: true } }],
        timeoutMs: 0,
        stableSamples: 2,
      } as never,
    }),
    /native element predicate is invalid/u,
  );
  assert.equal(driver.actionCalls, 0);
});

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
  assert.deepEqual(field.actionKinds, ["set_value", "type_text", "press_key"]);
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

test("approved type_text stays bound to the freshly observed non-secure text control", async (t) => {
  const { core, driver, directory } = await fixture(t);
  const observation = await observeFixture(core);
  const field = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(field);
  assert.equal(field.actionKinds.includes("type_text"), true);
  assert.equal(field.riskByAction.type_text, "r2_private");
  const text = "bounded fixture text";
  const typeVerification = Object.freeze({
    expect: Object.freeze([
      Object.freeze({
        element: Object.freeze({
          selector: Object.freeze({
            role: "AXTextField",
            labelContains: "Account email",
          }),
          valueEquals: text,
        }),
      }),
    ]),
    timeoutMs: 0,
    stableSamples: 2,
  });

  const result = await executeApproved(core, {
    operationKey: "type-text-once",
    observationId: observation.id,
    candidateId: field.id,
    action: { kind: "type_text", text },
    verification: typeVerification,
  });

  assert.equal(result.outcome, "verified");
  assert.equal(result.route, "synthetic_events");
  const mutation = driver.calls.find((call) => call.tool === "type_text");
  assert.ok(mutation);
  assert.equal(mutation.arguments.element_token, "private-text-token-2");
  assert.equal(mutation.arguments.text, text);
  assert.equal(mutation.arguments.delivery_mode, "background");
  assert.doesNotMatch(await readFilesRecursively(directory), new RegExp(text));
});

test("type_text cannot use an unrelated postcondition as proof of insertion", async (t) => {
  const { core, driver } = await fixture(t);
  const observation = await observeFixture(core);
  const field = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(field);
  const result = await executeApproved(core, {
    operationKey: "type-text-unrelated-proof",
    observationId: observation.id,
    candidateId: field.id,
    action: { kind: "type_text", text: "must not dispatch" },
    verification,
  });
  assert.equal(result.outcome, "denied");
  assert.equal(result.reasonCode, "verification_mismatch");
  assert.equal(result.mutationAttempted, false);
  assert.equal(driver.actionCalls, 0);
});

test("window and eligible controls expose only approval-aware bounded key delivery", async (t) => {
  const { core, driver } = await fixture(t);
  const observation = await observeFixture(core);
  const window = observation.candidates.find(
    (candidate) => candidate.targetKind === "window",
  );
  const field = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(window);
  assert.ok(field);
  assert.equal(window.actionKinds.includes("press_key"), true);
  assert.equal(window.riskByAction.press_key, "r1_reversible");
  assert.equal(field.actionKinds.includes("press_key"), true);

  const result = await core.execute({
    operationKey: "press-safe-key",
    observationId: observation.id,
    candidateId: window.id,
    action: { kind: "press_key", key: "escape" },
    verification,
  });

  assert.equal(result.outcome, "verified");
  const mutation = driver.calls.find((call) => call.tool === "press_key");
  assert.ok(mutation);
  assert.equal(mutation.arguments.key, "escape");
  assert.equal(mutation.arguments.element_token, undefined);
  assert.equal(mutation.arguments.delivery_mode, "background");
});

test("exact menu paths remain local, exclude unsafe branches, and cannot be caller-substituted", async (t) => {
  const { core, driver } = await fixture(t);
  driver.includeMenuTree = true;
  const observation = await observeFixture(core);
  const menuItem = observation.candidates.find(
    (candidate) => candidate.label === "View > Show Sidebar",
  );
  assert.ok(menuItem);
  assert.deepEqual(menuItem.actionKinds, ["invoke_menu"]);
  assert.equal(menuItem.riskByAction.invoke_menu, "r3_consequential");
  assert.equal(menuItem.label, "View > Show Sidebar");
  assert.equal(
    observation.candidates.some(
      (candidate) =>
        candidate.label === "Shut Down\u2026" || candidate.label === "Services",
    ),
    false,
  );
  assert.equal("path" in menuItem, false);

  await assert.rejects(
    core.execute({
      operationKey: "caller-path-must-not-win",
      observationId: observation.id,
      candidateId: menuItem.id,
      action: {
        kind: "invoke_menu",
        path: ["File", "Delete"],
      } as never,
      verification,
    }),
    /native menu path is invalid/u,
  );
  assert.equal(driver.actionCalls, 0);

  const result = await executeApproved(core, {
    operationKey: "invoke-exact-menu",
    observationId: observation.id,
    candidateId: menuItem.id,
    action: { kind: "invoke_menu" },
    verification,
  });
  assert.equal(result.outcome, "verified");
  const mutation = driver.calls.find((call) => call.tool === "invoke_menu");
  assert.ok(mutation);
  assert.deepEqual(mutation.arguments.path, ["View", "Show Sidebar"]);
  assert.equal(mutation.arguments.element_token, undefined);
});

test("the application menu is omitted structurally despite an inventory-name mismatch", async (t) => {
  const { core, driver } = await fixture(t);
  driver.includeMenuTree = true;
  driver.appMenuRootLabel = "Localized Alias";
  const observation = await observeFixture(core);
  assert.equal(
    observation.candidates.some(
      (candidate) => candidate.label === "Localized Alias > Beenden",
    ),
    false,
  );
  assert.equal(
    observation.candidates.some(
      (candidate) => candidate.label === "View > Show Sidebar",
    ),
    true,
  );
});

test("menu invocation refuses a changed ancestor path before dispatch", async (t) => {
  const { core, driver } = await fixture(t);
  driver.includeMenuTree = true;
  const observation = await observeFixture(core);
  const menuItem = observation.candidates.find(
    (candidate) => candidate.label === "View > Show Sidebar",
  );
  assert.ok(menuItem);
  driver.menuRootLabel = "Format";

  const result = await executeApproved(core, {
    operationKey: "stale-menu-path",
    observationId: observation.id,
    candidateId: menuItem.id,
    action: { kind: "invoke_menu" },
    verification,
  });
  assert.equal(result.reasonCode, "stale_observation");
  assert.equal(result.mutationAttempted, false);
  assert.equal(driver.actionCalls, 0);
});

test("menu invocation refuses a path that becomes ambiguous before dispatch", async (t) => {
  const { core, driver } = await fixture(t);
  driver.includeMenuTree = true;
  const observation = await observeFixture(core);
  const menuItem = observation.candidates.find(
    (candidate) => candidate.label === "View > Show Sidebar",
  );
  assert.ok(menuItem);
  driver.duplicateMenuLeaf = true;

  const result = await executeApproved(core, {
    operationKey: "ambiguous-menu-path",
    observationId: observation.id,
    candidateId: menuItem.id,
    action: { kind: "invoke_menu" },
    verification,
  });
  assert.equal(result.reasonCode, "stale_observation");
  assert.equal(result.mutationAttempted, false);
  assert.equal(driver.actionCalls, 0);
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
