import type { RuntimeConfig } from "../config.js";
import { PINNED_CUA_DRIVER_VERSION } from "../cua/compatibility.js";
import { canonicalJson, sha256 } from "../util.js";

export const POLICY_SEMANTICS_VERSION =
  "jev-cua-policy-v4-policy-specific-configuration";

export function workflowPolicyFingerprint(
  manifestDigest: string,
  config: RuntimeConfig,
  decisionPolicyIdentity = config.model,
): string {
  const policyConfiguration = {
    model: decisionPolicyIdentity,
    thresholds: config.thresholds,
    maxCandidates: config.maxCandidates,
    labelMaxLength: config.labelMaxLength,
  };

  return sha256(
    canonicalJson({
      policySemantics: POLICY_SEMANTICS_VERSION,
      manifestDigest,
      decisionPolicyIdentity,
      policyConfiguration,
      cuaContract: PINNED_CUA_DRIVER_VERSION,
    }),
  );
}
