import { execFile as execFileCallback } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadRuntimeConfig } from "./config.js";
import { loadTypeSafeCredential } from "./credentials.js";
import {
  CuaMcpClient,
  DriverToolError,
  resolveCuaDriverBinary,
} from "./cua/client.js";
import {
  assessCuaCompatibility,
  verifyCuaDriverProvenance,
} from "./cua/compatibility.js";
import { FastpathController } from "./engine/controller.js";
import { TypeSafeDecisionPolicy } from "./jev/typesafe-policy.js";
import { workflowPolicyFingerprint } from "./policy/fingerprint.js";
import {
  DesktopLease,
  JsonlTraceSink,
  RunStore,
  pathIsExecutable,
} from "./state.js";
import type { JsonValue, RunResult } from "./types.js";
import {
  buildCompiledWorkflowCandidates,
  compiledWorkflowStepRisk,
} from "./workflows/compiler.js";
import {
  acquireWorkflowApproval,
  readWorkflowApproval,
} from "./workflows/approval.js";
import {
  bindWorkflowInputs,
  loadWorkflowManifests,
} from "./workflows/manifest.js";

const execFile = promisify(execFileCallback);
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
  config: ReturnType<typeof loadRuntimeConfig>;
  traces: JsonlTraceSink;
}>;

let runtimePromise: Promise<Runtime> | undefined;

async function readCuaTelemetryStatus(binary: string): Promise<{
  enabled: boolean;
  source: string | null;
}> {
  const { stdout } = await execFile(binary, ["telemetry", "status", "--json"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  const value = JSON.parse(stdout) as Record<string, unknown>;
  if (typeof value.enabled !== "boolean") {
    throw new Error("Cua telemetry status is malformed");
  }
  return {
    enabled: value.enabled,
    source: typeof value.source === "string" ? value.source : null,
  };
}

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
      return Object.freeze({
        binary,
        driver,
        lease,
        runs,
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
    let driverVersion: string | null = null;
    let driverTools: number | null = null;
    let driverError: string | null = null;
    let driverRefusalCode: string | null = null;
    let health: Record<string, unknown> | null = null;
    let permissions: Record<string, unknown> | null = null;
    let requiredToolsPresent = false;
    let receiptSchemasMatch = false;
    let driverContractCompatible = false;
    let compatibilityReasons: readonly string[] = [];
    let provenanceTrusted = false;
    let provenanceReasons: readonly string[] = [];
    let telemetry: { enabled: boolean; source: string | null } | null = null;
    try {
      const provenance = await verifyCuaDriverProvenance(current.binary);
      provenanceTrusted = provenance.trusted;
      provenanceReasons = provenance.reasons;
      if (!provenance.trusted) {
        driverError = "UntrustedDriver";
      } else {
        const { stdout } = await execFile(current.binary, ["--version"], {
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
        driverVersion = stdout.trim().slice(0, 160);
        telemetry = await readCuaTelemetryStatus(current.binary);
        const tools = await current.driver.listTools();
        driverTools = tools.length;
        const compatibility = assessCuaCompatibility(driverVersion, tools);
        requiredToolsPresent = compatibility.requiredToolsPresent;
        receiptSchemasMatch = compatibility.receiptSchemasMatch;
        driverContractCompatible = compatibility.compatible;
        compatibilityReasons = compatibility.reasons;
        health = await current.driver.call("health_report", {});
        permissions = await current.driver.call("check_permissions", {
          prompt: false,
        });
      }
    } catch (error: unknown) {
      driverError = error instanceof Error ? error.name : "UnknownError";
      driverRefusalCode =
        error instanceof DriverToolError ? (error.refusalCode ?? null) : null;
    }
    const permissionsReady =
      permissions?.accessibility === true &&
      permissions?.screen_recording === true;
    const driverReady =
      Boolean(driverVersion) &&
      provenanceTrusted &&
      driverContractCompatible &&
      health?.schema_version === "1" &&
      health.overall === "ok" &&
      permissionsReady &&
      telemetry?.enabled === false &&
      !driverError;
    return toolResult({
      status: driverReady && credential.apiKey ? "ready" : "setup_required",
      runtime_version: VERSION,
      build: process.env.JEV_CUA_BUILD_SHA?.trim() || "development",
      cua: {
        binary: current.binary,
        binary_is_executable:
          current.binary === "cua-driver"
            ? null
            : await pathIsExecutable(current.binary),
        version: driverVersion,
        advertised_tools: driverTools,
        required_tools_present: requiredToolsPresent,
        action_receipt_schemas_match: receiptSchemasMatch,
        contract_compatible: driverContractCompatible,
        compatibility_reasons: compatibilityReasons,
        provenance_trusted: provenanceTrusted,
        provenance_reasons: provenanceReasons,
        telemetry,
        health,
        permissions,
        error: driverError,
        refusal_code: driverRefusalCode,
        setup_command:
          driverRefusalCode === "permissions_pending"
            ? "cua-driver permissions grant"
            : null,
      },
      typesafe: {
        credential_present: Boolean(credential.apiKey),
        credential_source: credential.source,
        model: current.config.model,
      },
      desktop_lease: await current.lease.status(),
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
      try {
        const provenance = await verifyCuaDriverProvenance(current.binary);
        if (!provenance.trusted) {
          return toolResult({
            outcome: "setup_required",
            reason: `The Cua Driver binary is not from the reviewed signed installation: ${provenance.reasons.join("; ")}.`,
            frontier_fallback_recommended: false,
            reconciliation_required: false,
            safe_to_retry: false,
          });
        }
        const [{ stdout }, tools, telemetry] = await Promise.all([
          execFile(current.binary, ["--version"], {
            timeout: 5_000,
            maxBuffer: 64 * 1024,
          }),
          current.driver.listTools(),
          readCuaTelemetryStatus(current.binary),
        ]);
        if (telemetry.enabled) {
          return toolResult({
            outcome: "setup_required",
            reason:
              "Cua telemetry is enabled. Run `cua-driver telemetry disable` before live workflows.",
            frontier_fallback_recommended: false,
            reconciliation_required: false,
            safe_to_retry: false,
          });
        }
        const compatibility = assessCuaCompatibility(stdout.trim(), tools);
        if (!compatibility.compatible) {
          return toolResult({
            outcome: "setup_required",
            reason: `The installed Cua Driver does not match the reviewed runtime contract: ${compatibility.reasons.join("; ")}.`,
            frontier_fallback_recommended: false,
            reconciliation_required: false,
            safe_to_retry: false,
          });
        }
      } catch (error: unknown) {
        return toolResult({
          outcome: "setup_required",
          reason: `The reviewed Cua Driver runtime contract could not be verified (${error instanceof Error ? error.name : "UnknownError"}).`,
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
    const policyFingerprint = workflowPolicyFingerprint(
      invocation.workflow.digest,
      current.config,
    );
    const controller = new FastpathController({
      driver: current.driver,
      policy: TypeSafeDecisionPolicy.create(
        apiKey ?? "shadow-not-used",
        current.config,
      ),
      config: current.config,
      lease: current.lease,
      runs: current.runs,
      traces: current.traces,
      candidateBuilder: ({ observation, values, completedSemanticKeys }) =>
        buildCompiledWorkflowCandidates({
          workflow: invocation.workflow,
          observation,
          values,
          completedSemanticKeys,
          ...(authorization.capability
            ? { approval: authorization.capability }
            : {}),
        }),
      candidateSemanticPrefix: `workflow:${invocation.workflow.id}:${invocation.workflow.version}:`,
      policyFingerprint,
    });
    const result = await controller.run(
      Object.freeze({
        runKey: input.run_key,
        policyFingerprint,
        goal: invocation.workflow.goal,
        target: invocation.workflow.target,
        values: invocation.values,
        success: invocation.workflow.success,
        allowedOrigins: invocation.workflow.allowedOrigins,
        mode: input.mode,
        maxSteps: input.max_steps,
        maxWallTimeMs: input.max_wall_time_ms,
        workflowSteps: invocation.workflow.steps.map((step) => ({
          semanticKey: `workflow:${invocation.workflow.id}:${invocation.workflow.version}:${step.id}`,
          ensures: step.ensures,
        })),
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
      const reconciliationRequired =
        stored.phase === "browser_setup_started" ||
        stored.phase === "action_started" ||
        stored.phase === "action_returned";
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
