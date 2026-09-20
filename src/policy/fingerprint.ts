import type { RuntimeConfig } from "../config.js";
import { PINNED_CUA_DRIVER_VERSION } from "../cua/compatibility.js";
import { canonicalJson, sha256 } from "../util.js";

export const POLICY_SEMANTICS_VERSION =
  "jev-cua-policy-v3-decision-identity-postcondition-fsm";

export function workflowPolicyFingerprint(
  manifestDigest: string,
  config: RuntimeConfig,
  decisionPolicyIdentity = config.model,
): string {
  return sha256(
    canonicalJson({
      policySemantics: POLICY_SEMANTICS_VERSION,
      manifestDigest,
      configuredJevModel: config.model,
      decisionPolicyIdentity,
      thresholds: config.thresholds,
      maxCandidates: config.maxCandidates,
      labelMaxLength: config.labelMaxLength,
      cuaContract: PINNED_CUA_DRIVER_VERSION,
    }),
  );
}
