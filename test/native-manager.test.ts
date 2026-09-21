import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeManagerError,
  NativeRunManager,
  type NativeCoreFacade,
  type NativePublicAction,
} from "../src/native/manager.js";
import type {
  NativeAction,
  NativeApprovalGate,
  NativeCandidate,
  NativeEndResult,
  NativeObservation,
  NativeVerification,
} from "../src/native/types.js";

const VERIFICATION: NativeVerification = Object.freeze({
  expect: Object.freeze([
    Object.freeze({ window: Object.freeze({ exists: true }) }),
  ]),
  timeoutMs: 0,
  stableSamples: 1,
});

const WINDOW_CANDIDATE: NativeCandidate = Object.freeze({
  id: "core-window-candidate-private",
  targetKind: "window",
  role: "AXWindow",
  valuePresent: false,
  actionKinds: Object.freeze(["press_key", "scroll", "invoke_menu"] as const),
  riskByAction: Object.freeze({
    press_key: "r1_reversible",
    scroll: "r1_reversible",
    invoke_menu: "r1_reversible",
  }),
  untrustedText: true,
});

const SAFE_BUTTON: NativeCandidate = Object.freeze({
  id: "core-safe-candidate-private",
  targetKind: "element",
  role: "AXButton",
  label: "1",
  valuePresent: false,
  enabled: true,
  selected: false,
  actionKinds: Object.freeze(["click", "press_key", "scroll"] as const),
  riskByAction: Object.freeze({
    click: "r1_reversible",
    press_key: "r1_reversible",
    scroll: "r1_reversible",
  }),
  untrustedText: true,
});

const CONSEQUENTIAL_BUTTON: NativeCandidate = Object.freeze({
  id: "core-send-candidate-private",
  targetKind: "element",
  role: "AXButton",
  label: "Continue",
  valuePresent: false,
  enabled: true,
  actionKinds: Object.freeze(["click"] as const),
  riskByAction: Object.freeze({ click: "r3_consequential" }),
  untrustedText: true,
});

const TEXT_FIELD: NativeCandidate = Object.freeze({
  id: "core-text-candidate-private",
  targetKind: "element",
  role: "AXTextField",
  label: "Account email",
  valuePresent: true,
  enabled: true,
  actionKinds: Object.freeze(["type_text", "set_value"] as const),
  riskByAction: Object.freeze({
    type_text: "r2_private",
    set_value: "r2_private",
  }),
  untrustedText: true,
});

const FORBIDDEN_BUTTON: NativeCandidate = Object.freeze({
  id: "core-delete-candidate-private",
  targetKind: "element",
  role: "AXButton",
  label: "Delete account",
  valuePresent: false,
  enabled: true,
  actionKinds: Object.freeze(["click"] as const),
  riskByAction: Object.freeze({ click: "r4_forbidden" }),
  untrustedText: true,
});

function defaultObservation(): NativeObservation {
  const candidates = Object.freeze([
    WINDOW_CANDIDATE,
    SAFE_BUTTON,
    CONSEQUENTIAL_BUTTON,
    TEXT_FIELD,
    FORBIDDEN_BUTTON,
  ]);
  return Object.freeze({
    id: "core-observation-private",
    target: Object.freeze({ windowRef: "core-window-private" }),
    complete: true,
    actionable: true,
    candidateCount: candidates.length,
    candidates,
    untrustedUiData: true,
  });
}

class FakeCore implements NativeCoreFacade {
  readonly executions: Array<{
    operationKey: string;
    observationId: string;
    candidateId: string;
    action: NativeAction;
    verification: NativeVerification;
  }> = [];
  endCalls = 0;
  observation = defaultObservation();
  failListApps = false;
  failListWindows = false;
  failObserve = false;
  cleanupSucceeded = true;
  reconciliationRequired = false;
  throwOnEnd = false;
  throwOnExecute = false;
  quarantineCalls = 0;
  endResults: NativeEndResult[] | undefined;

  async listApps() {
    if (this.failListApps)
      throw new Error("private app inventory implementation detail");
    return Object.freeze([
      Object.freeze({
        appRef: "core-app-private",
        bundleId: "com.private.Fixture",
        name: "Fixture App",
        running: true,
        active: false,
        untrustedText: true as const,
      }),
      Object.freeze({
        appRef: "core-stopped-app-private",
        bundleId: "com.private.StoppedFixture",
        name: "Stopped Fixture",
        running: false,
        active: false,
        untrustedText: true as const,
      }),
    ]);
  }

  async listWindows(input: Readonly<{ appRef: string }>) {
    assert.equal(input.appRef, "core-app-private");
    if (this.failListWindows)
      throw new Error("private list-windows implementation detail");
    return Object.freeze([
      Object.freeze({
        appRef: "core-app-private",
        windowRef: "core-window-private",
        title: "Fixture Window",
        onScreen: true,
        onCurrentSpace: true,
        minimized: false,
        untrustedText: true as const,
      }),
    ]);
  }

  async observe(target: Readonly<{ windowRef: string }>) {
    assert.equal(target.windowRef, "core-window-private");
    if (this.failObserve)
      throw new Error("private observe implementation detail");
    return this.observation;
  }

  async execute(
    input: Readonly<{
      operationKey: string;
      observationId: string;
      candidateId: string;
      action: NativeAction;
      verification: NativeVerification;
      authorizeConsequentialAction?: NativeApprovalGate;
    }>,
  ) {
    const { authorizeConsequentialAction, ...record } = input;
    this.executions.push(structuredClone(record));
    if (this.throwOnExecute)
      throw new Error("private uncertain execution implementation detail");
    if (authorizeConsequentialAction) {
      const risk =
        input.action.kind === "set_value" ? "r2_private" : "r3_consequential";
      const decision = await authorizeConsequentialAction({
        runId: "core-run-private",
        operationKey: input.operationKey,
        target: { windowRef: "core-window-private" },
        actionKind: input.action.kind,
        risk,
      });
      if (decision.status !== "approved") {
        return Object.freeze({
          outcome: "approval_required" as const,
          reasonCode: "approval_declined" as const,
          mutationAttempted: false,
          reconciliationRequired: false,
          safeToRetry: false,
          replayed: false,
        });
      }
    }
    return Object.freeze({
      outcome: "verified" as const,
      reasonCode: "verified" as const,
      mutationAttempted: true,
      reconciliationRequired: false,
      safeToRetry: false,
      replayed: false,
      effect: "confirmed" as const,
      route: "accessibility" as const,
    });
  }

  async quarantine() {
    this.quarantineCalls += 1;
  }

  async end() {
    this.endCalls += 1;
    if (this.throwOnEnd)
      throw new Error("private cleanup implementation detail");
    const scripted = this.endResults?.shift();
    if (scripted) return Object.freeze({ ...scripted });
    return Object.freeze({
      cleanupSucceeded: this.cleanupSucceeded,
      reconciliationRequired: this.reconciliationRequired,
    });
  }
}

async function started(manager: NativeRunManager) {
  const start = await manager.start();
  const app = start.apps[0];
  assert.ok(app);
  const windows = await manager.listWindows({
    runRef: start.runRef,
    appRef: app.appRef,
  });
  const window = windows[0];
  assert.ok(window);
  return { start, app, window };
}

function actionWith(
  actions: readonly NativePublicAction[],
  predicate: (action: NativePublicAction) => boolean,
): NativePublicAction & Readonly<{ actionRef: string }> {
  const action = actions.find(predicate);
  assert.ok(action);
  assert.equal(action.availability, "allowed");
  assert.ok(action.actionRef);
  return action as NativePublicAction & Readonly<{ actionRef: string }>;
}

test("native manager publishes only opaque capabilities and binds a fixed AXPress click", async () => {
  const core = new FakeCore();
  const manager = new NativeRunManager({ createCore: () => core });
  const { start, app, window } = await started(manager);

  assert.match(start.runRef, /^nrun_/u);
  assert.equal(start.apps.length, 1);
  assert.match(app.appRef, /^napp_/u);
  assert.match(window.windowRef, /^nwin_/u);
  await assert.rejects(
    manager.start(),
    /native computer-use run is already active/u,
  );

  const observation = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  assert.match(observation.observationRef, /^nobs_/u);
  assert.equal(observation.complete, true);
  assert.equal(observation.actionable, true);
  assert.equal(observation.candidateCount, 5);
  assert.equal(
    observation.candidates.every((candidate) =>
      /^npcand_/u.test(candidate.candidateRef),
    ),
    true,
  );

  const windowCandidate = observation.candidates.find(
    (candidate) => candidate.targetKind === "window",
  );
  assert.ok(windowCandidate);
  assert.equal(
    windowCandidate.actions.some((action) => action.kind === "press_key"),
    false,
  );
  assert.equal(
    windowCandidate.actions.filter(
      (action) => action.kind === "scroll" && action.actionRef,
    ).length,
    2,
  );
  assert.equal(
    windowCandidate.actions.some((action) => action.kind === "invoke_menu"),
    false,
  );

  const safe = observation.candidates.find(
    (candidate) => candidate.label === "1",
  );
  assert.ok(safe);
  assert.equal(
    safe.actions.some(
      (action) => action.kind === "press_key" || action.kind === "scroll",
    ),
    false,
  );
  const click = actionWith(safe.actions, (action) => action.kind === "click");

  const consequential = observation.candidates.find(
    (candidate) => candidate.label === "Continue",
  );
  assert.ok(consequential);
  assert.equal(consequential.actions.length, 1);
  assert.equal(consequential.actions[0]?.kind, "click");
  assert.equal(consequential.actions[0]?.availability, "approval_required");
  assert.match(consequential.actions[0]?.actionRef ?? "", /^nact_/u);

  const text = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(text);
  assert.equal(text.actions.length, 2);
  const setValue = text.actions.find((action) => action.kind === "set_value");
  assert.equal(setValue?.availability, "approval_required");
  assert.match(setValue?.actionRef ?? "", /^nact_/u);
  const syntheticText = text.actions.find(
    (action) => action.kind === "type_text",
  );
  assert.equal(syntheticText?.availability, "not_exposed");
  assert.equal(syntheticText?.actionRef, undefined);

  const forbidden = observation.candidates.find(
    (candidate) => candidate.label === "Delete account",
  );
  assert.ok(forbidden);
  assert.equal(forbidden.actions[0]?.availability, "denied");
  assert.equal(forbidden.actions[0]?.actionRef, undefined);

  const serialized = JSON.stringify({ start, window, observation });
  assert.doesNotMatch(
    serialized,
    /bundleId|com\.private|core-app|core-window|core-observation|core-safe-candidate|candidateId|element_token|snapshot|coordinates|"activation"|"direction"|"amount"|"key"/u,
  );

  const result = await manager.step({
    runRef: start.runRef,
    operationKey: "fixed-click-once",
    observationRef: observation.observationRef,
    actionRef: click.actionRef,
    verification: VERIFICATION,
  });
  assert.equal(result.outcome, "verified");
  assert.deepEqual(core.executions, [
    {
      operationKey: "fixed-click-once",
      observationId: "core-observation-private",
      candidateId: "core-safe-candidate-private",
      action: { kind: "click", activation: "press" },
      verification: VERIFICATION,
    },
  ]);
  assert.deepEqual(
    await manager.step({
      runRef: start.runRef,
      operationKey: "fixed-click-once",
      observationRef: observation.observationRef,
      actionRef: click.actionRef,
      verification: VERIFICATION,
    }),
    result,
  );
  assert.equal(core.executions.length, 1);
  await assert.rejects(
    manager.step({
      runRef: start.runRef,
      operationKey: "must-not-replay",
      observationRef: observation.observationRef,
      actionRef: click.actionRef,
      verification: VERIFICATION,
    }),
    /native action reference is stale or invalid/u,
  );

  const ended = await manager.end({ runRef: start.runRef });
  assert.deepEqual(ended, {
    cleanupSucceeded: true,
    reconciliationRequired: false,
  });
  assert.deepEqual(await manager.end({ runRef: start.runRef }), ended);
  assert.equal(core.endCalls, 1);
});

test("native manager binds one-shot approval to exact click and non-sensitive set-value actions", async () => {
  const core = new FakeCore();
  const manager = new NativeRunManager({ createCore: () => core });
  const { start, window } = await started(manager);
  const contexts: unknown[] = [];
  const authorize = async (context: unknown) => {
    contexts.push(structuredClone(context));
    return { status: "approved" as const };
  };

  let observation = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const consequential = observation.candidates.find(
    (candidate) => candidate.label === "Continue",
  );
  assert.ok(consequential);
  const click = consequential.actions.find((action) => action.kind === "click");
  assert.equal(click?.availability, "approval_required");
  assert.ok(click?.actionRef);

  const clickResult = await manager.step({
    runRef: start.runRef,
    operationKey: "approved-click-once",
    observationRef: observation.observationRef,
    actionRef: click.actionRef,
    verification: VERIFICATION,
    authorize,
  });
  assert.equal(clickResult.outcome, "verified");
  assert.deepEqual(contexts[0], {
    runRef: start.runRef,
    observationRef: observation.observationRef,
    actionRef: click.actionRef,
    operationFingerprint: (contexts[0] as { operationFingerprint: string })
      .operationFingerprint,
    actionKind: "click",
    risk: "r3_consequential",
    appLabel: "Fixture App",
    windowLabel: "Fixture Window",
    controlRole: "AXButton",
    controlLabel: "Continue",
    untrustedUiData: true,
  });
  assert.match(
    (contexts[0] as { operationFingerprint: string }).operationFingerprint,
    /^[a-f0-9]{16}$/u,
  );

  observation = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const textCandidate = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(textCandidate);
  const setValue = textCandidate.actions.find(
    (action) => action.kind === "set_value",
  );
  assert.equal(setValue?.availability, "approval_required");
  assert.ok(setValue?.actionRef);
  const value = "hello from the guarded native path";
  const textResult = await manager.step({
    runRef: start.runRef,
    operationKey: "approved-text-once",
    observationRef: observation.observationRef,
    actionRef: setValue.actionRef,
    verification: VERIFICATION,
    text: value,
    authorize,
  });
  assert.equal(textResult.outcome, "verified");
  assert.equal((contexts[1] as { text: string }).text, value);
  assert.equal((contexts[1] as { actionKind: string }).actionKind, "set_value");
  assert.deepEqual(core.executions.at(-1)?.action, {
    kind: "set_value",
    value,
  });
  assert.doesNotMatch(JSON.stringify(textResult), /hello from/u);

  await manager.shutdown();
});

test("native manager rejects recognizable credentials before approval or execution", async () => {
  const core = new FakeCore();
  const manager = new NativeRunManager({ createCore: () => core });
  const { start, window } = await started(manager);
  const observation = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const textCandidate = observation.candidates.find(
    (candidate) => candidate.role === "AXTextField",
  );
  assert.ok(textCandidate);
  const setValue = textCandidate.actions.find(
    (action) => action.kind === "set_value",
  );
  assert.ok(setValue?.actionRef);
  let approvals = 0;

  await assert.rejects(
    manager.step({
      runRef: start.runRef,
      operationKey: "reject-recognizable-credential",
      observationRef: observation.observationRef,
      actionRef: setValue.actionRef,
      verification: VERIFICATION,
      text: "apikey_0123456789abcdef0123456789abcdef",
      authorize: async () => {
        approvals += 1;
        return { status: "approved" };
      },
    }),
    /rejects recognizable credentials/u,
  );
  assert.equal(approvals, 0);
  assert.equal(core.executions.length, 0);
  await manager.shutdown();
});

test("an unexpected core exception quarantines and detaches the native run", async () => {
  const core = new FakeCore();
  core.throwOnExecute = true;
  const manager = new NativeRunManager({ createCore: () => core });
  const { start, window } = await started(manager);
  const observation = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const safe = observation.candidates.find(
    (candidate) => candidate.label === "1",
  );
  assert.ok(safe);
  const click = actionWith(safe.actions, (action) => action.kind === "click");

  const result = await manager.step({
    runRef: start.runRef,
    operationKey: "core-threw-uncertain",
    observationRef: observation.observationRef,
    actionRef: click.actionRef,
    verification: VERIFICATION,
  });
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.safeToRetry, false);
  assert.equal(core.quarantineCalls, 1);
  assert.equal(core.endCalls, 1);
  await assert.rejects(
    manager.observe({
      runRef: start.runRef,
      windowRef: window.windowRef,
    }),
    /native run reference is stale or invalid/u,
  );
  assert.deepEqual(await manager.end({ runRef: start.runRef }), {
    cleanupSucceeded: true,
    reconciliationRequired: true,
  });
});

test("native manager fixes scroll arguments locally and invalidates stale observations", async () => {
  const core = new FakeCore();
  const manager = new NativeRunManager({ createCore: () => core });
  const { start, app, window } = await started(manager);

  const first = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const firstWindow = first.candidates.find(
    (candidate) => candidate.targetKind === "window",
  );
  assert.ok(firstWindow);
  const firstScroll = actionWith(
    firstWindow.actions,
    (action) => action.description === "Scroll down 3 lines",
  );
  await assert.rejects(
    manager.step({
      runRef: start.runRef,
      operationKey: "wrong-observation",
      observationRef: "nobs_wrong",
      actionRef: firstScroll.actionRef,
      verification: VERIFICATION,
    }),
    /native action reference is stale or invalid/u,
  );
  const second = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const secondWindow = second.candidates.find(
    (candidate) => candidate.targetKind === "window",
  );
  assert.ok(secondWindow);
  const scroll = actionWith(
    secondWindow.actions,
    (action) => action.description === "Scroll down 3 lines",
  );
  await manager.step({
    runRef: start.runRef,
    operationKey: "scroll-once",
    observationRef: second.observationRef,
    actionRef: scroll.actionRef,
    verification: VERIFICATION,
  });
  assert.deepEqual(core.executions[0]?.action, {
    kind: "scroll",
    direction: "down",
    by: "line",
    amount: 3,
  });

  const third = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const thirdSafe = third.candidates.find(
    (candidate) => candidate.label === "1",
  );
  assert.ok(thirdSafe);
  const thirdClick = actionWith(
    thirdSafe.actions,
    (action) => action.kind === "click",
  );
  await manager.listWindows({ runRef: start.runRef, appRef: app.appRef });
  await assert.rejects(
    manager.step({
      runRef: start.runRef,
      operationKey: "stale-after-window-refresh",
      observationRef: third.observationRef,
      actionRef: thirdClick.actionRef,
      verification: VERIFICATION,
    }),
    /native action reference is stale or invalid/u,
  );
  await manager.shutdown();
});

test("failed reads preserve previously issued capabilities and redact core errors", async () => {
  const core = new FakeCore();
  const manager = new NativeRunManager({ createCore: () => core });
  const { start, app, window } = await started(manager);
  const first = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const firstSafe = first.candidates.find(
    (candidate) => candidate.label === "1",
  );
  assert.ok(firstSafe);
  const firstClick = actionWith(
    firstSafe.actions,
    (action) => action.kind === "click",
  );

  core.failListWindows = true;
  await assert.rejects(
    manager.listWindows({ runRef: start.runRef, appRef: app.appRef }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "native window inventory could not be read");
      assert.doesNotMatch(error.message, /private|implementation/u);
      return true;
    },
  );
  await manager.step({
    runRef: start.runRef,
    operationKey: "preserved-after-window-read-failure",
    observationRef: first.observationRef,
    actionRef: firstClick.actionRef,
    verification: VERIFICATION,
  });

  core.failListWindows = false;
  const second = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });
  const secondSafe = second.candidates.find(
    (candidate) => candidate.label === "1",
  );
  assert.ok(secondSafe);
  const secondClick = actionWith(
    secondSafe.actions,
    (action) => action.kind === "click",
  );
  core.failObserve = true;
  await assert.rejects(
    manager.observe({
      runRef: start.runRef,
      windowRef: window.windowRef,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "native window could not be observed");
      assert.doesNotMatch(error.message, /private|implementation/u);
      return true;
    },
  );
  await manager.step({
    runRef: start.runRef,
    operationKey: "preserved-after-observation-read-failure",
    observationRef: second.observationRef,
    actionRef: secondClick.actionRef,
    verification: VERIFICATION,
  });
  assert.equal(core.executions.length, 2);
  await manager.shutdown();
});

test("startup failure reports unsafe cleanup without retaining internal details", async () => {
  const core = new FakeCore();
  core.failListApps = true;
  core.cleanupSucceeded = false;
  core.reconciliationRequired = true;
  const manager = new NativeRunManager({ createCore: () => core });

  await assert.rejects(manager.start(), (error: unknown) => {
    assert.ok(error instanceof NativeManagerError);
    assert.equal(error.reconciliationRequired, true);
    assert.equal(
      error.message,
      "native computer-use startup cleanup requires reconciliation",
    );
    assert.doesNotMatch(
      `${error.message}${JSON.stringify(error)}`,
      /private|implementation|inventory detail/u,
    );
    return true;
  });
  assert.equal(core.endCalls, 2);
});

test("native manager bounds published candidates and executable action handles", async () => {
  const core = new FakeCore();
  const candidates = Object.freeze(
    Array.from(
      { length: 101 },
      (_, index): NativeCandidate =>
        Object.freeze({
          ...WINDOW_CANDIDATE,
          id: `core-window-candidate-${index}`,
        }),
    ),
  );
  core.observation = Object.freeze({
    ...defaultObservation(),
    candidateCount: candidates.length,
    candidates,
  });
  const manager = new NativeRunManager({ createCore: () => core });
  const { start, window } = await started(manager);
  const observation = await manager.observe({
    runRef: start.runRef,
    windowRef: window.windowRef,
  });

  assert.equal(observation.complete, false);
  assert.equal(observation.candidateCount, 100);
  assert.equal(
    observation.candidates
      .flatMap((candidate) => candidate.actions)
      .filter((action) => action.actionRef).length,
    128,
  );
  assert.equal(
    observation.candidates.some((candidate) =>
      candidate.actions.some((action) => action.availability === "not_exposed"),
    ),
    true,
  );
  await manager.shutdown();
});

test("a failed end is conservative and remains retryable", async () => {
  const core = new FakeCore();
  core.throwOnEnd = true;
  const manager = new NativeRunManager({ createCore: () => core });
  const start = await manager.start();

  const first = await manager.end({ runRef: start.runRef });
  assert.deepEqual(first, {
    cleanupSucceeded: false,
    reconciliationRequired: true,
  });
  assert.deepEqual(await manager.end({ runRef: start.runRef }), first);
  assert.equal(core.endCalls, 4);
});

test("native manager retries a transient core cleanup before caching end", async () => {
  const core = new FakeCore();
  core.endResults = [
    { cleanupSucceeded: false, reconciliationRequired: true },
    { cleanupSucceeded: true, reconciliationRequired: false },
  ];
  const manager = new NativeRunManager({ createCore: () => core });
  const start = await manager.start();

  const ended = await manager.end({ runRef: start.runRef });
  assert.deepEqual(ended, {
    cleanupSucceeded: true,
    reconciliationRequired: false,
  });
  assert.deepEqual(await manager.end({ runRef: start.runRef }), ended);
  assert.equal(core.endCalls, 2);
});

test("native manager expires an idle run and shutdown is idempotent", async () => {
  const cores: FakeCore[] = [];
  const manager = new NativeRunManager({
    createCore: () => {
      const core = new FakeCore();
      cores.push(core);
      return core;
    },
    idleTtlMs: 10,
  });
  const first = await manager.start();

  const deadline = Date.now() + 1_000;
  while (cores[0]?.endCalls !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(cores[0]?.endCalls, 1);
  await assert.rejects(
    manager.listWindows({
      runRef: first.runRef,
      appRef: first.apps[0]!.appRef,
    }),
    /native run reference is stale or invalid/u,
  );

  await manager.start();
  await manager.shutdown();
  await manager.shutdown();
  assert.equal(cores[1]?.endCalls, 1);
});
