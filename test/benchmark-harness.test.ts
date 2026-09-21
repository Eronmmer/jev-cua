import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  BENCHMARK_INPUTS,
  BENCHMARK_WORKFLOW_CONTRACT,
  assertNoInterruptedBenchmark,
  benchmarkRuntimeConfig,
  buildTrialPlan,
  createTrial,
  DEFAULT_BENCHMARK_OPTIONS,
  gitReproducibilityReasons,
  hasExactVerifiedLifecycle,
  parseBenchmarkArguments,
  runtimeArtifactReproducibilityReasons,
} from "../src/benchmark/harness.js";
import { BENCHMARK_FIXTURE } from "../src/benchmark/fixture.js";
import { RunStore } from "../src/state.js";
import {
  bindWorkflowInputs,
  loadWorkflowManifests,
} from "../src/workflows/manifest.js";
import type { RunResult } from "../src/types.js";

async function benchmarkResultsDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-benchmark-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writePriorReport(
  root: string,
  batchId: string,
  report: unknown,
): Promise<string> {
  const directory = join(root, batchId);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "report.json");
  const record =
    report && typeof report === "object" && !Array.isArray(report)
      ? (report as Record<string, unknown>)
      : {};
  const trialCount = Array.isArray(record.trials) ? record.trials.length : 0;
  await writeFile(
    path,
    JSON.stringify({
      schema: "jev-cua.benchmark-report.v2",
      batchId,
      plannedTrials: trialCount,
      completedTrials: trialCount,
      ...record,
    }),
    { mode: 0o600 },
  );
  return path;
}

async function writeCompletedPriorRun(
  root: string,
  batchId: string,
): Promise<void> {
  const store = new RunStore(join(root, batchId, "state"));
  const begun = await store.begin("prior-run-key", "request", "prior-run");
  await store.markPhase(begun.runKeyHash, "prior-run", "action_returned");
  await store.complete({
    runId: "prior-run",
    runKeyHash: begun.runKeyHash,
    outcome: "verified",
    reason: "isolated fixture verified",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    frontierFallbackRecommended: false,
    reconciliationRequired: true,
    safeToRetry: false,
    cleanupSucceeded: true,
  });
}

test("benchmark CLI options are pinned, bounded, and deterministic", () => {
  assert.deepEqual(parseBenchmarkArguments([]), DEFAULT_BENCHMARK_OPTIONS);
  assert.deepEqual(
    parseBenchmarkArguments([
      "--arm",
      "deterministic",
      "--pairs",
      "5",
      "--warmup-pairs",
      "1",
      "--seed",
      "review:v1",
    ]),
    {
      arm: "deterministic",
      pairs: 5,
      warmupPairs: 1,
      seed: "review:v1",
    },
  );
});

test("benchmark CLI options reject ambiguity and unsafe values", () => {
  for (const arguments_ of [
    ["--arm", "frontier"],
    ["--pairs", "0"],
    ["--pairs", "1.5"],
    ["--warmup-pairs", "21"],
    ["--seed", "../../escape"],
    ["--unknown", "value"],
    ["--pairs"],
  ]) {
    assert.throws(() => parseBenchmarkArguments(arguments_));
  }
});

test("benchmark controller settings ignore ambient tuning overrides", () => {
  const previous = process.env.JEV_CUA_PROVIDER_TIMEOUT_MS;
  process.env.JEV_CUA_PROVIDER_TIMEOUT_MS = "9999";
  try {
    const config = benchmarkRuntimeConfig();
    assert.equal(config.providerTimeoutMs, 1_500);
    assert.equal(config.maxCandidates, 24);
    assert.equal(config.labelMaxLength, 120);
    assert.equal(config.logLevel, "off");
  } finally {
    if (previous === undefined) delete process.env.JEV_CUA_PROVIDER_TIMEOUT_MS;
    else process.env.JEV_CUA_PROVIDER_TIMEOUT_MS = previous;
  }
});

test("single-arm schedules describe their actual execution position", () => {
  const plan = buildTrialPlan({
    arm: "deterministic",
    pairs: 2,
    warmupPairs: 0,
    seed: "single-arm",
  });
  assert.deepEqual(
    plan.map(({ sequence, runIndex, pairIndex, position, arm }) => ({
      sequence,
      runIndex,
      pairIndex,
      position,
      arm,
    })),
    [
      {
        sequence: 0,
        runIndex: 0,
        pairIndex: 0,
        position: 1,
        arm: "deterministic",
      },
      {
        sequence: 1,
        runIndex: 1,
        pairIndex: 1,
        position: 1,
        arm: "deterministic",
      },
    ],
  );
});

test("verified lifecycle requires exact ordered decisions, receipts, and postconditions", () => {
  const expected = [
    { semanticKey: "workflow:test:1:type", actionClass: "browser_type" },
    { semanticKey: "workflow:test:1:click", actionClass: "browser_click" },
  ] as const;
  const events = expected.flatMap((action, index) => {
    const step = index + 1;
    const operationId = `operation-${step}`;
    return [
      {
        event: "decision",
        step,
        gate: "execute",
        selected_action_class: action.actionClass,
      },
      {
        event: "action_started",
        step,
        operation_id: operationId,
        semantic_key: action.semanticKey,
        action_class: action.actionClass,
      },
      {
        event: "action_returned",
        step,
        operation_id: operationId,
      },
      {
        event: "postcondition_checked",
        step,
        operation_id: operationId,
        step_satisfied: true,
        workflow_satisfied: index === expected.length - 1,
      },
    ];
  });
  assert.equal(hasExactVerifiedLifecycle(events, expected), true);
  const altered = structuredClone(events);
  altered[7]!.workflow_satisfied = false;
  assert.equal(hasExactVerifiedLifecycle(altered, expected), false);
  assert.equal(
    hasExactVerifiedLifecycle([...events].reverse(), expected),
    false,
  );
});

test("a verified trial may recover from bounded read-only reobservation", () => {
  const expected = [
    {
      semanticKey: "workflow:catalog-search-benchmark:1:enter_search_query",
      actionClass: "browser_type",
    },
    {
      semanticKey: "workflow:catalog-search-benchmark:1:set_price_order",
      actionClass: "browser_click",
    },
    {
      semanticKey: "workflow:catalog-search-benchmark:1:enable_sale_filter",
      actionClass: "browser_click",
    },
  ] as const;
  const events = [
    {
      event: "decision",
      step: 1,
      gate: "reobserve",
      selected_action_class: "reobserve",
      input_tokens: 2,
      output_tokens: 1,
      decision_ms: 3,
    },
    ...expected.flatMap((action, index) => {
      const step = index + 2;
      const operationId = `operation-${step}`;
      return [
        {
          event: "decision",
          step,
          gate: "execute",
          selected_action_class: action.actionClass,
          input_tokens: 2,
          output_tokens: 1,
          decision_ms: 3,
        },
        {
          event: "action_started",
          step,
          operation_id: operationId,
          semantic_key: action.semanticKey,
          action_class: action.actionClass,
        },
        {
          event: "action_returned",
          step,
          operation_id: operationId,
          delivery_route:
            action.actionClass === "browser_type" ? "trusted_input" : "dom",
          delivery_effect: "unverifiable",
        },
        {
          event: "postcondition_checked",
          step,
          operation_id: operationId,
          step_satisfied: true,
          workflow_satisfied: index === expected.length - 1,
        },
      ];
    }),
    { event: "session_cleanup_succeeded" },
  ];
  const result: RunResult = {
    runId: "run-id",
    runKeyHash: "a".repeat(64),
    outcome: "verified",
    reason: "verified",
    steps: [1, 2, 3, 4].map((step) => ({
      step,
      candidateCount: 4,
      decisionMs: 1,
      actionMs: step === 1 ? 0 : 2,
      verificationMs: 1,
    })),
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    model: "jev-1.13.0",
    frontierFallbackRecommended: false,
    reconciliationRequired: false,
    safeToRetry: false,
    cleanupSucceeded: true,
  };
  const trial = createTrial(
    {
      sequence: 0,
      phase: "measured",
      runIndex: 0,
      pairIndex: 0,
      position: 1,
      arm: "jev",
    },
    result,
    events,
    1_000,
    result.startedAt,
    "jev-1.13.0",
    {
      url: `${BENCHMARK_FIXTURE.origin}${BENCHMARK_FIXTURE.pathname}`,
      version: BENCHMARK_FIXTURE.version,
      sha256: BENCHMARK_FIXTURE.sha256,
      bytes: 5_050,
      latencyMs: 10,
    },
  );
  assert.equal(trial.valid, true);
  assert.equal(trial.verified, true);
  assert.equal(trial.reobserveCount, 1);
  assert.equal(trial.decisionCount, 4);
  assert.equal(trial.actionCount, 3);
  assert.equal(trial.decisionValidationFailureCount, 0);
  assert.equal(trial.decisionMs, 12);
});

test("decision-validation failures retain known token usage", () => {
  const result: RunResult = {
    runId: "validation-failure-run",
    runKeyHash: "a".repeat(64),
    outcome: "unknown",
    reason: "local validation rejected the provider response",
    steps: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    model: "jev-1.13.0",
    frontierFallbackRecommended: true,
    reconciliationRequired: false,
    safeToRetry: false,
    cleanupSucceeded: true,
  };
  const trial = createTrial(
    {
      sequence: 0,
      phase: "measured",
      runIndex: 0,
      pairIndex: 0,
      position: 1,
      arm: "jev",
    },
    result,
    [
      {
        event: "decision_validation_failed",
        decision_ms: 7,
        input_tokens: 21,
        output_tokens: 8,
      },
      { event: "session_cleanup_succeeded" },
    ],
    100,
    result.startedAt,
    "jev-1.13.0",
    {
      url: `${BENCHMARK_FIXTURE.origin}${BENCHMARK_FIXTURE.pathname}`,
      version: BENCHMARK_FIXTURE.version,
      sha256: BENCHMARK_FIXTURE.sha256,
      bytes: 5_050,
      latencyMs: 10,
    },
  );

  assert.equal(trial.valid, true);
  assert.equal(trial.decisionCount, 1);
  assert.equal(trial.decisionValidationFailureCount, 1);
  assert.equal(trial.decisionMs, 7);
  assert.equal(trial.inputTokens, 21);
  assert.equal(trial.outputTokens, 8);
});

test("prior benchmark safety state must be resolved before a new batch", async (t) => {
  const root = await benchmarkResultsDirectory(t);
  await writePriorReport(root, "20260920000000000-11111111", {
    status: "stopped",
    requiresManualReview: false,
    measurementsValid: false,
    trials: [
      {
        reconciliationRequired: true,
        cleanupSucceeded: false,
        valid: true,
      },
    ],
  });
  await assert.rejects(
    assertNoInterruptedBenchmark(root),
    /unresolved cleanup or reconciliation/u,
  );
});

test("positive isolated cleanup resolves per-trial reconciliation", async (t) => {
  const root = await benchmarkResultsDirectory(t);
  const batchId = "20260920000000000-22222222";
  await writePriorReport(root, batchId, {
    status: "stopped",
    requiresManualReview: false,
    measurementsValid: false,
    trials: [
      {
        reconciliationRequired: true,
        cleanupSucceeded: true,
        valid: true,
      },
    ],
  });
  await writeCompletedPriorRun(root, batchId);
  await assert.doesNotReject(assertNoInterruptedBenchmark(root));
});

test("terminal report counters must match a complete durable run ledger", async (t) => {
  const missingRoot = await benchmarkResultsDirectory(t);
  await writePriorReport(missingRoot, "20260920000000007-88888888", {
    status: "complete",
    requiresManualReview: false,
    measurementsValid: true,
    trials: [
      {
        reconciliationRequired: false,
        cleanupSucceeded: true,
        valid: true,
      },
    ],
  });
  await assert.rejects(
    assertNoInterruptedBenchmark(missingRoot),
    /does not match its durable run ledger/u,
  );

  const activeRoot = await benchmarkResultsDirectory(t);
  const activeBatchId = "20260920000000008-99999999";
  await writePriorReport(activeRoot, activeBatchId, {
    status: "complete",
    requiresManualReview: false,
    measurementsValid: true,
    trials: [
      {
        reconciliationRequired: false,
        cleanupSucceeded: true,
        valid: true,
      },
    ],
  });
  await new RunStore(join(activeRoot, activeBatchId, "state")).begin(
    "active-prior-key",
    "request",
    "active-prior-run",
  );
  await assert.rejects(
    assertNoInterruptedBenchmark(activeRoot),
    /does not match its durable run ledger/u,
  );
});

test("running, malformed, and unsafe prior reports fail closed", async (t) => {
  const cases = [
    {
      status: "running",
      requiresManualReview: false,
      measurementsValid: null,
      trials: [],
    },
    {
      status: "invented",
      requiresManualReview: false,
      measurementsValid: false,
      trials: [],
    },
    {
      status: "complete",
      requiresManualReview: false,
      measurementsValid: true,
      trials: "not-an-array",
    },
  ];
  for (const [index, report] of cases.entries()) {
    const root = await benchmarkResultsDirectory(t);
    await writePriorReport(root, `2026092000000000${index}-33333333`, report);
    await assert.rejects(assertNoInterruptedBenchmark(root));
  }

  if (process.platform !== "win32") {
    const unsafeRoot = await benchmarkResultsDirectory(t);
    const report = await writePriorReport(
      unsafeRoot,
      "20260920000000003-44444444",
      {
        status: "complete",
        requiresManualReview: false,
        measurementsValid: true,
        trials: [],
      },
    );
    await chmod(report, 0o644);
    await assert.rejects(
      assertNoInterruptedBenchmark(unsafeRoot),
      /mode 0600/u,
    );

    const symlinkRoot = await benchmarkResultsDirectory(t);
    const target = join(symlinkRoot, "target.json");
    await writeFile(
      target,
      JSON.stringify({
        status: "complete",
        requiresManualReview: false,
        measurementsValid: true,
        trials: [],
      }),
      { mode: 0o600 },
    );
    const batch = join(symlinkRoot, "20260920000000004-55555555");
    await mkdir(batch, { mode: 0o700 });
    await symlink(target, join(batch, "report.json"));
    await assert.rejects(assertNoInterruptedBenchmark(symlinkRoot));
  }
});

test("manual-review and invalid-trial reports block later batches", async (t) => {
  const manualRoot = await benchmarkResultsDirectory(t);
  await writePriorReport(manualRoot, "20260920000000005-66666666", {
    status: "stopped",
    requiresManualReview: true,
    measurementsValid: false,
    trials: [],
  });
  await assert.rejects(
    assertNoInterruptedBenchmark(manualRoot),
    /requires manual review/u,
  );

  const invalidRoot = await benchmarkResultsDirectory(t);
  await writePriorReport(invalidRoot, "20260920000000006-77777777", {
    status: "stopped",
    requiresManualReview: false,
    measurementsValid: false,
    trials: [
      {
        reconciliationRequired: false,
        cleanupSucceeded: true,
        valid: false,
      },
    ],
  });
  await assert.rejects(
    assertNoInterruptedBenchmark(invalidRoot),
    /unresolved cleanup or reconciliation/u,
  );
});

test("git reproducibility checks distinguish clean, dirty, and changed source", () => {
  const clean = { gitCommit: "a".repeat(40), gitDirty: false } as const;
  assert.deepEqual(gitReproducibilityReasons(clean, clean), []);
  assert.deepEqual(gitReproducibilityReasons({ ...clean, gitDirty: true }), [
    "git_worktree_dirty",
  ]);
  assert.deepEqual(
    gitReproducibilityReasons({ gitCommit: null, gitDirty: null }),
    ["git_commit_unavailable", "git_worktree_status_unavailable"],
  );
  assert.deepEqual(
    gitReproducibilityReasons(clean, {
      gitCommit: "b".repeat(40),
      gitDirty: true,
    }),
    ["git_commit_changed_during_batch", "git_worktree_changed_during_batch"],
  );
});

test("runtime artifact reproducibility accepts Chrome first or Edge as a fallback", () => {
  const base = {
    node: "24.21.0",
    typeSafeSdkVersion: "0.6.0",
    typeSafeSdkEntrypointSha256: "d".repeat(64),
    packageLockSha256: "a".repeat(64),
    cuaExecutableSha256: "b".repeat(64),
  } as const;
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons({
      ...base,
      installedChromeVersion: "Google Chrome 140.0.0.0",
      chromeExecutableSha256: "c".repeat(64),
      installedEdgeVersion: null,
      edgeExecutableSha256: null,
    }),
    [],
  );
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons({
      ...base,
      installedChromeVersion: null,
      chromeExecutableSha256: null,
      installedEdgeVersion: "Microsoft Edge 140.0.0.0",
      edgeExecutableSha256: "e".repeat(64),
    }),
    [],
  );
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons({
      node: "24.21.0",
      typeSafeSdkVersion: "0.7.0",
      typeSafeSdkEntrypointSha256: null,
      packageLockSha256: null,
      cuaExecutableSha256: null,
      installedChromeVersion: null,
      chromeExecutableSha256: null,
      installedEdgeVersion: null,
      edgeExecutableSha256: null,
    }),
    [
      "typesafe_sdk_version_mismatch",
      "typesafe_sdk_entrypoint_digest_unavailable",
      "package_lock_digest_unavailable",
      "cua_executable_digest_unavailable",
      "trusted_chromium_executable_digest_unavailable",
    ],
  );
});

test("runtime artifact postcheck binds every browser present at precheck", () => {
  const initial = {
    node: "24.21.0",
    typeSafeSdkVersion: "0.6.0",
    typeSafeSdkEntrypointSha256: "a".repeat(64),
    packageLockSha256: "b".repeat(64),
    cuaExecutableSha256: "c".repeat(64),
    installedChromeVersion: "Google Chrome 140.0.0.0",
    chromeExecutableSha256: "d".repeat(64),
    installedEdgeVersion: "Microsoft Edge 140.0.0.0",
    edgeExecutableSha256: "e".repeat(64),
  } as const;
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons(initial, {
      ...initial,
      node: "25.0.0",
      typeSafeSdkEntrypointSha256: "f".repeat(64),
      packageLockSha256: null,
      chromeExecutableSha256: null,
      edgeExecutableSha256: "0".repeat(64),
    }),
    [
      "node_runtime_changed_during_batch",
      "typesafe_sdk_entrypoint_changed_during_batch",
      "package_lock_postcheck_digest_unavailable",
      "chrome_executable_disappeared_during_batch",
      "edge_executable_changed_during_batch",
    ],
  );
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons(initial, {
      ...initial,
      chromeExecutableSha256: "0".repeat(64),
      edgeExecutableSha256: null,
    }),
    [
      "chrome_executable_changed_during_batch",
      "edge_executable_disappeared_during_batch",
    ],
  );

  const chromeOnly = {
    ...initial,
    installedEdgeVersion: null,
    edgeExecutableSha256: null,
  } as const;
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons(chromeOnly, chromeOnly),
    [],
  );
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons(chromeOnly, {
      ...chromeOnly,
      installedEdgeVersion: "Microsoft Edge 140.0.0.0",
      edgeExecutableSha256: "f".repeat(64),
    }),
    ["edge_executable_added_during_batch", "edge_version_changed_during_batch"],
  );

  assert.deepEqual(
    runtimeArtifactReproducibilityReasons(initial, {
      ...initial,
      installedChromeVersion: "Google Chrome 141.0.0.0",
      installedEdgeVersion: "Microsoft Edge 141.0.0.0",
    }),
    [
      "chrome_version_changed_during_batch",
      "edge_version_changed_during_batch",
    ],
  );

  const edgeOnly = {
    ...initial,
    installedChromeVersion: null,
    chromeExecutableSha256: null,
  } as const;
  assert.deepEqual(
    runtimeArtifactReproducibilityReasons(edgeOnly, {
      ...edgeOnly,
      edgeExecutableSha256: null,
    }),
    ["edge_executable_disappeared_during_batch"],
  );
});

test("benchmark harness contract exactly matches the checked-in workflow", async () => {
  const workflows = await loadWorkflowManifests(
    benchmarkRuntimeConfig().workflowDirectory,
  );
  const matches = workflows.filter(
    (workflow) =>
      workflow.enabled &&
      workflow.id === BENCHMARK_WORKFLOW_CONTRACT.id &&
      workflow.version === BENCHMARK_WORKFLOW_CONTRACT.version &&
      workflow.digest === BENCHMARK_WORKFLOW_CONTRACT.digest,
  );
  assert.equal(matches.length, 1);
  const invocation = bindWorkflowInputs(matches[0]!, BENCHMARK_INPUTS);
  assert.equal(invocation.workflow.target.kind, "isolated");
  if (invocation.workflow.target.kind !== "isolated") {
    assert.fail("benchmark workflow must use an isolated target");
  }
  assert.equal(
    invocation.workflow.target.startUrl,
    `${BENCHMARK_FIXTURE.origin}${BENCHMARK_FIXTURE.pathname}`,
  );
  assert.deepEqual(
    Object.fromEntries(
      invocation.values.map((value) => [value.id, value.value]),
    ),
    BENCHMARK_INPUTS,
  );
});
