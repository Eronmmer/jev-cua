import type { ValueSlot } from "../types.js";

export type WorkflowField = Readonly<{
  role: string;
  name: string;
}>;

export type WorkflowRequirement = Readonly<{
  kind: "field_equals";
  field: WorkflowField;
  inputId: string;
}>;

export type WorkflowAction =
  | Readonly<{
      kind: "type";
      field: WorkflowField;
      inputId: string;
      effect: "public_data_entry" | "private_data_entry";
    }>
  | Readonly<{
      kind: "click";
      control: WorkflowField;
      inputRoute: "dom_event" | "trusted";
      effect: "reversible_navigation" | "consequential_submit";
    }>
  | Readonly<{
      kind: "scroll";
      region: WorkflowField;
      direction: "up" | "down";
      pixels: number;
      effect: "reversible_view_change";
    }>;

export type WorkflowInput = Readonly<{
  id: string;
  description: string;
  targetHints: readonly string[];
  classification: "public" | "private";
  maxLength: number;
  pattern?: string;
  enum?: readonly string[];
  allowedDisclosureOrigins: readonly string[];
}>;

export type WorkflowStep = Readonly<{
  id: string;
  description: string;
  page: Readonly<{ origin: string; pathname: string }>;
  requires: readonly WorkflowRequirement[];
  action: WorkflowAction;
  ensures: WorkflowSuccess;
}>;

export type WorkflowSuccess =
  | Readonly<{
      kind: "exact_control_visible";
      page: Readonly<{ origin: string; pathname: string }>;
      control: WorkflowField;
      requiredAction: "click" | "type" | "scroll";
    }>
  | Readonly<{
      kind: "exact_field_equals";
      page: Readonly<{ origin: string; pathname: string }>;
      field: WorkflowField;
      inputId: string;
    }>
  | Readonly<{
      kind: "exact_url";
      origin: string;
      pathname: string;
    }>;

export type CompiledWorkflow = Readonly<{
  schema: "jev-cua.workflow.v1";
  id: string;
  version: number;
  /** SHA-256 of the exact manifest bytes for file-backed manifests. */
  digest: string;
  enabled: boolean;
  description: string;
  goal: string;
  target: Readonly<{
    kind: "isolated";
    startUrl: string;
    navigationEffect: "read_only_landing";
  }>;
  allowedOrigins: readonly string[];
  inputs: readonly WorkflowInput[];
  success: WorkflowSuccess;
  steps: readonly WorkflowStep[];
  source: string;
}>;

export type WorkflowInvocation = Readonly<{
  workflow: CompiledWorkflow;
  values: readonly ValueSlot[];
}>;
