import type {
  BrowserObservation,
  Candidate,
  JsonValue,
  ValueSlot,
} from "../types.js";
import { canonicalJson, sha256 } from "../util.js";

function exactKeys(
  value: Readonly<Record<string, JsonValue>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function refFor(
  observation: BrowserObservation,
  refValue: JsonValue | undefined,
  action: "click" | "type" | "scroll",
) {
  if (typeof refValue !== "string")
    throw new Error("candidate action has no exact semantic ref");
  const matches = observation.refs.filter(
    (ref) => ref.ref === refValue && ref.actions.includes(action),
  );
  if (
    matches.length !== 1 ||
    matches[0]!.disabled ||
    matches[0]!.frame !== "main" ||
    matches[0]!.visibility !== "in_viewport"
  ) {
    throw new Error(
      "candidate action ref is absent, ambiguous, disabled, or lacks the required capability",
    );
  }
}

function validateAction(
  candidate: Candidate,
  observation: BrowserObservation,
  values: readonly ValueSlot[],
): void {
  const action = candidate.action;
  if (!action) return;
  if (
    candidate.risk === "r0_read_only" ||
    ((candidate.risk === "r2_private" ||
      candidate.risk === "r3_consequential") &&
      candidate.authorization !== "approved_workflow")
  ) {
    throw new Error(
      "executable candidate is outside its reviewed workflow authorization",
    );
  }
  const args = action.arguments;
  if (
    args.target_id !== observation.targetId ||
    args.tab_id !== observation.tabId
  ) {
    throw new Error("candidate action targets a different browser capability");
  }
  if (action.tool === "browser_click") {
    if (!exactKeys(args, ["target_id", "tab_id", "ref", "input_route"])) {
      throw new Error("browser_click candidate has unsupported arguments");
    }
    if (args.input_route !== "dom_event" && args.input_route !== "trusted") {
      throw new Error("browser_click candidate has an unsupported input route");
    }
    refFor(observation, args.ref, "click");
  } else if (action.tool === "browser_type") {
    if (
      !exactKeys(args, [
        "target_id",
        "tab_id",
        "ref",
        "text",
        "replace",
        "mode",
      ])
    ) {
      throw new Error("browser_type candidate has unsupported arguments");
    }
    if (args.replace !== true || args.mode !== "insert_text") {
      throw new Error(
        "browser_type candidate must use the reviewed replacement route",
      );
    }
    if (
      typeof args.text !== "string" ||
      !values.some((value) => !value.secret && value.value === args.text)
    ) {
      throw new Error(
        "browser_type candidate text is not an approved non-secret workflow input",
      );
    }
    refFor(observation, args.ref, "type");
  } else if (action.tool === "browser_pointer") {
    if (
      !exactKeys(args, [
        "target_id",
        "tab_id",
        "ref",
        "action",
        "input_route",
        "delta_y",
      ])
    ) {
      throw new Error("browser_pointer candidate has unsupported arguments");
    }
    if (
      args.action !== "scroll" ||
      args.input_route !== "dom_event" ||
      typeof args.delta_y !== "number" ||
      !Number.isFinite(args.delta_y) ||
      Math.abs(args.delta_y) > 1_000
    ) {
      throw new Error(
        "browser_pointer candidate is outside the reviewed scroll shape",
      );
    }
    refFor(observation, args.ref, "scroll");
  } else {
    throw new Error(
      "candidate selected a Cua tool outside the closed workflow action set",
    );
  }
  const digest = sha256(canonicalJson({ tool: action.tool, arguments: args }));
  if (candidate.actionDigest !== digest)
    throw new Error(
      "candidate action digest does not match its immutable action",
    );
}

export function validateCandidateSet(
  input: Readonly<{
    candidates: readonly Candidate[];
    observation: BrowserObservation;
    values: readonly ValueSlot[];
    maximum: number;
    semanticPrefix?: string;
  }>,
): void {
  if (input.candidates.length < 3 || input.candidates.length > input.maximum) {
    throw new Error("candidate set is outside the configured bounds");
  }
  if (
    new Set(input.candidates.map((candidate) => candidate.id)).size !==
    input.candidates.length
  ) {
    throw new Error("candidate IDs are not unique");
  }
  if (
    new Set(input.candidates.map((candidate) => candidate.semanticKey)).size !==
    input.candidates.length
  ) {
    throw new Error("candidate semantic keys are not unique");
  }
  for (const reserved of ["reobserve", "abstain", "escalate"] as const) {
    const matches = input.candidates.filter(
      (candidate) =>
        candidate.semanticKey === reserved && candidate.action === null,
    );
    if (matches.length !== 1)
      throw new Error(
        `candidate set must contain exactly one ${reserved} route`,
      );
  }
  for (const candidate of input.candidates) {
    if (
      candidate.observationDigest !== input.observation.digest ||
      !Object.isFrozen(candidate) ||
      (candidate.action &&
        (!Object.isFrozen(candidate.action) ||
          !Object.isFrozen(candidate.action.arguments)))
    ) {
      throw new Error("candidate is stale or not recursively immutable");
    }
    if (
      input.semanticPrefix &&
      candidate.action &&
      !candidate.semanticKey.startsWith(input.semanticPrefix)
    ) {
      throw new Error(
        "candidate is outside the compiled workflow step namespace",
      );
    }
    validateAction(candidate, input.observation, input.values);
  }
}
