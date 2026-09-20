import type { RuntimeConfig } from "../config.js";
import { PINNED_CUA_DRIVER_VERSION } from "../cua/compatibility.js";
import { canonicalJson, sha256 } from "../util.js";

export const POLICY_SEMANTICS_VERSION = "jev-cua-policy-v2-postcondition-fsm";

export function workflowPolicyFingerprint(
  manifestDigest: string,
  config: RuntimeConfig,
): string {
  return sha256(
    canonicalJson({
      policySemantics: POLICY_SEMANTICS_VERSION,
      manifestDigest,
      jevModel: config.model,
      thresholds: config.thresholds,
      maxCandidates: config.maxCandidates,
      labelMaxLength: config.labelMaxLength,
      cuaContract: PINNED_CUA_DRIVER_VERSION,
    }),
  );
}
