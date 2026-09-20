import type {
  BrowserObservation,
  BrowserRef,
  Candidate,
  JsonValue,
  ValueSlot,
} from "../types.js";
import {
  canonicalJson,
  deepFreeze,
  randomOpaqueId,
  redactProviderText,
  sha256,
  truncateUntrusted,
} from "../util.js";
import { classifyRisk } from "./risk.js";

const CLICK_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "switch",
  "tab",
]);
const EDIT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

function actionDigest(
  tool: string,
  arguments_: Readonly<Record<string, JsonValue>>,
): string {
  return sha256(canonicalJson({ tool, arguments: arguments_ }));
}

function semanticKey(kind: string, ...parts: string[]): string {
  return `${kind}:${sha256(parts.join("\u0000")).slice(0, 16)}`;
}

function normalizedTokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("en-US")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1),
  );
}

function relevance(ref: BrowserRef, slot: ValueSlot): number {
  const target = normalizedTokens(`${ref.name} ${ref.role}`);
  const hints = normalizedTokens(
    `${slot.description} ${slot.targetHints.join(" ")}`,
  );
  let score = 0;
  for (const token of hints) if (target.has(token)) score += token.length;
  if (
    slot.targetHints.some((hint) =>
      ref.name
        .toLocaleLowerCase("en-US")
        .includes(hint.toLocaleLowerCase("en-US")),
    )
  ) {
    score += 20;
  }
  return score;
}

function hasAction(ref: BrowserRef, expected: string): boolean {
  const actions = ref.actions.map((action) =>
    action.toLocaleLowerCase("en-US"),
  );
  if (actions.includes(expected)) return true;
  if (expected === "click")
    return (
      CLICK_ROLES.has(ref.role.toLocaleLowerCase("en-US")) &&
      actions.length === 0
    );
  if (expected === "type")
    return (
      EDIT_ROLES.has(ref.role.toLocaleLowerCase("en-US")) &&
      actions.length === 0
    );
  return false;
}

function executableCandidate(
  input: Readonly<{
    semanticKey: string;
    description: string;
    tool: string;
    arguments: Record<string, JsonValue>;
    expectedEffect: string;
    observationDigest: string;
    risk: Candidate["risk"];
  }>,
): Candidate {
  const arguments_ = deepFreeze(structuredClone(input.arguments));
  const digest = actionDigest(input.tool, arguments_);
  return deepFreeze({
    id: randomOpaqueId(),
    semanticKey: input.semanticKey,
    description: input.description,
    risk: input.risk,
    action: {
      tool: input.tool,
      arguments: arguments_,
    },
    actionDigest: digest,
    expectedEffect: input.expectedEffect,
    observationDigest: input.observationDigest,
  });
}

function reservedCandidate(
  semanticKey: "reobserve" | "abstain" | "escalate",
  observationDigest: string,
): Candidate {
  const descriptions = {
    reobserve:
      "Discard this decision set and obtain a fresh observation without acting.",
    abstain:
      "Stop without acting because no supplied action safely advances the goal.",
    escalate:
      "Return control to the frontier planner because the state is unfamiliar or ambiguous.",
  } as const;
  return deepFreeze({
    id: randomOpaqueId(),
    semanticKey,
    description: descriptions[semanticKey],
    risk: "r0_read_only",
    action: null,
    actionDigest: null,
    expectedEffect: "No computer input is dispatched.",
    observationDigest,
  });
}

export function buildBrowserCandidates(
  input: Readonly<{
    observation: BrowserObservation;
    values: readonly ValueSlot[];
    maximum: number;
    labelMaxLength: number;
    privateState: boolean;
  }>,
): readonly Candidate[] {
  const { observation } = input;
  if (
    new Set(input.values.map((value) => value.id)).size !== input.values.length
  ) {
    throw new Error("value slot IDs must be unique");
  }
  const common: Record<string, JsonValue> = {
    target_id: observation.targetId,
    tab_id: observation.tabId,
  };
  const candidates: Candidate[] = [];

  for (const ref of observation.refs) {
    if (ref.disabled || !ref.ref || !hasAction(ref, "click")) continue;
    const label = redactProviderText(
      truncateUntrusted(ref.name || ref.role, input.labelMaxLength),
    );
    const risk = classifyRisk({
      label,
      actionKind: "click",
      privateState: input.privateState,
    });
    candidates.push(
      executableCandidate({
        semanticKey: semanticKey("click", ref.role, label),
        description: `Click the enabled ${ref.role} labelled ${JSON.stringify(label)}.`,
        tool: "browser_click",
        arguments: { ...common, ref: ref.ref, input_route: "dom_event" },
        expectedEffect: `The ${ref.role} labelled ${JSON.stringify(label)} responds to a click.`,
        observationDigest: observation.digest,
        risk,
      }),
    );
  }

  const editable = observation.refs.filter(
    (ref) => !ref.disabled && ref.ref && hasAction(ref, "type"),
  );
  for (const slot of input.values) {
    const ranked = editable
      .map((ref) => ({ ref, score: relevance(ref, slot) }))
      .filter(({ score }) => score > 0 || editable.length === 1)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2);
    for (const { ref } of ranked) {
      const label = redactProviderText(
        truncateUntrusted(ref.name || ref.role, input.labelMaxLength),
      );
      const risk = classifyRisk({
        label: `${label} ${slot.description}`,
        actionKind: "type",
        secretValue: slot.secret,
        privateState: input.privateState,
      });
      candidates.push(
        executableCandidate({
          semanticKey: semanticKey("type", slot.id, ref.role, label),
          description: `Enter the approved local value slot ${JSON.stringify(slot.id)} into the ${ref.role} labelled ${JSON.stringify(label)}.`,
          tool: "browser_type",
          arguments: {
            ...common,
            ref: ref.ref,
            text: slot.value,
            replace: true,
            mode: "insert_text",
          },
          expectedEffect: `The field labelled ${JSON.stringify(label)} contains the approved value slot ${JSON.stringify(slot.id)}.`,
          observationDigest: observation.digest,
          risk,
        }),
      );
    }
  }

  for (const ref of observation.refs) {
    if (ref.disabled || !ref.ref || !hasAction(ref, "scroll")) continue;
    const label = redactProviderText(
      truncateUntrusted(ref.name || "scroll area", input.labelMaxLength),
    );
    candidates.push(
      executableCandidate({
        semanticKey: semanticKey("scroll", ref.role, label),
        description: `Scroll the ${ref.role} labelled ${JSON.stringify(label)} down by one viewport segment.`,
        tool: "browser_pointer",
        arguments: {
          ...common,
          ref: ref.ref,
          action: "scroll",
          input_route: "dom_event",
          delta_y: 480,
        },
        expectedEffect:
          "Additional controls lower in the same page region become observable.",
        observationDigest: observation.digest,
        risk: classifyRisk({
          label,
          actionKind: "scroll",
          privateState: input.privateState,
        }),
      }),
    );
  }

  const unambiguous = candidates.filter((candidate, _index, all) => {
    if (!candidate.action) return true;
    return (
      all.filter(
        (other) =>
          other.action?.tool === candidate.action?.tool &&
          other.description === candidate.description,
      ).length === 1
    );
  });
  const reserved = [
    reservedCandidate("reobserve", observation.digest),
    reservedCandidate("abstain", observation.digest),
    reservedCandidate("escalate", observation.digest),
  ];
  const executableLimit = Math.max(1, input.maximum - reserved.length);
  return deepFreeze([...unambiguous.slice(0, executableLimit), ...reserved]);
}

export function candidateById(
  candidates: readonly Candidate[],
  id: string,
): Candidate {
  const matches = candidates.filter((candidate) => candidate.id === id);
  if (matches.length !== 1)
    throw new Error("decision selected an unknown or duplicate candidate ID");
  return matches[0]!;
}
