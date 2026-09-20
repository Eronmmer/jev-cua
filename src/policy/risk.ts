import type { Candidate, RiskClass } from "../types.js";

const FORBIDDEN_PATTERNS = [
  /\b(delete|erase|destroy|remove account|close account)\b/iu,
  /\b(buy|purchase|pay|payment|checkout|transfer|withdraw|wire)\b/iu,
  /\b(password|passcode|one[- ]?time code|2fa|mfa|security key|seed phrase|private key)\b/iu,
  /\b(terms|legal agreement|sign contract|accept liability)\b/iu,
];

const CONSEQUENTIAL_PATTERNS = [
  /\b(send|submit|publish|post|upload|download|invite|approve|reject)\b/iu,
  /\b(confirm|save changes|create|deploy|merge|release|share)\b/iu,
  /\b(permission|allow access|authorize|install|subscribe|unsubscribe)\b/iu,
];

export function classifyLabelRisk(label: string): RiskClass {
  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(label)))
    return "r4_forbidden";
  if (CONSEQUENTIAL_PATTERNS.some((pattern) => pattern.test(label)))
    return "r3_consequential";
  return "r1_reversible";
}

export function classifyRisk(
  input: Readonly<{
    label: string;
    actionKind: "click" | "type" | "scroll";
    secretValue?: boolean;
    privateState?: boolean;
  }>,
): RiskClass {
  if (input.secretValue) return "r4_forbidden";
  const labelRisk = classifyLabelRisk(input.label);
  if (labelRisk !== "r1_reversible") return labelRisk;
  // Typing discloses a locally held value to the current site. Generic runs
  // cannot establish that authorization; compiled workflow policy must do so.
  if (input.actionKind === "type") return "r2_private";
  if (input.privateState) return "r2_private";
  return "r1_reversible";
}

export function riskMayExecuteAutomatically(risk: RiskClass): boolean {
  return risk === "r0_read_only" || risk === "r1_reversible";
}

export function candidateMayExecuteAutomatically(
  candidate: Candidate,
): boolean {
  return (
    riskMayExecuteAutomatically(candidate.risk) ||
    (candidate.risk === "r2_private" &&
      candidate.authorization === "approved_workflow")
  );
}
