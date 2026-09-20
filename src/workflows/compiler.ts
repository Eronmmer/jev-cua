import type {
  BrowserObservation,
  Candidate,
  JsonValue,
  RiskClass,
  ValueSlot,
} from "../types.js";
import { classifyLabelRisk } from "../policy/risk.js";
import { canonicalJson, deepFreeze, randomOpaqueId, sha256 } from "../util.js";
import {
  capabilityApprovesWorkflow,
  type WorkflowApprovalCapability,
} from "./approval.js";
import type {
  CompiledWorkflow,
  WorkflowField,
  WorkflowRequirement,
} from "./types.js";

function exactFieldMatches(
  observation: BrowserObservation,
  field: WorkflowField,
) {
  return observation.refs.filter(
    (ref) =>
      !ref.disabled &&
      ref.role === field.role &&
      ref.name === field.name &&
      ref.frame === "main" &&
      ref.visibility === "in_viewport",
  );
}

function inputValue(values: readonly ValueSlot[], id: string): string {
  const matches = values.filter((value) => value.id === id);
  if (matches.length !== 1)
    throw new Error(`compiled workflow input ${id} is absent or ambiguous`);
  return matches[0]!.value;
}

function workflowInput(workflow: CompiledWorkflow, id: string) {
  const matches = workflow.inputs.filter((input) => input.id === id);
  if (matches.length !== 1)
    throw new Error(`compiled workflow input ${id} is absent or ambiguous`);
  return matches[0]!;
}

export function compiledWorkflowStepRisk(
  workflow: CompiledWorkflow,
  step: CompiledWorkflow["steps"][number],
): RiskClass {
  const declaredRisk: RiskClass =
    step.action.kind === "type"
      ? workflowInput(workflow, step.action.inputId).classification ===
        "private"
        ? "r2_private"
        : "r1_reversible"
      : step.action.kind === "click" &&
          step.action.effect === "consequential_submit"
        ? "r3_consequential"
        : "r1_reversible";
  const relatedInput =
    step.action.kind === "type"
      ? workflowInput(workflow, step.action.inputId)
      : undefined;
  const safetyLabel = [
    step.description,
    step.action.kind === "type"
      ? `${step.action.field.role} ${step.action.field.name}`
      : step.action.kind === "click"
        ? `${step.action.control.role} ${step.action.control.name}`
        : `${step.action.region.role} ${step.action.region.name}`,
    relatedInput ? `${relatedInput.id} ${relatedInput.description}` : "",
  ].join(" ");
  const semanticFloor = classifyLabelRisk(safetyLabel);
  return semanticFloor === "r4_forbidden" ||
    semanticFloor === "r3_consequential"
    ? semanticFloor
    : declaredRisk;
}

function requirementSatisfied(
  requirement: WorkflowRequirement,
  observation: BrowserObservation,
  values: readonly ValueSlot[],
): boolean {
  const matches = exactFieldMatches(observation, requirement.field);
  if (matches.length !== 1) return false;
  return matches[0]!.value === inputValue(values, requirement.inputId);
}

function candidate(
  workflow: CompiledWorkflow,
  step: CompiledWorkflow["steps"][number],
  observation: BrowserObservation,
  values: readonly ValueSlot[],
): Candidate | undefined {
  const page = new URL(observation.url);
  if (
    page.origin !== step.page.origin ||
    page.pathname !== step.page.pathname ||
    page.search !== "" ||
    page.hash !== ""
  ) {
    return undefined;
  }
  if (
    !step.requires.every((requirement) =>
      requirementSatisfied(requirement, observation, values),
    )
  ) {
    return undefined;
  }
  let tool: string;
  let arguments_: Record<string, JsonValue>;
  if (step.action.kind === "type") {
    const matches = exactFieldMatches(observation, step.action.field).filter(
      (ref) => ref.actions.includes("type"),
    );
    if (matches.length !== 1) return undefined;
    const text = inputValue(values, step.action.inputId);
    const declaredInput = workflowInput(workflow, step.action.inputId);
    const pageOrigin = new URL(observation.url).origin;
    if (!declaredInput.allowedDisclosureOrigins.includes(pageOrigin))
      return undefined;
    tool = "browser_type";
    arguments_ = {
      target_id: observation.targetId,
      tab_id: observation.tabId,
      ref: matches[0]!.ref,
      text,
      replace: true,
      mode: "insert_text",
    };
  } else if (step.action.kind === "click") {
    const matches = exactFieldMatches(observation, step.action.control).filter(
      (ref) => ref.actions.includes("click"),
    );
    if (matches.length !== 1) return undefined;
    tool = "browser_click";
    arguments_ = {
      target_id: observation.targetId,
      tab_id: observation.tabId,
      ref: matches[0]!.ref,
      input_route: step.action.inputRoute,
    };
  } else {
    const matches = exactFieldMatches(observation, step.action.region).filter(
      (ref) => ref.actions.includes("scroll"),
    );
    if (matches.length !== 1) return undefined;
    tool = "browser_pointer";
    arguments_ = {
      target_id: observation.targetId,
      tab_id: observation.tabId,
      ref: matches[0]!.ref,
      action: "scroll",
      input_route: "dom_event",
      delta_y:
        step.action.direction === "down"
          ? step.action.pixels
          : -step.action.pixels,
    };
  }
  const frozenArguments = deepFreeze(structuredClone(arguments_));
  const risk = compiledWorkflowStepRisk(workflow, step);
  return deepFreeze({
    id: randomOpaqueId(),
    semanticKey: `workflow:${workflow.id}:${workflow.version}:${step.id}`,
    description: step.description,
    risk,
    action: { tool, arguments: frozenArguments },
    actionDigest: sha256(canonicalJson({ tool, arguments: frozenArguments })),
    expectedEffect: `Advance reviewed workflow step ${step.id}.`,
    observationDigest: observation.digest,
  });
}

function reserved(
  semanticKey: "reobserve" | "abstain" | "escalate",
  digest: string,
): Candidate {
  return deepFreeze({
    id: randomOpaqueId(),
    semanticKey,
    description:
      semanticKey === "reobserve"
        ? "Obtain a fresh Cua observation without acting."
        : semanticKey === "abstain"
          ? "Stop without acting because the reviewed workflow step is not proven."
          : "Return control because the page does not match the compiled workflow.",
    risk: "r0_read_only",
    action: null,
    actionDigest: null,
    expectedEffect: "No computer input is dispatched.",
    observationDigest: digest,
  });
}

export function buildCompiledWorkflowCandidates(
  input: Readonly<{
    workflow: CompiledWorkflow;
    observation: BrowserObservation;
    values: readonly ValueSlot[];
    completedSemanticKeys?: ReadonlySet<string>;
    approval?: WorkflowApprovalCapability;
  }>,
): readonly Candidate[] {
  const completed = input.completedSemanticKeys ?? new Set<string>();
  const stepKeys = input.workflow.steps.map(
    (step) =>
      `workflow:${input.workflow.id}:${input.workflow.version}:${step.id}`,
  );
  const completedCount = stepKeys.filter((key) => completed.has(key)).length;
  if (
    completedCount !== completed.size ||
    stepKeys.slice(0, completedCount).some((key) => !completed.has(key)) ||
    stepKeys.slice(completedCount).some((key) => completed.has(key))
  ) {
    throw new Error(
      "compiled workflow progress is not a contiguous reviewed prefix",
    );
  }
  const nextStep = input.workflow.steps[completedCount];
  const next = nextStep
    ? candidate(input.workflow, nextStep, input.observation, input.values)
    : undefined;
  const approved = capabilityApprovesWorkflow(input.approval, input.workflow);
  const bounded = next
    ? [
        next.risk === "r2_private" || next.risk === "r3_consequential"
          ? deepFreeze({
              ...next,
              ...(approved
                ? { authorization: "approved_workflow" as const }
                : {}),
            })
          : next,
      ]
    : [];
  return deepFreeze([
    ...bounded,
    reserved("reobserve", input.observation.digest),
    reserved("abstain", input.observation.digest),
    reserved("escalate", input.observation.digest),
  ]);
}
