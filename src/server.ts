import { userInfo } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadRuntimeConfig } from "./config.js";
import { loadTypeSafeCredential } from "./credentials.js";
import { CuaMcpClient, resolveCuaDriverBinary } from "./cua/client.js";
import { cuaReadinessFailure, probeCuaReadiness } from "./cua/readiness.js";
import { TypeSafeDecisionPolicy } from "./jev/typesafe-policy.js";
import { createCompiledWorkflowRuntime } from "./runtime/workflow-controller.js";
import {
  DesktopLease,
  JsonlTraceSink,
  LiveExecutionBarrier,
  RunStore,
  activeRunRequiresReconciliation,
  pathIsExecutable,
} from "./state.js";
import type { JsonValue, RunResult } from "./types.js";
import {
  assertSupportedNodeRuntime,
  isSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
} from "./runtime/node-version.js";
import { compiledWorkflowStepRisk } from "./workflows/compiler.js";
import {
  acquireWorkflowApproval,
  readWorkflowApproval,
} from "./workflows/approval.js";
import {
  bindWorkflowInputs,
  loadWorkflowManifests,
} from "./workflows/manifest.js";

assertSupportedNodeRuntime();

const VERSION = "0.1.0";

const workflowRunSchema = z
  .object({
    workflow_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    workflow_version: z.number().int().positive(),
    workflow_digest: z.string().regex(/^[a-f0-9]{64}$/u),
    run_key: z.string().min(8).max(160),
    inputs: z.record(z.string(), z.string().max(65_536)).default({}),
    mode: z.enum(["shadow", "live"]).default("shadow"),
    max_steps: z.number().int().min(1).max(50).default(12),
    max_wall_time_ms: z.number().int().min(1_000).max(240_000).default(60_000),
  })
  .strict();

type Runtime = Readonly<{
  binary: string;
  driver: CuaMcpClient;
  lease: DesktopLease;
  runs: RunStore;
  executionBarrier: LiveExecutionBarrier;
  config: ReturnType<typeof loadRuntimeConfig>;
  traces: JsonlTraceSink;
}>;

let runtimePromise: Promise<Runtime> | undefined;

async function runtime(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const config = loadRuntimeConfig();
      const binary = await resolveCuaDriverBinary();
      const driver = new CuaMcpClient(binary);
      // The desktop and at-most-once run-key ledger are shared capabilities. Keep both
      // independent of caller-configurable workflow and trace directories.
      const trustedRuntimeState = join(
        userInfo().homedir,
        ".local",
        "state",
        "jev-cua-runtime",
      );
      const lease = new DesktopLease(trustedRuntimeState);
      const runs = new RunStore(trustedRuntimeState);
      const executionBarrier = new LiveExecutionBarrier(trustedRuntimeState);
      return Object.freeze({
        binary,
        driver,
        lease,
        runs,
        executionBarrier,
        config,
        traces: new JsonlTraceSink(config.stateDirectory),
      });
    })();
  }
  return runtimePromise;
}

function toolResult(value: Readonly<Record<string, unknown>>) {
  const text = JSON.stringify(value);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value,
  };
}

const server = new McpServer(
  { name: "jev-cua", version: VERSION },
  { capabilities: { logging: {} } },
);

server.registerTool(
  "jev_cua_doctor",
  {
    title: "Check Jev Cua readiness",
    description:
      "Read-only readiness check for Cua Driver, the TypeSafe credential, and the desktop lease.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const current = await runtime();
    const credential = await loadTypeSafeCredential();
    const readiness = await probeCuaReadiness(current.binary, current.driver);
    const [executionBarrier, durableRuns] = await Promise.all([
      current.executionBarrier.status(),
      current.runs.liveExecutionStatus(),
    ]);
    return toolResult({
      status:
        readiness.ready &&
        credential.apiKey &&
        !executionBarrier.blocked &&
        !durableRuns.blocked
          ? "ready"
          : "setup_required",
      runtime_version: VERSION,
      node_runtime: {
        current: process.versions.node,
        minimum: MINIMUM_NODE_VERSION,
        supported: isSupportedNodeVersion(process.versions.node),
      },
      build: process.env.JEV_CUA_BUILD_SHA?.trim() || "development",
      cua: {
        binary: current.binary,
        binary_is_executable:
          current.binary === "cua-driver"
            ? null
            : await pathIsExecutable(current.binary),
        version: readiness.driverVersion,
        advertised_tools: readiness.driverTools,
        required_tools_present: readiness.requiredToolsPresent,
        action_receipt_schemas_match: readiness.receiptSchemasMatch,
        cleanup_receipt_schema_matches: readiness.cleanupReceiptSchemaMatches,
        contract_compatible: readiness.driverContractCompatible,
        compatibility_reasons: readiness.compatibilityReasons,
        provenance_trusted: readiness.provenanceTrusted,
        provenance_reasons: readiness.provenanceReasons,
        telemetry: readiness.telemetry,
        health: readiness.health,
        permissions: readiness.permissions,
        error: readiness.driverError,
        refusal_code: readiness.driverRefusalCode,
        setup_command:
          readiness.driverRefusalCode === "permissions_pending" ||
          (readiness.permissions !== null && !readiness.permissionsReady)
            ? "cua-driver permissions grant"
            : null,
      },
      typesafe: {
        credential_present: Boolean(credential.apiKey),
        credential_source: credential.source,
        model: current.config.model,
      },
      desktop_lease: await current.lease.status(),
      live_execution_safety: {
        barrier: executionBarrier,
        durable_runs: durableRuns,
      },
    });
  },
);

server.registerTool(
  "jev_cua_list_workflows",
  {
    title: "List Jev Cua workflows",
    description:
      "List the production workflow engines currently available through Jev Cua.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const current = await runtime();
    const compiled = (
      await loadWorkflowManifests(current.config.workflowDirectory)
    ).filter((workflow) => workflow.enabled);
    const approvals = await Promise.all(
      compiled.map((workflow) => readWorkflowApproval(workflow)),
    );
    return toolResult({
      workflows: compiled.map((workflow, index) => ({
        id: workflow.id,
        version: workflow.version,
        digest: workflow.digest,
        modes: ["shadow", "live"],
        approval: approvals[index],
        description: workflow.description,
        required_inputs: workflow.inputs.map((input) => ({
          id: input.id,
          description: input.description,
        })),
      })),
    });
  },
);

server.registerTool(
  "jev_cua_run_workflow",
  {
    title: "Run a compiled Jev Cua workflow",
    description:
      "Run an installed, locally reviewed workflow manifest. The manifest—not the caller—fixes the origin, controls, input mappings, candidate descriptions, and deterministic postcondition. Start with shadow mode; live mode may dispatch only exact compiled steps.",
    inputSchema: workflowRunSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const current = await runtime();
    const workflows = await loadWorkflowManifests(
      current.config.workflowDirectory,
    );
    const matches = workflows.filter(
      (workflow) =>
        workflow.enabled &&
        workflow.id === input.workflow_id &&
        workflow.version === input.workflow_version &&
        workflow.digest === input.workflow_digest,
    );
    if (matches.length !== 1) {
      return toolResult({
        outcome: "denied",
        reason:
          "The requested workflow ID, version, and digest are not uniquely present and enabled in the trusted local workflow directory.",
        frontier_fallback_recommended: false,
        reconciliation_required: false,
        safe_to_retry: false,
      });
    }
    const invocation = bindWorkflowInputs(matches[0]!, input.inputs);
    const authorization = await acquireWorkflowApproval(invocation.workflow);
    if (input.mode === "live" && !authorization.capability) {
      return toolResult({
        outcome: "denied",
        reason: `The exact workflow digest is not approved in macOS Keychain (${authorization.status.reason}).`,
        workflow_id: invocation.workflow.id,
        workflow_version: invocation.workflow.version,
        workflow_digest: invocation.workflow.digest,
        frontier_fallback_recommended: false,
        reconciliation_required: false,
        safe_to_retry: false,
      });
    }
    if (input.mode === "live") {
      const readiness = await probeCuaReadiness(current.binary, current.driver);
      const readinessFailure = cuaReadinessFailure(readiness);
      if (readinessFailure) {
        return toolResult({
          outcome: "setup_required",
          reason: `The reviewed Cua Driver runtime is not ready: ${readinessFailure}.`,
          frontier_fallback_recommended: false,
          reconciliation_required: false,
          safe_to_retry: false,
        });
      }
    }
    const credential =
      input.mode === "live"
        ? await loadTypeSafeCredential()
        : { apiKey: "shadow-not-used", source: "none" as const };
    const apiKey = credential.apiKey;
    if (input.mode === "live" && !apiKey) {
      return toolResult({
        outcome: "setup_required",
        reason:
          "No TypeSafe credential is available. Store it in the environment or macOS Keychain service ai.typesafe.jev-cua.",
        frontier_fallback_recommended: false,
        reconciliation_required: false,
        safe_to_retry: false,
      });
    }
    const execution = createCompiledWorkflowRuntime({
      driver: current.driver,
      policy: TypeSafeDecisionPolicy.create(
        apiKey ?? "shadow-not-used",
        current.config,
      ),
      decisionPolicyIdentity: current.config.model,
      config: current.config,
      lease: current.lease,
      runs: current.runs,
      safetyRuns: current.runs,
      executionBarrier: current.executionBarrier,
      traces: current.traces,
      workflow: invocation.workflow,
      values: invocation.values,
      ...(authorization.capability
        ? { approval: authorization.capability }
        : {}),
    });
    const result = await execution.controller.run(
      execution.createRequest({
        runKey: input.run_key,
        mode: input.mode,
        maxSteps: input.max_steps,
        maxWallTimeMs: input.max_wall_time_ms,
      }),
      extra.signal,
    );
    return toolResult({
      ...publicRunResult(result),
      workflow_id: invocation.workflow.id,
      workflow_version: invocation.workflow.version,
      workflow_digest: invocation.workflow.digest,
      ...(input.mode === "shadow"
        ? {
            shadow_plan: invocation.workflow.steps.map((step) => ({
              id: step.id,
              description: step.description,
              exact_page: step.page,
              prerequisites: step.requires,
              fixed_action: step.action,
              effective_risk: compiledWorkflowStepRisk(
                invocation.workflow,
                step,
              ),
              exact_postcondition: step.ensures,
            })),
            live_run_key_requirement:
              "Use a distinct new run_key for a later live attempt; a shadow key is durably bound to shadow validation.",
          }
        : {}),
    });
  },
);

server.registerTool(
  "jev_cua_get_run",
  {
    title: "Get a Jev Cua run",
    description:
      "Read the content-free durable status recorded for an idempotency key.",
    inputSchema: z.object({ run_key: z.string().min(8).max(160) }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ run_key }) => {
    const current = await runtime();
    const stored = await current.runs.get(run_key);
    if (!stored) return toolResult({ status: "not_found" });
    if (stored.status === "active") {
      const reconciliationRequired = activeRunRequiresReconciliation(
        stored.phase,
      );
      return toolResult({
        status: "active_or_unknown",
        run_id: stored.runId,
        started_at: stored.startedAt,
        phase: stored.phase,
        operation: stored.operation
          ? {
              policy_fingerprint: stored.operation.policyFingerprint,
              semantic_step: stored.operation.semanticStep,
              action_class: stored.operation.actionClass,
              operation_id: stored.operation.operationId,
            }
          : null,
        reconciliation_required: reconciliationRequired,
        safe_to_retry: false,
        note: "An interrupted record is never replayed automatically.",
      });
    }
    return toolResult({
      status: "complete",
      last_phase: stored.lastPhase,
      result: publicRunResult(stored.result),
    });
  },
);

function publicRunResult(result: RunResult): Record<string, JsonValue> {
  return {
    run_id: result.runId,
    outcome: result.outcome,
    reason: result.reason,
    steps: result.steps.map((step) => ({
      step: step.step,
      candidate_count: step.candidateCount,
      selected_semantic_key: step.selectedSemanticKey ?? null,
      risk: step.risk ?? null,
      decision_ms: step.decisionMs,
      action_ms: step.actionMs,
      verification_ms: step.verificationMs,
      outcome: step.outcome ?? null,
    })),
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    model: result.model ?? null,
    frontier_fallback_recommended: result.frontierFallbackRecommended,
    reconciliation_required: result.reconciliationRequired,
    safe_to_retry: result.safeToRetry,
    cleanup_succeeded: result.cleanupSucceeded ?? null,
  };
}

let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    try {
      const current = await runtimePromise;
      if (current) await current.driver.close();
    } finally {
      await server.close();
    }
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  });
}

const transport = new StdioServerTransport();
process.stdin.once("end", () => {
  void shutdown();
});
server.connect(transport).catch((error: unknown) => {
  process.stderr.write(
    `jev-cua failed to start: ${error instanceof Error ? error.name : "UnknownError"}\n`,
  );
  process.exitCode = 1;
});
