import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { CompiledWorkflow, WorkflowInvocation } from "./types.js";
import {
  assertSafeManifestStrings,
  parseJsonWithoutDuplicateKeys,
} from "./strict-json.js";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const field = z
  .object({
    role: z.string().min(1).max(80),
    name: z.string().min(1).max(240),
  })
  .strict();
const requirement = z
  .object({
    kind: z.literal("field_equals"),
    field,
    input_id: identifier,
  })
  .strict();
const page = z
  .object({
    origin: z.url(),
    pathname: z.string().startsWith("/").max(2_048),
  })
  .strict();
const action = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("type"),
      field,
      input_id: identifier,
      effect: z.enum(["public_data_entry", "private_data_entry"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("click"),
      control: field,
      input_route: z.enum(["dom_event", "trusted"]),
      effect: z.enum(["reversible_navigation", "consequential_submit"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      region: field,
      direction: z.enum(["up", "down"]),
      pixels: z.number().int().min(80).max(1_000),
      effect: z.literal("reversible_view_change"),
    })
    .strict(),
]);
const success = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact_control_visible"),
      page,
      control: field,
      required_action: z.enum(["click", "type", "scroll"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("exact_field_equals"),
      page,
      field,
      input_id: identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal("exact_url"),
      origin: z.url(),
      pathname: z.string().startsWith("/").max(2_048),
    })
    .strict(),
]);
const input = z
  .object({
    id: identifier,
    description: z.string().min(1).max(240),
    target_hints: z.array(z.string().min(1).max(120)).max(12),
    classification: z.enum(["public", "private"]),
    max_length: z.number().int().positive().max(4096),
    pattern: z.string().min(3).max(256).optional(),
    enum: z.array(z.string().max(4096)).min(1).max(100).optional(),
    allowed_disclosure_origins: z.array(z.url()).min(1).max(12),
  })
  .strict();
const manifestSchema = z
  .object({
    schema: z.literal("jev-cua.workflow.v1"),
    id: identifier,
    version: z.number().int().positive(),
    enabled: z.boolean(),
    description: z.string().min(1).max(500),
    goal: z.string().min(1).max(1_000),
    target: z
      .object({
        kind: z.literal("isolated"),
        start_url: z.url().refine((value) => value.startsWith("https://")),
        navigation_effect: z.literal("read_only_landing"),
      })
      .strict(),
    allowed_origins: z.array(z.url()).min(1).max(12),
    inputs: z.array(input).max(12),
    success,
    steps: z
      .array(
        z
          .object({
            id: identifier,
            description: z.string().min(1).max(500),
            page,
            requires: z.array(requirement).max(12),
            action,
            ensures: success,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

function normalizedOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("workflow origins must use http or https");
  }
  return parsed.origin;
}

function declaredOrigin(value: string): string {
  const origin = normalizedOrigin(value);
  if (!origin.startsWith("https://")) {
    throw new Error(`workflow origin must use HTTPS: ${value}`);
  }
  if (value !== origin)
    throw new Error(`workflow origin must be an origin only: ${value}`);
  return origin;
}

function assertExactUrlCondition(
  workflowId: string,
  label: string,
  originValue: string,
  pathname: string,
  allowedOrigins: readonly string[],
): void {
  const origin = declaredOrigin(originValue);
  if (!allowedOrigins.includes(origin)) {
    throw new Error(
      `workflow ${workflowId} ${label} URL is outside its fixed origin allowlist`,
    );
  }
  const parsed = new URL(pathname, origin);
  if (
    parsed.origin !== origin ||
    parsed.pathname !== pathname ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `workflow ${workflowId} ${label} pathname must be canonical and query-free`,
    );
  }
}

function sameCondition(
  left: z.infer<typeof success>,
  right: z.infer<typeof success>,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "exact_url" && right.kind === "exact_url") {
    return left.origin === right.origin && left.pathname === right.pathname;
  }
  if (
    left.kind === "exact_control_visible" &&
    right.kind === "exact_control_visible"
  ) {
    return (
      left.page.origin === right.page.origin &&
      left.page.pathname === right.page.pathname &&
      left.control.role === right.control.role &&
      left.control.name === right.control.name &&
      left.required_action === right.required_action
    );
  }
  return (
    left.kind === "exact_field_equals" &&
    right.kind === "exact_field_equals" &&
    left.input_id === right.input_id &&
    left.page.origin === right.page.origin &&
    left.page.pathname === right.page.pathname &&
    left.field.role === right.field.role &&
    left.field.name === right.field.name
  );
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Patterns intentionally support a small, reviewable subset. Allowing arbitrary
 * JavaScript regular expressions here would let a manifest introduce ReDoS.
 */
function validatedPattern(value: string): string {
  // One repeated character class is deliberately less expressive than general
  // regular expressions, but it has predictable linear-time matching.
  if (
    !/^\^\[(?:\\.|[^\]\\\r\n])+\](?:[+*?]|\{\d{1,4}(?:,\d{0,4})?\})?\$$/u.test(
      value,
    )
  ) {
    throw new Error(
      "workflow input patterns must be one anchored character class with an optional simple quantifier",
    );
  }
  try {
    void new RegExp(value, "u");
  } catch {
    throw new Error(
      "workflow input pattern is not a valid Unicode regular expression",
    );
  }
  return value;
}

function expectedTypeEffect(classification: "public" | "private") {
  return classification === "private"
    ? "private_data_entry"
    : "public_data_entry";
}

export function parseWorkflowManifest(
  value: unknown,
  source = "<memory>",
  suppliedDigest?: string,
): CompiledWorkflow {
  assertSafeManifestStrings(value);
  const raw = manifestSchema.parse(value);
  const digest =
    suppliedDigest ?? sha256Bytes(Buffer.from(JSON.stringify(raw), "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("workflow digest must be a lowercase SHA-256 hex value");
  }
  const inputIds = new Set(raw.inputs.map((input) => input.id));
  if (inputIds.size !== raw.inputs.length)
    throw new Error(`workflow ${raw.id} has duplicate input IDs`);
  if (new Set(raw.steps.map((step) => step.id)).size !== raw.steps.length) {
    throw new Error(`workflow ${raw.id} has duplicate step IDs`);
  }
  const allowedOrigins = [...new Set(raw.allowed_origins.map(declaredOrigin))];
  for (const step of raw.steps) {
    const referenced = [
      ...step.requires.map((entry) => entry.input_id),
      ...(step.action.kind === "type" ? [step.action.input_id] : []),
      ...(step.ensures.kind === "exact_field_equals"
        ? [step.ensures.input_id]
        : []),
    ];
    for (const inputId of referenced) {
      if (!inputIds.has(inputId))
        throw new Error(
          `workflow ${raw.id} step ${step.id} references an unknown input`,
        );
    }
    if (step.ensures.kind === "exact_url") {
      assertExactUrlCondition(
        raw.id,
        `step ${step.id} postcondition`,
        step.ensures.origin,
        step.ensures.pathname,
        allowedOrigins,
      );
    } else {
      assertExactUrlCondition(
        raw.id,
        `step ${step.id} postcondition page`,
        step.ensures.page.origin,
        step.ensures.page.pathname,
        allowedOrigins,
      );
    }
    const stepOrigin = declaredOrigin(step.page.origin);
    if (!allowedOrigins.includes(stepOrigin)) {
      throw new Error(
        `workflow ${raw.id} step ${step.id} page is outside its fixed origin allowlist`,
      );
    }
    const stepUrl = new URL(step.page.pathname, stepOrigin);
    if (
      stepUrl.origin !== stepOrigin ||
      stepUrl.pathname !== step.page.pathname ||
      stepUrl.search !== "" ||
      stepUrl.hash !== ""
    ) {
      throw new Error(
        `workflow ${raw.id} step ${step.id} pathname must be canonical and query-free`,
      );
    }
  }
  if (!sameCondition(raw.steps.at(-1)!.ensures, raw.success)) {
    throw new Error(
      `workflow ${raw.id} final step postcondition must equal the workflow success condition`,
    );
  }
  if (
    raw.success.kind === "exact_field_equals" &&
    !inputIds.has(raw.success.input_id)
  ) {
    throw new Error(
      `workflow ${raw.id} success condition references an unknown input`,
    );
  }
  if (raw.success.kind !== "exact_url") {
    assertExactUrlCondition(
      raw.id,
      "success page",
      raw.success.page.origin,
      raw.success.page.pathname,
      allowedOrigins,
    );
  }
  const startUrl = new URL(raw.target.start_url);
  if (startUrl.username !== "" || startUrl.password !== "") {
    throw new Error(`workflow ${raw.id} start URL cannot contain credentials`);
  }
  if (startUrl.search !== "" || startUrl.hash !== "") {
    throw new Error(
      `workflow ${raw.id} start URL must be query- and fragment-free`,
    );
  }
  if (!allowedOrigins.includes(normalizedOrigin(raw.target.start_url))) {
    throw new Error(
      `workflow ${raw.id} start URL is outside its fixed origin allowlist`,
    );
  }
  if (
    raw.success.kind === "exact_url" &&
    !allowedOrigins.includes(declaredOrigin(raw.success.origin))
  ) {
    throw new Error(
      `workflow ${raw.id} exact success URL is outside its fixed origin allowlist`,
    );
  }
  if (raw.success.kind === "exact_url") {
    assertExactUrlCondition(
      raw.id,
      "success",
      raw.success.origin,
      raw.success.pathname,
      allowedOrigins,
    );
  }
  const parsedInputs = raw.inputs.map((entry) => {
    const allowedDisclosureOrigins = [
      ...new Set(entry.allowed_disclosure_origins.map(declaredOrigin)),
    ];
    if (
      allowedDisclosureOrigins.some(
        (origin) => !allowedOrigins.includes(origin),
      )
    ) {
      throw new Error(
        `workflow ${raw.id} input ${entry.id} discloses to an origin outside the workflow allowlist`,
      );
    }
    const pattern =
      entry.pattern === undefined ? undefined : validatedPattern(entry.pattern);
    const enumValues =
      entry.enum === undefined ? undefined : [...new Set(entry.enum)];
    if (enumValues !== undefined && enumValues.length !== entry.enum!.length) {
      throw new Error(
        `workflow ${raw.id} input ${entry.id} contains duplicate enum values`,
      );
    }
    for (const enumValue of enumValues ?? []) {
      if ([...enumValue].length > entry.max_length) {
        throw new Error(
          `workflow ${raw.id} input ${entry.id} has an enum value above max_length`,
        );
      }
      if (pattern !== undefined && !new RegExp(pattern, "u").test(enumValue)) {
        throw new Error(
          `workflow ${raw.id} input ${entry.id} has an enum value outside its pattern`,
        );
      }
    }
    return Object.freeze({
      id: entry.id,
      description: entry.description,
      targetHints: Object.freeze([...entry.target_hints]),
      classification: entry.classification,
      maxLength: entry.max_length,
      ...(pattern === undefined ? {} : { pattern }),
      ...(enumValues === undefined ? {} : { enum: Object.freeze(enumValues) }),
      allowedDisclosureOrigins: Object.freeze(allowedDisclosureOrigins),
    });
  });
  const inputById = new Map(
    parsedInputs.map((entry) => [entry.id, entry] as const),
  );
  for (const step of raw.steps) {
    if (step.action.kind === "type") {
      const referencedInput = inputById.get(step.action.input_id)!;
      const expected = expectedTypeEffect(referencedInput.classification);
      if (step.action.effect !== expected) {
        throw new Error(
          `workflow ${raw.id} step ${step.id} declares ${step.action.effect} for a ${referencedInput.classification} input`,
        );
      }
      if (
        step.ensures.kind !== "exact_field_equals" ||
        step.ensures.input_id !== step.action.input_id ||
        step.ensures.field.role !== step.action.field.role ||
        step.ensures.field.name !== step.action.field.name ||
        step.ensures.page.origin !== step.page.origin ||
        step.ensures.page.pathname !== step.page.pathname
      ) {
        throw new Error(
          `workflow ${raw.id} step ${step.id} must prove the exact field value written by its type action on the same page`,
        );
      }
    }
    if (
      step.action.kind === "scroll" &&
      (step.ensures.kind !== "exact_control_visible" ||
        step.ensures.page.origin !== step.page.origin ||
        step.ensures.page.pathname !== step.page.pathname)
    ) {
      throw new Error(
        `workflow ${raw.id} step ${step.id} scroll must reveal an exact reviewed control on the same page`,
      );
    }
  }
  const successCondition =
    raw.success.kind === "exact_field_equals"
      ? Object.freeze({
          kind: "exact_field_equals" as const,
          page: Object.freeze({
            origin: declaredOrigin(raw.success.page.origin),
            pathname: raw.success.page.pathname,
          }),
          field: Object.freeze({ ...raw.success.field }),
          inputId: raw.success.input_id,
        })
      : raw.success.kind === "exact_control_visible"
        ? Object.freeze({
            kind: "exact_control_visible" as const,
            page: Object.freeze({
              origin: declaredOrigin(raw.success.page.origin),
              pathname: raw.success.page.pathname,
            }),
            control: Object.freeze({ ...raw.success.control }),
            requiredAction: raw.success.required_action,
          })
        : Object.freeze({
            kind: "exact_url" as const,
            origin: declaredOrigin(raw.success.origin),
            pathname: raw.success.pathname,
          });
  return Object.freeze({
    schema: raw.schema,
    id: raw.id,
    version: raw.version,
    digest,
    enabled: raw.enabled,
    description: raw.description,
    goal: raw.goal,
    target: Object.freeze({
      kind: "isolated" as const,
      startUrl: raw.target.start_url,
      navigationEffect: raw.target.navigation_effect,
    }),
    allowedOrigins: Object.freeze(allowedOrigins),
    inputs: Object.freeze(parsedInputs),
    success: Object.freeze(successCondition),
    steps: Object.freeze(
      raw.steps.map((step) =>
        Object.freeze({
          id: step.id,
          description: step.description,
          page: Object.freeze({
            origin: declaredOrigin(step.page.origin),
            pathname: step.page.pathname,
          }),
          requires: Object.freeze(
            step.requires.map((entry) =>
              Object.freeze({
                kind: entry.kind,
                field: Object.freeze({ ...entry.field }),
                inputId: entry.input_id,
              }),
            ),
          ),
          action:
            step.action.kind === "type"
              ? Object.freeze({
                  kind: "type" as const,
                  field: Object.freeze({ ...step.action.field }),
                  inputId: step.action.input_id,
                  effect: step.action.effect,
                })
              : step.action.kind === "click"
                ? Object.freeze({
                    kind: "click" as const,
                    control: Object.freeze({ ...step.action.control }),
                    inputRoute: step.action.input_route,
                    effect: step.action.effect,
                  })
                : Object.freeze({
                    kind: "scroll" as const,
                    region: Object.freeze({ ...step.action.region }),
                    direction: step.action.direction,
                    pixels: step.action.pixels,
                    effect: step.action.effect,
                  }),
          ensures:
            step.ensures.kind === "exact_field_equals"
              ? Object.freeze({
                  kind: "exact_field_equals" as const,
                  page: Object.freeze({
                    origin: declaredOrigin(step.ensures.page.origin),
                    pathname: step.ensures.page.pathname,
                  }),
                  field: Object.freeze({ ...step.ensures.field }),
                  inputId: step.ensures.input_id,
                })
              : step.ensures.kind === "exact_control_visible"
                ? Object.freeze({
                    kind: "exact_control_visible" as const,
                    page: Object.freeze({
                      origin: declaredOrigin(step.ensures.page.origin),
                      pathname: step.ensures.page.pathname,
                    }),
                    control: Object.freeze({ ...step.ensures.control }),
                    requiredAction: step.ensures.required_action,
                  })
                : Object.freeze({
                    kind: "exact_url" as const,
                    origin: declaredOrigin(step.ensures.origin),
                    pathname: step.ensures.pathname,
                  }),
        }),
      ),
    ),
    source,
  });
}

function assertTrustedMetadata(
  metadata: Stats,
  kind: "directory" | "file",
  displayName: string,
): void {
  const isExpectedKind =
    kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!isExpectedKind)
    throw new Error(`workflow ${kind} ${displayName} is not a regular ${kind}`);
  if (process.platform === "win32") return;
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error(
      `workflow ${kind} ${displayName} is not owned by the current user`,
    );
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(
      `workflow ${kind} ${displayName} is group- or world-writable`,
    );
  }
}

async function readTrustedManifest(
  path: string,
  displayName: string,
): Promise<CompiledWorkflow> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    assertTrustedMetadata(before, "file", displayName);
    if (before.size > 256 * 1024)
      throw new Error(
        `workflow manifest ${displayName} exceeds the size limit`,
      );
    const maximumBytes = 256 * 1024;
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const bytes = buffer.subarray(0, total);
    if (bytes.byteLength > 256 * 1024) {
      throw new Error(
        `workflow manifest ${displayName} exceeds the size limit`,
      );
    }
    const after = await handle.stat();
    assertTrustedMetadata(after, "file", displayName);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      after.size !== bytes.byteLength
    ) {
      throw new Error(
        `workflow manifest ${displayName} changed while it was being read`,
      );
    }
    const digest = sha256Bytes(bytes);
    let decoded: unknown;
    try {
      decoded = parseJsonWithoutDuplicateKeys(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        `workflow manifest ${displayName}`,
      );
    } catch {
      throw new Error(`workflow manifest ${displayName} is not valid JSON`);
    }
    return parseWorkflowManifest(decoded, path, digest);
  } finally {
    await handle.close();
  }
}

export async function loadWorkflowManifests(
  directory: string,
): Promise<readonly CompiledWorkflow[]> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const directoryOnly =
    process.platform === "win32" ? 0 : constants.O_DIRECTORY;
  let directoryHandle: Awaited<ReturnType<typeof open>>;
  try {
    directoryHandle = await open(
      directory,
      constants.O_RDONLY | noFollow | directoryOnly,
    );
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return Object.freeze([]);
    throw error;
  }
  let directoryMetadata: Stats;
  try {
    directoryMetadata = await directoryHandle.stat();
    assertTrustedMetadata(directoryMetadata, "directory", directory);
  } catch (error) {
    await directoryHandle.close();
    throw error;
  }
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith(".workflow.json"))
      .sort();
  } catch (error: unknown) {
    await directoryHandle.close();
    throw error;
  }
  try {
    const workflows: CompiledWorkflow[] = [];
    for (const name of names) {
      workflows.push(await readTrustedManifest(join(directory, name), name));
    }
    const pathMetadata = await lstat(directory);
    assertTrustedMetadata(pathMetadata, "directory", directory);
    if (
      pathMetadata.isSymbolicLink() ||
      pathMetadata.dev !== directoryMetadata.dev ||
      pathMetadata.ino !== directoryMetadata.ino
    ) {
      throw new Error(
        "workflow directory changed while manifests were being loaded",
      );
    }
    if (
      new Set(workflows.map((workflow) => workflow.id)).size !==
      workflows.length
    ) {
      throw new Error("workflow directory contains duplicate workflow IDs");
    }
    return Object.freeze(workflows);
  } finally {
    await directoryHandle.close();
  }
}

export function bindWorkflowInputs(
  workflow: CompiledWorkflow,
  supplied: Readonly<Record<string, string>>,
): WorkflowInvocation {
  const expected = new Set(workflow.inputs.map((input) => input.id));
  const actual = Object.keys(supplied);
  if (
    actual.length !== expected.size ||
    actual.some((id) => !expected.has(id))
  ) {
    throw new Error(
      `workflow ${workflow.id} requires exactly these inputs: ${[...expected].join(", ") || "(none)"}`,
    );
  }
  return Object.freeze({
    workflow,
    values: Object.freeze(
      workflow.inputs.map((input) => {
        const value = supplied[input.id]!;
        if (/[\p{Cc}\p{Cf}]/u.test(value)) {
          throw new Error(
            `workflow ${workflow.id} input ${input.id} contains control or format characters`,
          );
        }
        if ([...value].length > input.maxLength) {
          throw new Error(
            `workflow ${workflow.id} input ${input.id} exceeds max_length`,
          );
        }
        if (input.enum !== undefined && !input.enum.includes(value)) {
          throw new Error(
            `workflow ${workflow.id} input ${input.id} is outside its enum`,
          );
        }
        if (
          input.pattern !== undefined &&
          !new RegExp(input.pattern, "u").test(value)
        ) {
          throw new Error(
            `workflow ${workflow.id} input ${input.id} does not match its pattern`,
          );
        }
        return Object.freeze({
          id: input.id,
          description: input.description,
          value,
          targetHints: input.targetHints,
          // Secret-bearing inputs are unsupported entirely. "private" here
          // means an approved disclosure to a reviewed origin, not a credential.
          secret: false,
          classification: input.classification,
        });
      }),
    ),
  });
}
