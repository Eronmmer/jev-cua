import type { RiskClass } from "../types.js";

export type NativeWindowTarget = Readonly<{ windowRef: string }>;

export type NativeAppSummary = Readonly<{
  appRef: string;
  bundleId: string;
  name: string;
  running: boolean;
  active: boolean;
  untrustedText: true;
}>;

export type NativeWindowSummary = Readonly<{
  appRef: string;
  windowRef: string;
  title: string;
  onScreen: boolean;
  onCurrentSpace: boolean | null;
  minimized: boolean | null;
  untrustedText: true;
}>;

export type NativeActionKind =
  | "click"
  | "type_text"
  | "set_value"
  | "press_key"
  | "scroll"
  | "invoke_menu";

export type NativeCandidate = Readonly<{
  id: string;
  targetKind: "window" | "element";
  role: string;
  label?: string;
  valuePresent: boolean;
  enabled?: boolean | null;
  selected?: boolean | null;
  actionKinds: readonly NativeActionKind[];
  riskByAction: Readonly<Partial<Record<NativeActionKind, RiskClass>>>;
  untrustedText: true;
}>;

export type NativeObservation = Readonly<{
  id: string;
  target: NativeWindowTarget;
  complete: boolean;
  actionable: boolean;
  candidateCount: number;
  candidates: readonly NativeCandidate[];
  untrustedUiData: true;
}>;

export type NativeAction =
  | Readonly<{
      kind: "click";
      activation?:
        | "press"
        | "show_menu"
        | "pick"
        | "confirm"
        | "cancel"
        | "open";
    }>
  | Readonly<{ kind: "type_text"; text: string }>
  | Readonly<{ kind: "set_value"; value: string }>
  | Readonly<{
      kind: "press_key";
      key: string;
      modifiers?: readonly (
        | "cmd"
        | "shift"
        | "option"
        | "alt"
        | "ctrl"
        | "fn"
      )[];
    }>
  | Readonly<{
      kind: "scroll";
      direction: "up" | "down" | "left" | "right";
      by?: "line" | "page";
      amount?: number;
    }>
  | Readonly<{ kind: "invoke_menu"; path: readonly string[] }>;

export type NativeElementVerification = Readonly<{
  selector: Readonly<{
    role?: string;
    labelContains?: string;
  }>;
  exists?: true;
  enabled?: boolean | null;
  selected?: boolean | null;
  valueEquals?: string | null;
}>;

export type NativeVerificationPredicate =
  | Readonly<{ element: NativeElementVerification }>
  | Readonly<{ window: Readonly<{ exists: boolean }> }>;

export type NativeVerification = Readonly<{
  expect: readonly NativeVerificationPredicate[];
  timeoutMs?: number;
  stableSamples?: number;
}>;

export type NativeApprovalRequest = Readonly<{
  runId: string;
  operationKey: string;
  target: NativeWindowTarget;
  actionKind: NativeActionKind;
  risk: RiskClass;
}>;

export type NativeApprovalDecision =
  | Readonly<{ status: "approved" }>
  | Readonly<{ status: "declined" }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "unsupported" }>
  | Readonly<{ status: "failed" }>;

export type NativeApprovalGate = (
  request: NativeApprovalRequest,
) => Promise<NativeApprovalDecision> | NativeApprovalDecision;

export type NativeExecutionOutcome =
  | "verified"
  | "refuted"
  | "unknown"
  | "approval_required"
  | "denied";

export type NativeExecutionResult = Readonly<{
  outcome: NativeExecutionOutcome;
  reasonCode:
    | "verified"
    | "verification_unsatisfied"
    | "verification_unknown"
    | "precondition_already_satisfied"
    | "precondition_unknown"
    | "approval_required"
    | "approval_declined"
    | "approval_cancelled"
    | "approval_channel_unavailable"
    | "approval_failed"
    | "forbidden_action"
    | "stale_observation"
    | "ambiguous_dispatch"
    | "post_action_observation_failed"
    | "reconciliation_required"
    | "idempotent_replay";
  mutationAttempted: boolean;
  reconciliationRequired: boolean;
  safeToRetry: boolean;
  replayed: boolean;
  effect?: "confirmed" | "unverifiable";
  route?:
    | "accessibility"
    | "synthetic_events"
    | "global_input"
    | "system_api"
    | "dom"
    | "trusted_input";
}>;

export type NativeEndResult = Readonly<{
  cleanupSucceeded: boolean;
  reconciliationRequired: boolean;
}>;
