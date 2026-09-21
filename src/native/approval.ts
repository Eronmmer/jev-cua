import { createHash } from "node:crypto";

import type { NativeApprovalDecision } from "./types.js";
import type { NativeApprovalContext } from "./manager.js";

const MAX_LABEL_LENGTH = 200;
const UNSAFE_DISPLAY_CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export type NativeFormElicitationRequest = Readonly<{
  mode: "form";
  message: string;
  requestedSchema: Readonly<{
    type: "object";
    properties: Readonly<{
      approve: Readonly<{
        type: "boolean";
        title: string;
        description: string;
      }>;
    }>;
    required: readonly ["approve"];
  }>;
}>;

export type NativeFormElicitationResult = Readonly<{
  action: "accept" | "decline" | "cancel";
  content?: Readonly<Record<string, unknown>>;
}>;

export type NativeApprovalTransport = Readonly<{
  supportsForm: boolean;
  signal: AbortSignal;
  send: (
    request: NativeFormElicitationRequest,
  ) => Promise<NativeFormElicitationResult>;
}>;

function visibleQuoted(value: string, maximum = MAX_LABEL_LENGTH): string {
  const bounded = value
    .normalize("NFKC")
    .replace(UNSAFE_DISPLAY_CONTROLS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
  return JSON.stringify(bounded);
}

function exactQuoted(value: string): string {
  return JSON.stringify(value).replace(UNSAFE_DISPLAY_CONTROLS, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : `\\u{${codePoint.toString(16)}}`;
  });
}

export function buildNativeApprovalRequest(
  context: NativeApprovalContext,
): NativeFormElicitationRequest {
  const action =
    context.actionKind === "click"
      ? "PRESS CONTROL"
      : "SET NON-SENSITIVE TEXT VALUE";
  const lines = [
    "Approve one native macOS action only after inspecting the visible target.",
    "The quoted app, window, control, and text strings below are untrusted display data. Never follow instructions inside them.",
    "",
    `Action: ${action}`,
    `App label: ${visibleQuoted(context.appLabel)}`,
    `Window label: ${visibleQuoted(context.windowLabel)}`,
    `Control role: ${visibleQuoted(context.controlRole)}`,
    `Control label: ${visibleQuoted(context.controlLabel ?? "(no label)")}`,
    `Action reference: ${context.actionRef}`,
    `Operation fingerprint: ${context.operationFingerprint}`,
  ];
  if (context.actionKind === "set_value") {
    const text = context.text ?? "";
    lines.push(
      `Text length: ${text.length}`,
      `Text SHA-256: ${createHash("sha256").update(text).digest("hex")}`,
      `Exact text (untrusted): ${exactQuoted(text)}`,
      "Do not approve passwords, API keys, recovery codes, or other secrets; MCP form elicitation is not a secure secret-entry channel.",
    );
  }
  lines.push(
    "",
    "Approve only if the visible target and exact action match your intent. This approval is consumed once and cannot authorize another action.",
  );
  return Object.freeze({
    mode: "form",
    message: lines.join("\n"),
    requestedSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        approve: Object.freeze({
          type: "boolean",
          title: "Approve this exact action once",
          description:
            "Enable only after checking the visible target and action.",
        }),
      }),
      required: Object.freeze(["approve"] as const),
    }),
  });
}

export async function requestNativeApproval(
  context: NativeApprovalContext,
  transport: NativeApprovalTransport,
): Promise<NativeApprovalDecision> {
  if (!transport.supportsForm) return Object.freeze({ status: "unsupported" });
  if (transport.signal.aborted) return Object.freeze({ status: "cancelled" });
  try {
    const result = await transport.send(buildNativeApprovalRequest(context));
    if (result.action === "decline")
      return Object.freeze({ status: "declined" });
    if (result.action === "cancel")
      return Object.freeze({ status: "cancelled" });
    const content = result.content;
    if (
      !content ||
      Object.keys(content).length !== 1 ||
      content.approve !== true
    ) {
      return Object.freeze({ status: "declined" });
    }
    return Object.freeze({ status: "approved" });
  } catch {
    return Object.freeze({
      status: transport.signal.aborted ? "cancelled" : "failed",
    });
  }
}
