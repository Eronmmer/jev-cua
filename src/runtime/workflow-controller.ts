import type { RuntimeConfig } from "../config.js";
import { FastpathController } from "../engine/controller.js";
import { workflowPolicyFingerprint } from "../policy/fingerprint.js";
import { DesktopLease, LiveExecutionBarrier, RunStore } from "../state.js";
import type {
  DecisionPolicy,
  DriverClient,
  RunMode,
  RunRequest,
  TraceSink,
  ValueSlot,
} from "../types.js";
import type { WorkflowApprovalCapability } from "../workflows/approval.js";
import { buildCompiledWorkflowCandidates } from "../workflows/compiler.js";
import type { CompiledWorkflow } from "../workflows/types.js";

export type CompiledWorkflowRuntime = Readonly<{
  controller: FastpathController;
  policyFingerprint: string;
  createRequest: (
    input: Readonly<{
      runKey: string;
      mode: RunMode;
      maxSteps: number;
      maxWallTimeMs: number;
    }>,
  ) => RunRequest;
}>;

export function createCompiledWorkflowRuntime(
  input: Readonly<{
    driver: DriverClient;
    policy: DecisionPolicy;
    decisionPolicyIdentity: string;
    config: RuntimeConfig;
    lease: DesktopLease;
    runs: RunStore;
    safetyRuns: RunStore;
    executionBarrier: LiveExecutionBarrier;
    isolatedCleanupResolvesReconciliation?: boolean;
    traces: TraceSink;
    workflow: CompiledWorkflow;
    values: readonly ValueSlot[];
    approval?: WorkflowApprovalCapability;
  }>,
): CompiledWorkflowRuntime {
  if (!input.decisionPolicyIdentity.trim()) {
    throw new Error("decision policy identity cannot be empty");
  }
  const candidateSemanticPrefix = `workflow:${input.workflow.id}:${input.workflow.version}:`;
  const policyFingerprint = workflowPolicyFingerprint(
    input.workflow.digest,
    input.config,
    input.decisionPolicyIdentity,
  );
  const controller = new FastpathController({
    driver: input.driver,
    policy: input.policy,
    config: input.config,
    lease: input.lease,
    runs: input.runs,
    safetyRuns: input.safetyRuns,
    executionBarrier: input.executionBarrier,
    isolatedCleanupResolvesReconciliation:
      input.isolatedCleanupResolvesReconciliation ?? false,
    traces: input.traces,
    candidateBuilder: ({ observation, values, completedSemanticKeys }) =>
      buildCompiledWorkflowCandidates({
        workflow: input.workflow,
        observation,
        values,
        completedSemanticKeys,
        ...(input.approval ? { approval: input.approval } : {}),
      }),
    candidateSemanticPrefix,
    policyFingerprint,
    expectedDecisionModel: input.decisionPolicyIdentity,
  });

  return Object.freeze({
    controller,
    policyFingerprint,
    createRequest: ({ runKey, mode, maxSteps, maxWallTimeMs }) =>
      Object.freeze({
        runKey,
        policyFingerprint,
        goal: input.workflow.goal,
        target: input.workflow.target,
        values: input.values,
        success: input.workflow.success,
        allowedOrigins: input.workflow.allowedOrigins,
        mode,
        maxSteps,
        maxWallTimeMs,
        workflowSteps: input.workflow.steps.map((step) =>
          Object.freeze({
            semanticKey: `${candidateSemanticPrefix}${step.id}`,
            ensures: step.ensures,
          }),
        ),
      }),
  });
}
