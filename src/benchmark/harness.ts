import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, release, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadRuntimeConfig } from "../config.js";
import {
  loadTypeSafeCredential,
  type TypeSafeCredential,
} from "../credentials.js";
import { CuaMcpClient, resolveCuaDriverBinary } from "../cua/client.js";
import { assertCuaReady, probeCuaReadiness } from "../cua/readiness.js";
import {
  DeterministicDecisionPolicy,
  DETERMINISTIC_DECISION_MODEL,
} from "../jev/deterministic-policy.js";
import { TypeSafeDecisionPolicy } from "../jev/typesafe-policy.js";
import { createCompiledWorkflowRuntime } from "../runtime/workflow-controller.js";
import {
  DesktopLease,
  JsonlTraceSink,
  LiveExecutionBarrier,
  RunStore,
} from "../state.js";
import type {
  DecisionPolicy,
  JsonValue,
  Outcome,
  RunResult,
  TraceSink,
} from "../types.js";
import {
  bindWorkflowInputs,
  loadWorkflowManifests,
} from "../workflows/manifest.js";
import {
  BENCHMARK_FIXTURE,
  verifyBenchmarkFixture,
  type FixtureVerification,
} from "./fixture.js";
import {
  buildBalancedSchedule,
  summarizeBenchmark,
  type BenchmarkArm,
  type BenchmarkScheduleEntry,
  type BenchmarkSummary,
} from "./metrics.js";

const execFile = promisify(execFileCallback);
const moduleRequire = createRequire(import.meta.url);
const REPOSITORY_ROOT = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const EXPECTED_TYPESAFE_SDK_VERSION = "0.6.0";
const CHROME_EXECUTABLE =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EDGE_EXECUTABLE =
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
export const BENCHMARK_WORKFLOW_CONTRACT = Object.freeze({
  id: "catalog-search-benchmark",
  version: 1,
  digest: "c1197a152d221e964dd97888a965395c90af787540984a15fc9dddf1f8c7d770",
});
export const BENCHMARK_INPUTS = Object.freeze({
  search_query: "chicken",
  sort_state: "price_low",
  completion_state: "complete",
});
const MAX_STEPS = 6;
const MAX_WALL_TIME_MS = 120_000;

export type BenchmarkArmSelection = BenchmarkArm | "both";

export type RuntimeArtifactSnapshot = Readonly<{
  node: string;
  typeSafeSdkVersion: string | null;
  typeSafeSdkEntrypointSha256: string | null;
  packageLockSha256: string | null;
  cuaExecutableSha256: string | null;
  installedChromeVersion: string | null;
  chromeExecutableSha256: string | null;
  installedEdgeVersion: string | null;
  edgeExecutableSha256: string | null;
}>;

export type BenchmarkOptions = Readonly<{
  arm: BenchmarkArmSelection;
  pairs: number;
  warmupPairs: number;
  seed: string;
}>;

export const DEFAULT_BENCHMARK_OPTIONS: BenchmarkOptions = Object.freeze({
  arm: "both",
  pairs: 30,
  warmupPairs: 3,
  seed: "catalog-search-v1",
});

export type PlannedTrial = BenchmarkScheduleEntry &
  Readonly<{
    phase: "warmup" | "measured";
    sequence: number;
  }>;

export type BenchmarkTrial = Readonly<{
  sequence: number;
  phase: "warmup" | "measured";
  pairIndex: number;
  position: 1 | 2;
  arm: BenchmarkArm;
  outcome: Outcome;
  verified: boolean;
  latencyMs: number;
  decisionMs: number;
  actionMs: number;
  verificationMs: number;
  decisionCount: number;
  actionCount: number;
  reobserveCount: number;
  providerFailureCount: number;
  decisionValidationFailureCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  unknownUsageRequestCount: number;
  stepCount: number;
  model: string | null;
  deliveryRoutes: readonly string[];
  deliveryEffects: readonly string[];
  valid: boolean;
  invalidReasons: readonly string[];
  reason: string;
  reconciliationRequired: boolean;
  isolationCleanupResolvedReconciliation: boolean;
  safeToRetry: boolean;
  cleanupSucceeded: boolean;
  fixtureVerification: FixtureVerification;
  startedAt: string;
  finishedAt: string;
}>;

export type BenchmarkReport = Readonly<{
  schema: "jev-cua.benchmark-report.v2";
  status: "running" | "complete" | "stopped";
  requiresManualReview: boolean;
  measurementsValid: boolean | null;
  measurementInvalidReasons: readonly string[];
  batchId: string;
  startedAt: string;
  finishedAt: string | null;
  options: BenchmarkOptions;
  fixture: FixtureVerification;
  fixturePostcheck: FixtureVerification | null;
  sourcePostcheck: Readonly<{
    gitCommit: string | null;
    gitDirty: boolean | null;
  }> | null;
  runtimePostcheck: RuntimeArtifactSnapshot | null;
  workflow: Readonly<{
    id: string;
    version: number;
    digest: string;
    steps: number;
  }>;
  environment: Readonly<{
    node: string;
    platform: string;
    release: string;
    architecture: string;
    macosVersion: string | null;
    installedChromeVersion: string | null;
    chromeExecutableSha256: string | null;
    installedEdgeVersion: string | null;
    edgeExecutableSha256: string | null;
    cuaVersion: string;
    cuaExecutableSha256: string | null;
    cuaTools: number;
    gitCommit: string | null;
    gitDirty: boolean | null;
    typeSafeSdkVersion: string | null;
    typeSafeSdkEntrypointSha256: string | null;
    packageLockSha256: string | null;
    typeSafeCredentialSource: "environment" | "keychain" | "missing";
  }>;
  controller: Readonly<{
    maxSteps: number;
    maxWallTimeMs: number;
    providerTimeoutMs: number;
    maxCandidates: number;
    labelMaxLength: number;
    thresholds: Readonly<{
      minimumProbability: number;
      minimumConfidence: number;
      minimumMargin: number;
      minimumFit: number;
    }>;
    policyIdentities: Readonly<Record<BenchmarkArm, string>>;
    policyFingerprints: Readonly<Record<BenchmarkArm, string>>;
  }>;
  schedule: readonly PlannedTrial[];
  plannedTrials: number;
  completedTrials: number;
  trials: readonly BenchmarkTrial[];
  warmupSummary: BenchmarkSummary;
  measuredSummary: BenchmarkSummary;
  stopReason: string | null;
}>;

export type BenchmarkProgress = Readonly<{
  completed: number;
  total: number;
  trial: BenchmarkTrial;
}>;

export type TraceEvent = Readonly<Record<string, JsonValue>>;

class BenchmarkTraceSink implements TraceSink {
  private readonly events = new Map<string, TraceEvent[]>();

  constructor(private readonly durable: TraceSink) {}

  async append(runId: string, event: TraceEvent): Promise<void> {
    await this.durable.append(runId, event);
    const runEvents = this.events.get(runId) ?? [];
    runEvents.push(structuredClone(event));
    this.events.set(runId, runEvents);
  }

  take(runId: string): readonly TraceEvent[] {
    const result = this.events.get(runId) ?? [];
    this.events.delete(runId);
    return Object.freeze(result.map((event) => Object.freeze(event)));
  }
}

export function parseBenchmarkArguments(
  arguments_: readonly string[],
): BenchmarkOptions {
  let arm = DEFAULT_BENCHMARK_OPTIONS.arm;
  let pairs = DEFAULT_BENCHMARK_OPTIONS.pairs;
  let warmupPairs = DEFAULT_BENCHMARK_OPTIONS.warmupPairs;
  let seed = DEFAULT_BENCHMARK_OPTIONS.seed;

  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${flag ?? "benchmark option"}`);
    }
    if (flag === "--arm") {
      if (value !== "jev" && value !== "deterministic" && value !== "both") {
        throw new Error("--arm must be jev, deterministic, or both");
      }
      arm = value;
    } else if (flag === "--pairs") {
      pairs = parseBoundedInteger(value, "--pairs", 1, 100);
    } else if (flag === "--warmup-pairs") {
      warmupPairs = parseBoundedInteger(value, "--warmup-pairs", 0, 20);
    } else if (flag === "--seed") {
      if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
        throw new Error(
          "--seed must contain 1-128 letters, digits, dots, underscores, colons, or hyphens",
        );
      }
      seed = value;
    } else {
      throw new Error(`unknown benchmark option: ${flag}`);
    }
    index += 1;
  }

  return Object.freeze({ arm, pairs, warmupPairs, seed });
}

export async function runBenchmark(
  options: BenchmarkOptions,
  onProgress?: (progress: BenchmarkProgress) => void,
  signal?: AbortSignal,
): Promise<Readonly<{ report: BenchmarkReport; reportPath: string }>> {
  validateOptions(options);
  signal?.throwIfAborted();

  // A missing credential must fail before creating result state or launching a
  // browser. The key itself is never copied into metadata or a subprocess.
  const credential: TypeSafeCredential =
    options.arm === "jev" || options.arm === "both"
      ? await loadTypeSafeCredential()
      : Object.freeze({ source: "missing" as const });
  if ((options.arm === "jev" || options.arm === "both") && !credential.apiKey) {
    throw new Error(
      "TypeSafe API key is required for the Jev arm; store it in macOS Keychain service ai.typesafe.jev-cua",
    );
  }

  const config = benchmarkRuntimeConfig();
  const fixture = await verifyBenchmarkFixture();
  const workflows = await loadWorkflowManifests(config.workflowDirectory);
  const matches = workflows.filter(
    (workflow) =>
      workflow.enabled &&
      workflow.id === BENCHMARK_WORKFLOW_CONTRACT.id &&
      workflow.version === BENCHMARK_WORKFLOW_CONTRACT.version &&
      workflow.digest === BENCHMARK_WORKFLOW_CONTRACT.digest,
  );
  if (matches.length !== 1) {
    throw new Error(
      "the exact pinned catalog benchmark workflow is not uniquely enabled",
    );
  }
  const invocation = bindWorkflowInputs(matches[0]!, BENCHMARK_INPUTS);

  const binary = await resolveCuaDriverBinary();
  const driver = new CuaMcpClient(binary);
  let reportPath: string | undefined;
  let releaseBatchLease: (() => Promise<void>) | undefined;
  try {
    const initialReadiness = await probeCuaReadiness(binary, driver);
    assertCuaReady(initialReadiness);
    if (
      !initialReadiness.driverVersion ||
      initialReadiness.driverTools === null
    ) {
      throw new Error("Cua readiness omitted required benchmark metadata");
    }

    const batchId = createBatchId();
    const resultsRoot = join(REPOSITORY_ROOT, "benchmark-results");
    const batchDirectory = join(resultsRoot, batchId);
    await ensurePrivateDirectory(resultsRoot);
    const batchLease = new DesktopLease(join(resultsRoot, ".batch-lease"));
    releaseBatchLease = await batchLease.acquire(batchId);
    await assertNoInterruptedBenchmark(resultsRoot);
    await createPrivateDirectory(batchDirectory);
    const batchReportPath = join(batchDirectory, "report.json");
    reportPath = batchReportPath;

    const schedule = buildTrialPlan(options);
    const traces = new BenchmarkTraceSink(
      new JsonlTraceSink(join(batchDirectory, "state")),
    );
    const trustedRuntimeState = join(
      userInfo().homedir,
      ".local",
      "state",
      "jev-cua-runtime",
    );
    const lease = new DesktopLease(trustedRuntimeState);
    const safetyRuns = new RunStore(trustedRuntimeState);
    const executionBarrier = new LiveExecutionBarrier(trustedRuntimeState);
    const runs = new RunStore(join(batchDirectory, "state"));
    const policies: Readonly<Record<BenchmarkArm, DecisionPolicy>> = {
      deterministic: new DeterministicDecisionPolicy(),
      jev: TypeSafeDecisionPolicy.create(
        credential.apiKey ?? "unreachable-missing-key",
        config,
      ),
    };
    const identities: Readonly<Record<BenchmarkArm, string>> = {
      deterministic: DETERMINISTIC_DECISION_MODEL,
      jev: config.model,
    };
    const runtimes = {
      deterministic: createCompiledWorkflowRuntime({
        driver,
        policy: policies.deterministic,
        decisionPolicyIdentity: identities.deterministic,
        config,
        lease,
        runs,
        safetyRuns,
        executionBarrier,
        isolatedCleanupResolvesReconciliation: true,
        traces,
        workflow: invocation.workflow,
        values: invocation.values,
      }),
      jev: createCompiledWorkflowRuntime({
        driver,
        policy: policies.jev,
        decisionPolicyIdentity: identities.jev,
        config,
        lease,
        runs,
        safetyRuns,
        executionBarrier,
        isolatedCleanupResolvesReconciliation: true,
        traces,
        workflow: invocation.workflow,
        values: invocation.values,
      }),
    } as const;
    if (
      runtimes.jev.policyFingerprint ===
      runtimes.deterministic.policyFingerprint
    ) {
      throw new Error("benchmark policy fingerprints are not distinct");
    }
    const policyFingerprints = Object.freeze({
      deterministic: runtimes.deterministic.policyFingerprint,
      jev: runtimes.jev.policyFingerprint,
    });
    const trials: BenchmarkTrial[] = [];
    const startedAt = new Date().toISOString();
    const environment = await collectEnvironment(
      binary,
      initialReadiness.driverVersion,
      initialReadiness.driverTools,
      credential.source,
    );
    const measurementInvalidReasons: string[] = [];
    measurementInvalidReasons.push(
      ...gitReproducibilityReasons(environment),
      ...runtimeArtifactReproducibilityReasons(environment),
    );
    let fixturePostcheck: FixtureVerification | null = null;
    let sourcePostcheck: Readonly<{
      gitCommit: string | null;
      gitDirty: boolean | null;
    }> | null = null;
    let runtimePostcheck: RuntimeArtifactSnapshot | null = null;
    let requiresManualReview = false;
    let measurementsValid: boolean | null =
      measurementInvalidReasons.length === 0 ? null : false;

    const buildReport = (
      status: BenchmarkReport["status"],
      stopReason: string | null,
    ): BenchmarkReport => {
      const summaryTrials =
        measurementsValid === false
          ? []
          : trials.filter((trial) => trial.valid);
      const measured = summaryTrials.filter(
        (trial) => trial.phase === "measured",
      );
      return Object.freeze({
        schema: "jev-cua.benchmark-report.v2",
        status,
        requiresManualReview,
        measurementsValid,
        measurementInvalidReasons: Object.freeze([
          ...measurementInvalidReasons,
        ]),
        batchId,
        startedAt,
        finishedAt: status === "running" ? null : new Date().toISOString(),
        options: Object.freeze({ ...options }),
        fixture,
        fixturePostcheck,
        sourcePostcheck,
        runtimePostcheck,
        workflow: Object.freeze({
          id: invocation.workflow.id,
          version: invocation.workflow.version,
          digest: invocation.workflow.digest,
          steps: invocation.workflow.steps.length,
        }),
        environment,
        controller: Object.freeze({
          maxSteps: MAX_STEPS,
          maxWallTimeMs: MAX_WALL_TIME_MS,
          providerTimeoutMs: config.providerTimeoutMs,
          maxCandidates: config.maxCandidates,
          labelMaxLength: config.labelMaxLength,
          thresholds: Object.freeze({ ...config.thresholds }),
          policyIdentities: identities,
          policyFingerprints,
        }),
        schedule,
        plannedTrials: schedule.length,
        completedTrials: trials.length,
        trials: Object.freeze([...trials]),
        warmupSummary: summarizeBenchmark(
          summaryTrials
            .filter((trial) => trial.phase === "warmup")
            .map((trial) => ({
              pairIndex: trial.pairIndex,
              arm: trial.arm,
              outcome: trial.outcome,
              latencyMs: trial.latencyMs,
            })),
        ),
        measuredSummary: summarizeBenchmark(
          measured.map((trial) => ({
            pairIndex: trial.pairIndex,
            arm: trial.arm,
            outcome: trial.outcome,
            latencyMs: trial.latencyMs,
          })),
        ),
        stopReason,
      });
    };

    const invalidateMeasurements = (...reasons: readonly string[]): void => {
      measurementsValid = false;
      for (const reason of reasons) {
        if (!measurementInvalidReasons.includes(reason)) {
          measurementInvalidReasons.push(reason);
        }
      }
    };
    const stop = async (
      reason: string,
      invalidReasons: readonly string[],
      manualReview = false,
    ): Promise<Readonly<{ report: BenchmarkReport; reportPath: string }>> => {
      invalidateMeasurements(...invalidReasons);
      if (manualReview) requiresManualReview = true;
      const stopped = buildReport("stopped", reason);
      await writePrivateJsonAtomic(batchReportPath, stopped);
      return Object.freeze({ report: stopped, reportPath: batchReportPath });
    };

    if (measurementInvalidReasons.length > 0) {
      return await stop(
        "Benchmark source or installed runtime artifacts are not reproducible; no browser trial was launched.",
        measurementInvalidReasons,
      );
    }

    await writePrivateJsonAtomic(batchReportPath, buildReport("running", null));

    for (const planned of schedule) {
      if (signal?.aborted) {
        return await stop(
          "Benchmark cancellation was requested; no later trial was launched.",
          ["batch_cancelled"],
        );
      }
      let trialFixtureVerification: FixtureVerification;
      try {
        trialFixtureVerification = await verifyBenchmarkFixture();
      } catch (error: unknown) {
        return await stop(
          `The pinned fixture failed verification immediately before a trial (${error instanceof Error ? error.name : "UnknownError"}); no browser was launched.`,
          ["fixture_pretrial_verification_failed"],
        );
      }
      let readiness: Awaited<ReturnType<typeof probeCuaReadiness>>;
      try {
        readiness = await probeCuaReadiness(binary, driver);
        assertCuaReady(readiness);
      } catch (error: unknown) {
        return await stop(
          `Cua readiness failed between trials (${error instanceof Error ? error.name : "UnknownError"}); no later trial was launched.`,
          ["cua_readiness_failed"],
        );
      }
      if (
        readiness.driverVersion !== initialReadiness.driverVersion ||
        readiness.driverTools !== initialReadiness.driverTools
      ) {
        return await stop(
          "Cua runtime metadata changed between trials; no later trial was launched.",
          ["cua_runtime_metadata_changed"],
          true,
        );
      }
      const runtime = runtimes[planned.arm];
      const runKey = [
        "benchmark",
        batchId,
        planned.phase,
        planned.pairIndex,
        planned.position,
        planned.arm,
      ].join(":");
      const trialStartedAt = new Date().toISOString();
      const monotonicStart = performance.now();
      let result: RunResult;
      try {
        result = await runtime.controller.run(
          runtime.createRequest({
            runKey,
            mode: "live",
            maxSteps: MAX_STEPS,
            maxWallTimeMs: MAX_WALL_TIME_MS,
          }),
          signal,
        );
      } catch (error: unknown) {
        return await stop(
          `Benchmark execution stopped with ${error instanceof Error ? error.name : "UnknownError"}; inspect the durable ledger before any retry.`,
          ["controller_exception"],
          true,
        );
      }
      const latencyMs = elapsed(monotonicStart);
      const trial = createTrial(
        planned,
        result,
        traces.take(result.runId),
        latencyMs,
        trialStartedAt,
        identities[planned.arm],
        trialFixtureVerification,
      );
      trials.push(trial);
      onProgress?.(
        Object.freeze({
          completed: trials.length,
          total: schedule.length,
          trial,
        }),
      );

      if (!trial.cleanupSucceeded || !trial.valid) {
        const reason = !trial.cleanupSucceeded
          ? "Stopped because isolated browser session cleanup was not positively confirmed; no later trial was launched."
          : "Stopped because trial validity checks detected contamination or an unexpected execution path; no later trial was launched.";
        return await stop(
          reason,
          !trial.cleanupSucceeded
            ? ["cleanup_unproven"]
            : ["trial_invalid", ...trial.invalidReasons],
          true,
        );
      }
      await writePrivateJsonAtomic(
        batchReportPath,
        buildReport("running", null),
      );
    }

    try {
      fixturePostcheck = await verifyBenchmarkFixture();
    } catch {
      return await stop(
        "The pinned fixture could not be reverified after the batch; all measurements must be treated as invalid.",
        ["fixture_postcheck_failed"],
      );
    }
    [sourcePostcheck, runtimePostcheck] = await Promise.all([
      collectGitState(),
      collectRuntimeArtifactSnapshot(binary),
    ]);
    for (const reason of gitReproducibilityReasons(
      environment,
      sourcePostcheck,
    )) {
      if (!measurementInvalidReasons.includes(reason)) {
        measurementInvalidReasons.push(reason);
      }
    }
    for (const reason of runtimeArtifactReproducibilityReasons(
      environment,
      runtimePostcheck,
    )) {
      if (!measurementInvalidReasons.includes(reason)) {
        measurementInvalidReasons.push(reason);
      }
    }
    measurementsValid = measurementInvalidReasons.length === 0;
    if (!measurementsValid) {
      return await stop(
        "The source tree or installed runtime artifacts changed during the batch; all measurements must be treated as invalid.",
        measurementInvalidReasons,
      );
    }
    const complete = buildReport("complete", null);
    await writePrivateJsonAtomic(batchReportPath, complete);
    return Object.freeze({ report: complete, reportPath: batchReportPath });
  } catch (error: unknown) {
    if (reportPath) {
      // The per-run ledger remains the recovery authority if report generation
      // itself fails. Never replay an incomplete run in this catch path.
      await preserveFailureMarker(reportPath, error).catch(() => undefined);
    }
    throw error;
  } finally {
    if (releaseBatchLease) {
      await releaseBatchLease().catch(() => undefined);
    }
    await driver.close().catch(() => undefined);
  }
}

export function benchmarkRuntimeConfig(): ReturnType<typeof loadRuntimeConfig> {
  return loadRuntimeConfig({
    JEV_CUA_WORKFLOW_DIR: join(REPOSITORY_ROOT, "workflows"),
    JEV_CUA_LOG_LEVEL: "off",
  });
}

export function buildTrialPlan(
  options: BenchmarkOptions,
): readonly PlannedTrial[] {
  const phases = [
    {
      phase: "warmup" as const,
      count: options.warmupPairs,
      seed: `${options.seed}:warmup`,
    },
    {
      phase: "measured" as const,
      count: options.pairs,
      seed: `${options.seed}:measured`,
    },
  ];
  const result: PlannedTrial[] = [];
  for (const phase of phases) {
    const schedule = buildBalancedSchedule(phase.count, phase.seed).filter(
      (entry) => options.arm === "both" || entry.arm === options.arm,
    );
    for (const entry of schedule) {
      result.push(
        Object.freeze({
          ...entry,
          runIndex: result.length,
          position: options.arm === "both" ? entry.position : 1,
          phase: phase.phase,
          sequence: result.length,
        }),
      );
    }
  }
  return Object.freeze(result);
}

export function createTrial(
  planned: PlannedTrial,
  result: RunResult,
  events: readonly TraceEvent[],
  latencyMs: number,
  startedAt: string,
  expectedModel: string,
  fixtureVerification: FixtureVerification,
): BenchmarkTrial {
  const decisions = events.filter((event) => event.event === "decision");
  const providerFailures = events.filter(
    (event) => event.event === "provider_failure",
  );
  const decisionValidationFailures = events.filter(
    (event) => event.event === "decision_validation_failed",
  );
  const usageEvents = [...decisions, ...decisionValidationFailures];
  const actions = events.filter((event) => event.event === "action_started");
  const actionReturns = events.filter(
    (event) => event.event === "action_returned",
  );
  const cleanupTraceSucceeded =
    events.filter((event) => event.event === "session_cleanup_succeeded")
      .length === 1 &&
    events.every((event) => event.event !== "session_cleanup_failed");
  const cleanupSucceeded =
    cleanupTraceSucceeded && result.cleanupSucceeded === true;
  const expectedActions = [
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
  const invalidReasons: string[] = [];
  for (const [index, action] of actions.entries()) {
    const expected = expectedActions[index];
    if (
      !expected ||
      action.semantic_key !== expected.semanticKey ||
      action.action_class !== expected.actionClass
    ) {
      invalidReasons.push("unexpected_action_sequence");
      break;
    }
  }
  if (
    events.some((event) => event.event === "step_satisfied_before_dispatch")
  ) {
    invalidReasons.push("step_satisfied_before_dispatch");
  }
  if (!cleanupSucceeded) invalidReasons.push("cleanup_unproven");
  if (result.outcome === "verified") {
    if (decisionValidationFailures.length > 0) {
      invalidReasons.push("verified_after_decision_validation_failure");
    }
    if (actions.length !== expectedActions.length) {
      invalidReasons.push("verified_without_exact_action_count");
    }
    if (
      decisions.some(
        (event) => event.gate !== "execute" && event.gate !== "reobserve",
      )
    ) {
      invalidReasons.push("verified_with_unexpected_decision_route");
    }
    if (
      decisions.filter((event) => event.gate === "execute").length !==
      expectedActions.length
    ) {
      invalidReasons.push("verified_without_exact_execute_decision_count");
    }
    if (result.model !== expectedModel) {
      invalidReasons.push("verified_with_unexpected_model");
    }
    if (
      actionReturns.length !== expectedActions.length ||
      actionReturns.some(
        (event) =>
          typeof event.delivery_route !== "string" ||
          typeof event.delivery_effect !== "string",
      )
    ) {
      invalidReasons.push("verified_without_exact_delivery_receipts");
    }
    if (!hasExactVerifiedLifecycle(events, expectedActions)) {
      invalidReasons.push("verified_without_exact_ordered_lifecycle");
    }
  }
  const tokenUsageKnown = providerFailures.length === 0;
  return Object.freeze({
    sequence: planned.sequence,
    phase: planned.phase,
    pairIndex: planned.pairIndex,
    position: planned.position,
    arm: planned.arm,
    outcome: result.outcome,
    verified: result.outcome === "verified",
    latencyMs,
    decisionMs: sumEventNumbers(usageEvents, "decision_ms"),
    actionMs: sumFinite(result.steps.map((step) => step.actionMs)),
    verificationMs: sumFinite(result.steps.map((step) => step.verificationMs)),
    decisionCount: usageEvents.length,
    actionCount: actions.length,
    reobserveCount: decisions.filter((event) => event.gate === "reobserve")
      .length,
    providerFailureCount: providerFailures.length,
    decisionValidationFailureCount: decisionValidationFailures.length,
    inputTokens: tokenUsageKnown
      ? sumEventNumbers(usageEvents, "input_tokens")
      : null,
    outputTokens: tokenUsageKnown
      ? sumEventNumbers(usageEvents, "output_tokens")
      : null,
    unknownUsageRequestCount: providerFailures.length,
    stepCount: result.steps.length,
    model: result.model ?? null,
    deliveryRoutes: Object.freeze(
      actionReturns
        .map((event) => event.delivery_route)
        .filter((value): value is string => typeof value === "string"),
    ),
    deliveryEffects: Object.freeze(
      actionReturns
        .map((event) => event.delivery_effect)
        .filter((value): value is string => typeof value === "string"),
    ),
    valid: invalidReasons.length === 0,
    invalidReasons: Object.freeze([...new Set(invalidReasons)]),
    reason: result.reason,
    reconciliationRequired: result.reconciliationRequired,
    isolationCleanupResolvedReconciliation:
      result.reconciliationRequired && cleanupSucceeded,
    safeToRetry: result.safeToRetry,
    cleanupSucceeded,
    fixtureVerification,
    startedAt,
    finishedAt: result.finishedAt,
  });
}

export function hasExactVerifiedLifecycle(
  events: readonly TraceEvent[],
  expectedActions: readonly Readonly<{
    semanticKey: string;
    actionClass: string;
  }>[],
): boolean {
  const lifecycle = events.filter(
    (event) =>
      (event.event === "decision" && event.gate === "execute") ||
      ["action_started", "action_returned", "postcondition_checked"].includes(
        String(event.event),
      ),
  );
  if (lifecycle.length !== expectedActions.length * 4) return false;

  let priorStep = 0;
  for (const [index, expected] of expectedActions.entries()) {
    const [decision, started, returned, postcondition] = lifecycle.slice(
      index * 4,
      index * 4 + 4,
    );
    const step = decision?.step;
    if (
      decision?.event !== "decision" ||
      typeof step !== "number" ||
      !Number.isSafeInteger(step) ||
      step <= priorStep ||
      decision.gate !== "execute" ||
      decision.selected_action_class !== expected.actionClass ||
      started?.event !== "action_started" ||
      started.step !== step ||
      started.semantic_key !== expected.semanticKey ||
      started.action_class !== expected.actionClass ||
      typeof started.operation_id !== "string" ||
      returned?.event !== "action_returned" ||
      returned.step !== step ||
      returned.operation_id !== started.operation_id ||
      postcondition?.event !== "postcondition_checked" ||
      postcondition.step !== step ||
      postcondition.operation_id !== started.operation_id ||
      postcondition.step_satisfied !== true ||
      postcondition.workflow_satisfied !==
        (index === expectedActions.length - 1)
    ) {
      return false;
    }
    priorStep = step;
  }
  return true;
}

function sumEventNumbers(events: readonly TraceEvent[], key: string): number {
  return sumFinite(
    events.map((event) => {
      const value = event[key];
      if (typeof value !== "number") {
        throw new Error(`benchmark trace omitted numeric ${key}`);
      }
      return value;
    }),
  );
}

function sumFinite(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("benchmark metric was not a finite non-negative number");
    }
    total += value;
  }
  return Math.round(total * 100) / 100;
}

function validateOptions(options: BenchmarkOptions): void {
  if (
    options.arm !== "jev" &&
    options.arm !== "deterministic" &&
    options.arm !== "both"
  ) {
    throw new Error("unsupported benchmark arm");
  }
  parseBoundedInteger(String(options.pairs), "pairs", 1, 100);
  parseBoundedInteger(String(options.warmupPairs), "warmupPairs", 0, 20);
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(options.seed)) {
    throw new Error("invalid benchmark seed");
  }
}

function parseBoundedInteger(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function createBatchId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} is not a regular benchmark directory`);
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(`${path} is not owned by the current user`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`${path} must have mode 0700`);
  }
}

async function createPrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await ensurePrivateDirectory(path);
}

export async function assertNoInterruptedBenchmark(
  resultsRoot: string,
): Promise<void> {
  const entries = await readdir(resultsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!/^\d{17}-[a-f0-9]{8}$/u.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      throw new Error("benchmark result entry has an unsafe file type");
    }
    const directory = join(resultsRoot, entry.name);
    await ensurePrivateDirectory(directory);
    const report = await readPrivateBenchmarkReport(
      join(directory, "report.json"),
    );
    if (report.schema !== "jev-cua.benchmark-report.v2") {
      throw new Error(
        `benchmark batch ${entry.name} has an unsupported report schema; inspect and archive it before starting another batch`,
      );
    }
    if (report.batchId !== entry.name) {
      throw new Error(
        `benchmark batch ${entry.name} has a mismatched report identity; inspect and archive it before starting another batch`,
      );
    }
    if (!Array.isArray(report.trials)) {
      throw new Error(
        `benchmark batch ${entry.name} has no valid trial ledger; inspect it before starting another batch`,
      );
    }
    if (
      !Number.isSafeInteger(report.completedTrials) ||
      Number(report.completedTrials) < 0 ||
      report.completedTrials !== report.trials.length ||
      !Number.isSafeInteger(report.plannedTrials) ||
      Number(report.plannedTrials) < Number(report.completedTrials)
    ) {
      throw new Error(
        `benchmark batch ${entry.name} has inconsistent trial counters; inspect and archive it before starting another batch`,
      );
    }
    if (report.status === "running") {
      throw new Error(
        `benchmark batch ${entry.name} is still marked running; inspect its durable ledger before starting another batch`,
      );
    }
    if (typeof report.requiresManualReview !== "boolean") {
      throw new Error(
        `benchmark batch ${entry.name} has no valid manual-review state; inspect and archive it before starting another batch`,
      );
    }
    if (report.requiresManualReview === true) {
      throw new Error(
        `benchmark batch ${entry.name} requires manual review; inspect and archive it before starting another batch`,
      );
    }
    if (
      report.status !== "complete" &&
      report.status !== "stopped" &&
      report.status !== "running"
    ) {
      throw new Error(
        `benchmark batch ${entry.name} has an invalid status; inspect it before starting another batch`,
      );
    }
    if (typeof report.measurementsValid !== "boolean") {
      throw new Error(
        `benchmark batch ${entry.name} has no terminal measurement-validity state; inspect and archive it before starting another batch`,
      );
    }
    const unresolved = report.trials.some((trial) => {
      if (!trial || typeof trial !== "object" || Array.isArray(trial)) {
        return true;
      }
      const record = trial as Record<string, unknown>;
      return (
        record.cleanupSucceeded !== true ||
        typeof record.reconciliationRequired !== "boolean" ||
        record.valid !== true
      );
    });
    if (unresolved) {
      throw new Error(
        `benchmark batch ${entry.name} has unresolved cleanup or reconciliation; inspect and archive it before starting another batch`,
      );
    }
    const audit = await new RunStore(join(directory, "state")).auditExisting();
    if (
      audit.activeRecords !== 0 ||
      audit.malformedRecords !== 0 ||
      audit.totalRecords !== report.trials.length ||
      audit.completeRecords !== report.trials.length
    ) {
      throw new Error(
        `benchmark batch ${entry.name} report does not match its durable run ledger; inspect and archive it before starting another batch`,
      );
    }
  }
}

async function readPrivateBenchmarkReport(path: string): Promise<
  Readonly<{
    schema?: unknown;
    batchId?: unknown;
    status?: unknown;
    requiresManualReview?: unknown;
    measurementsValid?: unknown;
    plannedTrials?: unknown;
    completedTrials?: unknown;
    trials?: readonly unknown[] | unknown;
  }>
> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(
        "a prior benchmark directory has no report; inspect it before starting another batch",
      );
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) {
      throw new Error("prior benchmark report is not a bounded regular file");
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error(
        "prior benchmark report is not owned by the current user",
      );
    }
    if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
      throw new Error("prior benchmark report must have mode 0600");
    }
    return JSON.parse((await handle.readFile()).toString("utf8")) as Readonly<{
      schema?: unknown;
      batchId?: unknown;
      status?: unknown;
      requiresManualReview?: unknown;
      measurementsValid?: unknown;
      plannedTrials?: unknown;
      completedTrials?: unknown;
      trials?: readonly unknown[] | unknown;
    }>;
  } finally {
    await handle.close();
  }
}

async function writePrivateJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = join(
    directory,
    `.report-${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function preserveFailureMarker(
  path: string,
  error: unknown,
): Promise<void> {
  const marker = join(dirname(path), "HARNESS_FAILED.txt");
  const handle = await open(
    marker,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(
      `Benchmark harness stopped with ${error instanceof Error ? error.name : "UnknownError"}. Inspect the durable run ledger before any retry.\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function collectEnvironment(
  cuaBinary: string,
  cuaVersion: string,
  cuaTools: number,
  credentialSource: "environment" | "keychain" | "missing",
): Promise<BenchmarkReport["environment"]> {
  const [macosVersion, gitState, runtimeArtifacts] = await Promise.all([
    safeExec("/usr/bin/sw_vers", ["-productVersion"]),
    collectGitState(),
    collectRuntimeArtifactSnapshot(cuaBinary),
  ]);
  return Object.freeze({
    ...runtimeArtifacts,
    platform: platform(),
    release: release(),
    architecture: arch(),
    macosVersion,
    cuaVersion,
    cuaTools,
    ...gitState,
    typeSafeCredentialSource: credentialSource,
  });
}

async function collectRuntimeArtifactSnapshot(
  cuaBinary: string,
): Promise<RuntimeArtifactSnapshot> {
  let typeSafeSdkEntrypoint: string | null = null;
  try {
    // The policy imports the SDK as ESM, so hash the exact import-condition
    // entrypoint that Node will execute rather than the package's CJS export.
    typeSafeSdkEntrypoint = fileURLToPath(
      import.meta.resolve("@typesafe-ai/sdk"),
    );
  } catch {
    // The unavailable digest is recorded and invalidates the benchmark.
  }
  const [
    typeSafeSdkVersion,
    typeSafeSdkEntrypointSha256,
    packageLockSha256,
    cuaExecutableSha256,
    installedChromeVersion,
    chromeExecutableSha256,
    installedEdgeVersion,
    edgeExecutableSha256,
  ] = await Promise.all([
    collectInstalledTypeSafeSdkVersion(),
    typeSafeSdkEntrypoint
      ? sha256File(typeSafeSdkEntrypoint)
      : Promise.resolve(null),
    sha256File(join(REPOSITORY_ROOT, "package-lock.json")),
    sha256File(cuaBinary),
    safeExec(CHROME_EXECUTABLE, ["--version"]),
    sha256File(CHROME_EXECUTABLE),
    safeExec(EDGE_EXECUTABLE, ["--version"]),
    sha256File(EDGE_EXECUTABLE),
  ]);
  return Object.freeze({
    node: process.versions.node,
    typeSafeSdkVersion,
    typeSafeSdkEntrypointSha256,
    packageLockSha256,
    cuaExecutableSha256,
    installedChromeVersion,
    chromeExecutableSha256,
    installedEdgeVersion,
    edgeExecutableSha256,
  });
}

async function collectInstalledTypeSafeSdkVersion(): Promise<string | null> {
  try {
    const path = moduleRequire.resolve("@typesafe-ai/sdk/package.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

async function sha256File(path: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return null;
  }
}

export function runtimeArtifactReproducibilityReasons(
  environment: RuntimeArtifactSnapshot,
  postcheck?: RuntimeArtifactSnapshot,
): readonly string[] {
  const reasons: string[] = [];
  if (environment.typeSafeSdkVersion === null) {
    reasons.push("typesafe_sdk_version_unavailable");
  } else if (environment.typeSafeSdkVersion !== EXPECTED_TYPESAFE_SDK_VERSION) {
    reasons.push("typesafe_sdk_version_mismatch");
  }
  if (environment.typeSafeSdkEntrypointSha256 === null) {
    reasons.push("typesafe_sdk_entrypoint_digest_unavailable");
  }
  if (environment.packageLockSha256 === null) {
    reasons.push("package_lock_digest_unavailable");
  }
  if (environment.cuaExecutableSha256 === null) {
    reasons.push("cua_executable_digest_unavailable");
  }
  if (
    environment.chromeExecutableSha256 === null &&
    environment.edgeExecutableSha256 === null
  ) {
    reasons.push("trusted_chromium_executable_digest_unavailable");
  }
  if (postcheck) {
    if (postcheck.node !== environment.node) {
      reasons.push("node_runtime_changed_during_batch");
    }
    if (postcheck.typeSafeSdkVersion === null) {
      reasons.push("typesafe_sdk_postcheck_version_unavailable");
    } else if (
      environment.typeSafeSdkVersion !== null &&
      postcheck.typeSafeSdkVersion !== environment.typeSafeSdkVersion
    ) {
      reasons.push("typesafe_sdk_changed_during_batch");
    }
    compareRuntimeDigest(
      reasons,
      environment.typeSafeSdkEntrypointSha256,
      postcheck.typeSafeSdkEntrypointSha256,
      "typesafe_sdk_entrypoint_postcheck_digest_unavailable",
      "typesafe_sdk_entrypoint_changed_during_batch",
    );
    compareRuntimeDigest(
      reasons,
      environment.packageLockSha256,
      postcheck.packageLockSha256,
      "package_lock_postcheck_digest_unavailable",
      "package_lock_changed_during_batch",
    );
    compareRuntimeDigest(
      reasons,
      environment.cuaExecutableSha256,
      postcheck.cuaExecutableSha256,
      "cua_executable_postcheck_digest_unavailable",
      "cua_executable_changed_during_batch",
    );
    compareInstalledBrowserDigest(
      reasons,
      "chrome",
      environment.chromeExecutableSha256,
      postcheck.chromeExecutableSha256,
    );
    compareInstalledBrowserVersion(
      reasons,
      "chrome",
      environment.installedChromeVersion,
      postcheck.installedChromeVersion,
    );
    compareInstalledBrowserDigest(
      reasons,
      "edge",
      environment.edgeExecutableSha256,
      postcheck.edgeExecutableSha256,
    );
    compareInstalledBrowserVersion(
      reasons,
      "edge",
      environment.installedEdgeVersion,
      postcheck.installedEdgeVersion,
    );
  }
  return Object.freeze([...new Set(reasons)]);
}

function compareInstalledBrowserDigest(
  reasons: string[],
  browser: "chrome" | "edge",
  initial: string | null,
  postcheck: string | null,
): void {
  // Any inventory transition can alter Cua's browser choice or fallback path.
  if (initial === null && postcheck !== null) {
    reasons.push(`${browser}_executable_added_during_batch`);
  } else if (initial !== null && postcheck === null) {
    reasons.push(`${browser}_executable_disappeared_during_batch`);
  } else if (initial !== null && postcheck !== null && postcheck !== initial) {
    reasons.push(`${browser}_executable_changed_during_batch`);
  }
}

function compareInstalledBrowserVersion(
  reasons: string[],
  browser: "chrome" | "edge",
  initial: string | null,
  postcheck: string | null,
): void {
  if (initial !== postcheck) {
    reasons.push(`${browser}_version_changed_during_batch`);
  }
}

function compareRuntimeDigest(
  reasons: string[],
  initial: string | null,
  postcheck: string | null,
  unavailableReason: string,
  changedReason: string,
): void {
  if (postcheck === null) reasons.push(unavailableReason);
  else if (initial !== null && postcheck !== initial)
    reasons.push(changedReason);
}

async function collectGitState(): Promise<
  Readonly<{ gitCommit: string | null; gitDirty: boolean | null }>
> {
  const [gitCommit, gitStatus] = await Promise.all([
    safeExec("/usr/bin/git", ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"]),
    safeExec(
      "/usr/bin/git",
      [
        "-C",
        REPOSITORY_ROOT,
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ],
      true,
    ),
  ]);
  return Object.freeze({
    gitCommit,
    gitDirty: gitStatus === null ? null : gitStatus.length > 0,
  });
}

export function gitReproducibilityReasons(
  initial: Readonly<{ gitCommit: string | null; gitDirty: boolean | null }>,
  postcheck?: Readonly<{
    gitCommit: string | null;
    gitDirty: boolean | null;
  }>,
): readonly string[] {
  const reasons: string[] = [];
  if (initial.gitCommit === null) reasons.push("git_commit_unavailable");
  if (initial.gitDirty === true) reasons.push("git_worktree_dirty");
  if (initial.gitDirty === null) {
    reasons.push("git_worktree_status_unavailable");
  }
  if (postcheck) {
    if (postcheck.gitCommit === null) {
      reasons.push("git_postcheck_commit_unavailable");
    } else if (
      initial.gitCommit !== null &&
      postcheck.gitCommit !== initial.gitCommit
    ) {
      reasons.push("git_commit_changed_during_batch");
    }
    if (postcheck.gitDirty === true) {
      reasons.push("git_worktree_changed_during_batch");
    }
    if (postcheck.gitDirty === null) {
      reasons.push("git_postcheck_status_unavailable");
    }
  }
  return Object.freeze([...new Set(reasons)]);
}

async function safeExec(
  command: string,
  arguments_: readonly string[],
  allowEmpty = false,
): Promise<string | null> {
  try {
    const { stdout } = await execFile(command, [...arguments_], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        LANG: "C",
      },
    });
    const value = stdout.trim().slice(0, 512);
    return value || allowEmpty ? value : null;
  } catch {
    return null;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
