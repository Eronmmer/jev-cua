import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { RuntimeConfig } from "../config.js";
import {
  observeBrowser,
  resolveBrowserTarget,
  verifySuccess,
  withSession,
} from "../cua/browser.js";
import { DriverToolError } from "../cua/client.js";
import { gateDecision } from "../policy/gate.js";
import { candidateMayExecuteAutomatically } from "../policy/risk.js";
import { validateCandidateSet } from "../policy/validate-candidates.js";
import { DesktopLease, RunStore } from "../state.js";
import type {
  CandidateBuilder,
  DecisionPolicy,
  DriverClient,
  JsonValue,
  Outcome,
  RunRequest,
  RunResult,
  StepTrace,
  TraceSink,
} from "../types.js";
import { canonicalJson } from "../util.js";

const REQUIRED_TOOLS = new Set([
  "get_browser_state",
  "browser_click",
  "browser_type",
  "browser_pointer",
  "end_session",
]);

type FinishInput = Omit<
  RunResult,
  "finishedAt" | "reconciliationRequired" | "safeToRetry"
> &
  Partial<Pick<RunResult, "reconciliationRequired" | "safeToRetry">>;

function reconcileWorkflowProgress(
  observation: Parameters<typeof verifySuccess>[0],
  request: RunRequest,
  completed: Set<string>,
): number {
  let advanced = 0;
  for (const step of request.workflowSteps) {
    if (completed.has(step.semanticKey)) continue;
    if (!verifySuccess(observation, step.ensures, request.values)) break;
    completed.add(step.semanticKey);
    advanced += 1;
  }
  return advanced;
}

export class FastpathController {
  constructor(
    private readonly dependencies: Readonly<{
      driver: DriverClient;
      policy: DecisionPolicy;
      config: RuntimeConfig;
      lease: DesktopLease;
      runs: RunStore;
      traces: TraceSink;
      candidateBuilder: CandidateBuilder;
      candidateSemanticPrefix: string;
      policyFingerprint: string;
    }>,
  ) {}

  async run(request: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const deadlineSignal = AbortSignal.timeout(request.maxWallTimeMs);
    const executionSignal = signal
      ? AbortSignal.any([signal, deadlineSignal])
      : deadlineSignal;
    executionSignal.throwIfAborted();
    if (
      !/^[a-f0-9]{64}$/u.test(this.dependencies.policyFingerprint) ||
      !this.dependencies.candidateSemanticPrefix.trim()
    ) {
      throw new Error("controller has no trusted compiled policy identity");
    }
    if (request.policyFingerprint !== this.dependencies.policyFingerprint) {
      throw new Error(
        "run policy fingerprint does not match the compiled controller policy",
      );
    }
    if (
      request.target.kind === "isolated" &&
      request.target.navigationEffect !== "read_only_landing"
    ) {
      throw new Error(
        "isolated bootstrap navigation is outside the reviewed read-only contract",
      );
    }
    const workflowStepKeys = request.workflowSteps.map(
      (step) => step.semanticKey,
    );
    if (
      workflowStepKeys.length < 1 ||
      workflowStepKeys.length > 50 ||
      new Set(workflowStepKeys).size !== workflowStepKeys.length ||
      workflowStepKeys.some(
        (key) => !key.startsWith(this.dependencies.candidateSemanticPrefix),
      ) ||
      canonicalJson(request.workflowSteps.at(-1)!.ensures) !==
        canonicalJson(request.success)
    ) {
      throw new Error(
        "run workflow progress contract does not match the compiled controller policy",
      );
    }
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const begun = await this.dependencies.runs.begin(
      request.runKey,
      JSON.stringify(request),
      runId,
    );
    if (begun.cached) return begun.cached;
    if (begun.activeElsewhere) {
      return Object.freeze({
        runId: begun.activeRun?.runId ?? runId,
        runKeyHash: begun.runKeyHash,
        outcome: "unknown",
        reason:
          "A run with this idempotency key already started; it will not be replayed automatically.",
        steps: Object.freeze([]),
        startedAt: begun.activeRun?.startedAt ?? startedAt,
        finishedAt: new Date().toISOString(),
        frontierFallbackRecommended: false,
        reconciliationRequired: true,
        safeToRetry: false,
      });
    }

    if (request.mode === "shadow") {
      const shadow = this.finish({
        runId,
        runKeyHash: begun.runKeyHash,
        startedAt,
        steps: [],
        outcome: "shadow_complete",
        reason:
          "The pinned workflow and inputs passed local validation. Shadow mode launched no browser and dispatched no computer input.",
        frontierFallbackRecommended: false,
      });
      await this.dependencies.runs.complete(shadow);
      return shadow;
    }

    let release: (() => Promise<void>) | undefined;
    let result: RunResult;
    try {
      release = await this.dependencies.lease.acquire(runId);
      result = await this.execute(
        runId,
        begun.runKeyHash,
        startedAt,
        request,
        executionSignal,
      );
    } catch (error: unknown) {
      result = this.finish({
        runId,
        runKeyHash: begun.runKeyHash,
        startedAt,
        steps: [],
        outcome: "unknown",
        reason: classifyFailure(error),
        frontierFallbackRecommended: false,
        reconciliationRequired: true,
        safeToRetry: false,
      });
    } finally {
      if (release) await release();
    }
    await this.dependencies.runs.complete(result);
    return result;
  }

  private async execute(
    runId: string,
    runKeyHash: string,
    startedAt: string,
    request: RunRequest,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    signal?.throwIfAborted();
    await this.dependencies.driver.connect();
    const tools = await this.dependencies.driver.listTools();
    const available = new Set(tools.map((tool) => tool.name));
    for (const required of REQUIRED_TOOLS) {
      if (!available.has(required))
        throw new Error(`required Cua tool is unavailable: ${required}`);
    }
    if (request.target.kind === "isolated") {
      for (const required of [
        "browser_prepare",
        "browser_navigate",
        "list_windows",
      ]) {
        if (!available.has(required))
          throw new Error(`required Cua tool is unavailable: ${required}`);
      }
    }

    const session = `jev-cua-${runId.slice(0, 12)}`;
    const traces: StepTrace[] = [];
    const startedMonotonic = performance.now();
    let priorDigest: string | undefined;
    let sameStateCount = 0;
    let lastModel: string | undefined;
    const attemptedActions = new Set<string>();
    const completedActions = new Set<string>();
    let mutationAttempted = false;
    const finish = (input: FinishInput): RunResult =>
      this.finish(
        mutationAttempted && input.outcome !== "verified"
          ? {
              ...input,
              frontierFallbackRecommended: false,
              reconciliationRequired: true,
              safeToRetry: false,
            }
          : input,
      );

    try {
      if (request.target.kind === "isolated") {
        await this.dependencies.runs.markPhase(
          runKeyHash,
          runId,
          "browser_setup_started",
        );
        await this.trace(runId, { event: "browser_setup_started" });
      }
      const bound = await resolveBrowserTarget(
        this.dependencies.driver,
        request.target,
        session,
        request.allowedOrigins,
        signal,
      );
      if (request.target.kind === "isolated") {
        await this.dependencies.runs.markPhase(
          runKeyHash,
          runId,
          "browser_setup_returned",
        );
        await this.trace(runId, { event: "browser_setup_returned" });
      }
      for (let step = 1; step <= request.maxSteps; step += 1) {
        signal?.throwIfAborted();
        if (performance.now() - startedMonotonic > request.maxWallTimeMs) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "budget_exhausted",
            reason: "The run reached its wall-time budget.",
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }

        const observation = await observeBrowser(
          this.dependencies.driver,
          bound,
          session,
          request.allowedOrigins,
          signal,
        );
        if (!observation.complete) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason:
              "The semantic observation remained partial after bounded continuation reads; no action was dispatched.",
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }
        const verificationStarted = performance.now();
        if (verifySuccess(observation, request.success, request.values)) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "verified",
            reason: "The deterministic success condition is satisfied.",
            model: lastModel,
            frontierFallbackRecommended: false,
          });
        }
        reconcileWorkflowProgress(observation, request, completedActions);
        const verificationMs = elapsed(verificationStarted);
        if (priorDigest === observation.digest) sameStateCount += 1;
        else sameStateCount = 0;
        priorDigest = observation.digest;
        if (sameStateCount >= 8) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason:
              "The controller observed the same state repeatedly and stopped.",
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }

        const allCandidates = this.dependencies.candidateBuilder({
          observation,
          values: request.values,
          maximum: this.dependencies.config.maxCandidates,
          labelMaxLength: this.dependencies.config.labelMaxLength,
          privateState: bound.privateState,
          completedSemanticKeys: completedActions,
        });
        validateCandidateSet({
          candidates: allCandidates,
          observation,
          values: request.values,
          maximum: this.dependencies.config.maxCandidates,
          semanticPrefix: this.dependencies.candidateSemanticPrefix,
        });
        const forbidden = allCandidates.find(
          (candidate) => candidate.action && candidate.risk === "r4_forbidden",
        );
        if (forbidden) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "denied",
            reason:
              "The compiled next action is forbidden by the fast-path policy.",
            model: lastModel,
            frontierFallbackRecommended: false,
          });
        }
        const consequential = allCandidates.filter(
          (candidate) =>
            candidate.action && candidate.risk === "r3_consequential",
        );
        if (consequential.length > 0) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "approval_required",
            reason:
              "The reviewed next step has an external side effect and requires a fresh human approval path that this version does not automate.",
            model: lastModel,
            frontierFallbackRecommended: false,
          });
        }
        const candidates = allCandidates.filter(
          (candidate) =>
            candidate.action === null ||
            candidateMayExecuteAutomatically(candidate),
        );
        if (candidates.length <= 3) {
          await this.trace(runId, { event: "no_exact_candidate", step });
          await delay(250, undefined, signal ? { signal } : undefined);
          continue;
        }

        let decision;
        try {
          decision = await this.dependencies.policy.choose({
            goal: request.goal,
            observation,
            candidates,
            ...(traces.at(-1) ? { previousStep: traces.at(-1)! } : {}),
            ...(signal ? { signal } : {}),
          });
        } catch (error: unknown) {
          await this.trace(runId, {
            event: "provider_failure",
            step,
            error: error instanceof Error ? error.name : "UnknownError",
          });
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason:
              "The bounded decision provider failed; no action was dispatched.",
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }
        lastModel = decision.model;
        const gate = gateDecision({
          decision,
          candidates,
          observationDigest: observation.digest,
          expectedModel: this.dependencies.config.model,
          thresholds: this.dependencies.config.thresholds,
        });
        const baseTrace = {
          step,
          candidateCount: candidates.length,
          selectedSemanticKey: candidateClass(gate.candidate),
          risk: gate.candidate.risk,
          decisionMs: decision.latencyMs,
          actionMs: 0,
          verificationMs,
        } satisfies StepTrace;

        await this.trace(runId, {
          event: "decision",
          step,
          selected_action_class: candidateClass(gate.candidate),
          risk: gate.candidate.risk,
          gate: gate.kind,
          decision_ms: decision.latencyMs,
          input_tokens: decision.inputTokens,
          output_tokens: decision.outputTokens,
          model: decision.model,
        });

        if (gate.kind === "reobserve") {
          traces.push(Object.freeze(baseTrace));
          continue;
        }
        if (
          gate.kind === "abstain" ||
          gate.kind === "escalate" ||
          gate.kind === "reject"
        ) {
          const outcome: Outcome =
            gate.kind === "abstain" ? "abstained" : "unknown";
          traces.push(Object.freeze({ ...baseTrace, outcome }));
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome,
            reason: gate.reason,
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }
        if (gate.kind === "approval_required" || gate.kind === "denied") {
          const outcome: Outcome = gate.kind;
          traces.push(Object.freeze({ ...baseTrace, outcome }));
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome,
            reason: gate.reason,
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }

        const freshObservation = await observeBrowser(
          this.dependencies.driver,
          bound,
          session,
          request.allowedOrigins,
          signal,
        );
        if (!freshObservation.complete) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason:
              "The pre-dispatch observation was incomplete; no action was dispatched.",
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }
        if (verifySuccess(freshObservation, request.success, request.values)) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "verified",
            reason:
              "The deterministic success condition became satisfied before dispatch.",
            model: lastModel,
            frontierFallbackRecommended: false,
          });
        }
        reconcileWorkflowProgress(freshObservation, request, completedActions);
        if (completedActions.has(gate.candidate.semanticKey)) {
          traces.push(Object.freeze(baseTrace));
          await this.trace(runId, {
            event: "step_satisfied_before_dispatch",
            step,
            semantic_key: gate.candidate.semanticKey,
          });
          continue;
        }
        const freshCandidates = this.dependencies.candidateBuilder({
          observation: freshObservation,
          values: request.values,
          maximum: this.dependencies.config.maxCandidates,
          labelMaxLength: this.dependencies.config.labelMaxLength,
          privateState: bound.privateState,
          completedSemanticKeys: completedActions,
        });
        validateCandidateSet({
          candidates: freshCandidates,
          observation: freshObservation,
          values: request.values,
          maximum: this.dependencies.config.maxCandidates,
          semanticPrefix: this.dependencies.candidateSemanticPrefix,
        });
        const refreshed = freshCandidates.filter(
          (candidate) =>
            candidate.action !== null &&
            candidate.semanticKey === gate.candidate.semanticKey &&
            candidate.risk === gate.candidate.risk &&
            candidate.description === gate.candidate.description,
        );
        if (
          refreshed.length !== 1 ||
          !candidateMayExecuteAutomatically(refreshed[0]!)
        ) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason:
              "The reviewed action was stale or ambiguous in the fresh pre-dispatch observation; no action was dispatched.",
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }
        const actionCandidate = refreshed[0]!;
        const action = actionCandidate.action!;
        if (!actionCandidate.actionDigest)
          throw new Error("executable candidate has no local action digest");
        // A semantic action is single-use within a run. Compiled workflows use
        // stable step IDs; legitimate repetition must be represented as distinct
        // reviewed steps rather than inferred from volatile page content.
        const attemptKey = actionCandidate.semanticKey;
        if (attemptedActions.has(attemptKey)) {
          traces.push(Object.freeze({ ...baseTrace, outcome: "unknown" }));
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason:
              "The same action was already attempted from this semantic state; it was not replayed.",
            model: lastModel,
            frontierFallbackRecommended: true,
          });
        }
        attemptedActions.add(attemptKey);
        signal?.throwIfAborted();
        const operationId = randomUUID();
        await this.dependencies.runs.markPhase(
          runKeyHash,
          runId,
          "action_started",
          {
            policyFingerprint: request.policyFingerprint,
            semanticStep: actionCandidate.semanticKey,
            actionClass: action.tool,
            operationId,
          },
        );
        mutationAttempted = true;
        signal?.throwIfAborted();
        await this.trace(runId, {
          event: "action_started",
          step,
          operation_id: operationId,
          action_class: action.tool,
          semantic_key: actionCandidate.semanticKey,
          risk: actionCandidate.risk,
        });
        const actionStarted = performance.now();
        try {
          await this.dependencies.driver.call(
            action.tool,
            withSession(action.arguments, session),
            signal ? { signal } : undefined,
          );
        } catch (error: unknown) {
          const ambiguous =
            error instanceof DriverToolError && error.ambiguousExecution;
          await this.trace(runId, {
            event: "action_failed",
            step,
            operation_id: operationId,
            ambiguous,
            error: error instanceof Error ? error.name : "UnknownError",
          });
          traces.push(
            Object.freeze({
              ...baseTrace,
              actionMs: elapsed(actionStarted),
              outcome: "unknown",
            }),
          );
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason: ambiguous
              ? "Action dispatch became ambiguous; the controller stopped without retrying."
              : "Cua refused or failed the action; the controller stopped without changing delivery route.",
            model: lastModel,
            frontierFallbackRecommended: !ambiguous,
            reconciliationRequired: ambiguous,
            safeToRetry: false,
          });
        }
        const actionMs = elapsed(actionStarted);
        let postVerified = false;
        let stepVerified = false;
        let postVerificationMs: number;
        try {
          await this.dependencies.runs.markPhase(
            runKeyHash,
            runId,
            "action_returned",
          );
          await this.trace(runId, {
            event: "action_returned",
            step,
            operation_id: operationId,
            action_ms: actionMs,
          });
          const postVerificationStarted = performance.now();
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const postObservation = await observeBrowser(
              this.dependencies.driver,
              bound,
              session,
              request.allowedOrigins,
              signal,
            );
            if (postObservation.complete) {
              reconcileWorkflowProgress(
                postObservation,
                request,
                completedActions,
              );
              stepVerified = completedActions.has(actionCandidate.semanticKey);
              postVerified = verifySuccess(
                postObservation,
                request.success,
                request.values,
              );
              if (stepVerified || postVerified) break;
            }
            if (attempt < 7) {
              await delay(250, undefined, signal ? { signal } : undefined);
            }
          }
          if (!stepVerified && !postVerified) {
            throw new Error(
              "the exact reviewed step postcondition was not satisfied",
            );
          }
          postVerificationMs = elapsed(postVerificationStarted);
          await this.trace(runId, {
            event: "postcondition_checked",
            step,
            operation_id: operationId,
            step_satisfied: stepVerified,
            workflow_satisfied: postVerified,
            verification_ms: postVerificationMs,
          });
        } catch (error: unknown) {
          traces.push(
            Object.freeze({ ...baseTrace, actionMs, outcome: "unknown" }),
          );
          await this.trace(runId, {
            event: "postcondition_failed",
            step,
            operation_id: operationId,
            error: error instanceof Error ? error.name : "UnknownError",
          }).catch(() => undefined);
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "unknown",
            reason:
              "The action returned, but its postcondition could not be independently verified; it will not be retried.",
            model: lastModel,
            frontierFallbackRecommended: false,
            reconciliationRequired: true,
            safeToRetry: false,
          });
        }
        traces.push(
          Object.freeze({
            ...baseTrace,
            actionMs,
            verificationMs: postVerificationMs,
          }),
        );
        if (postVerified) {
          return finish({
            runId,
            runKeyHash,
            startedAt,
            steps: traces,
            outcome: "verified",
            reason:
              "The deterministic success condition is satisfied after the action.",
            model: lastModel,
            frontierFallbackRecommended: false,
          });
        }
      }

      return finish({
        runId,
        runKeyHash,
        startedAt,
        steps: traces,
        outcome: "budget_exhausted",
        reason: "The run reached its step budget.",
        model: lastModel,
        frontierFallbackRecommended: true,
      });
    } finally {
      try {
        await this.dependencies.driver.call("end_session", { session });
      } catch {
        // Session cleanup cannot justify replaying or changing the run outcome.
      }
    }
  }

  private finish(
    input: Omit<
      RunResult,
      "finishedAt" | "reconciliationRequired" | "safeToRetry"
    > &
      Partial<Pick<RunResult, "reconciliationRequired" | "safeToRetry">>,
  ): RunResult {
    return Object.freeze({
      ...input,
      steps: Object.freeze([...input.steps]),
      reconciliationRequired: input.reconciliationRequired ?? false,
      safeToRetry: input.safeToRetry ?? false,
      finishedAt: new Date().toISOString(),
    });
  }

  private async trace(
    runId: string,
    event: Readonly<Record<string, JsonValue>>,
  ): Promise<void> {
    await this.dependencies.traces.append(runId, {
      schema: "jev-cua.run-event.v1",
      timestamp: new Date().toISOString(),
      ...event,
    });
  }
}

function candidateClass(
  candidate: Readonly<{ semanticKey: string; action: { tool: string } | null }>,
): string {
  return candidate.action?.tool ?? candidate.semanticKey;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function classifyFailure(error: unknown): string {
  if (error instanceof Error && error.message.includes("busy"))
    return "The physical desktop is busy with another controller run.";
  if (error instanceof Error && error.message.includes("permission"))
    return "Cua Driver requires desktop permissions or setup.";
  return `The run failed before a verified outcome (${error instanceof Error ? error.name : "UnknownError"}).`;
}
