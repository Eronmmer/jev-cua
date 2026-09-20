import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { DriverToolDescriptor } from "../types.js";

const execFile = promisify(execFileCallback);

export const PINNED_CUA_DRIVER_VERSION = "cua-driver 0.28.2";
const CUA_APP = "/Applications/CuaDriver.app";
const CUA_EXECUTABLE = `${CUA_APP}/Contents/MacOS/cua-driver`;
const CUA_DESIGNATED_REQUIREMENT =
  '=anchor apple generic and certificate leaf[subject.OU] = "YCK386LBJ7" and identifier "com.trycua.driver"';

const REQUIRED_TOOLS = Object.freeze([
  "health_report",
  "check_permissions",
  "browser_prepare",
  "browser_navigate",
  "get_browser_state",
  "browser_click",
  "browser_type",
  "browser_pointer",
  "list_windows",
  "end_session",
]);

const ACTION_TOOLS = Object.freeze([
  "browser_click",
  "browser_type",
  "browser_pointer",
]);
const EXPECTED_EFFECTS = new Set([
  "confirmed",
  "partial",
  "unverifiable",
  "suspected_noop",
  "refused",
]);
const EXPECTED_ROUTES = new Set([
  "accessibility",
  "synthetic_events",
  "global_input",
  "system_api",
  "dom",
  "trusted_input",
]);

export type CuaCompatibility = Readonly<{
  compatible: boolean;
  versionMatches: boolean;
  requiredToolsPresent: boolean;
  receiptSchemasMatch: boolean;
  reasons: readonly string[];
}>;

export type CuaProvenance = Readonly<{
  trusted: boolean;
  reasons: readonly string[];
}>;

export async function verifyCuaDriverProvenance(
  binary: string,
): Promise<CuaProvenance> {
  const reasons: string[] = [];
  if (process.platform !== "darwin") {
    return Object.freeze({
      trusted: false,
      reasons: Object.freeze([
        "live Cua execution is currently trusted only on macOS",
      ]),
    });
  }
  try {
    if (
      (await realpath(binary)) !== CUA_EXECUTABLE ||
      binary !== CUA_EXECUTABLE
    ) {
      reasons.push(
        "driver is not the fixed non-symlink /Applications Cua executable",
      );
    }
    for (const path of [CUA_APP, CUA_EXECUTABLE]) {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) reasons.push(`${path} is a symbolic link`);
      if (path === CUA_EXECUTABLE && !metadata.isFile())
        reasons.push(`${path} is not a regular file`);
      if ((metadata.mode & 0o022) !== 0)
        reasons.push(`${path} is group- or world-writable`);
      const currentUid = process.getuid?.();
      if (
        currentUid !== undefined &&
        metadata.uid !== 0 &&
        metadata.uid !== currentUid
      ) {
        reasons.push(`${path} has an unexpected owner`);
      }
    }
    await execFile(
      "/usr/bin/codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "-R",
        CUA_DESIGNATED_REQUIREMENT,
        CUA_APP,
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    await access(CUA_EXECUTABLE, constants.X_OK);
  } catch (error: unknown) {
    reasons.push(
      `code identity or filesystem verification failed (${error instanceof Error ? error.name : "UnknownError"})`,
    );
  }
  return Object.freeze({
    trusted: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactStringEnum(
  value: unknown,
  expected: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    return false;
  const actual = new Set(value as string[]);
  return (
    actual.size === expected.size &&
    [...expected].every((entry) => actual.has(entry))
  );
}

function actionReceiptSchemaMatches(
  tool: DriverToolDescriptor | undefined,
): boolean {
  const alternatives = tool?.outputSchema?.anyOf;
  if (!Array.isArray(alternatives)) return false;
  return alternatives.some((alternative) => {
    const branch = record(alternative);
    const properties = record(branch?.properties);
    const effect = record(properties?.effect);
    const route = record(properties?.route);
    const required = branch?.required;
    return (
      Array.isArray(required) &&
      required.includes("effect") &&
      required.includes("route") &&
      exactStringEnum(effect?.enum, EXPECTED_EFFECTS) &&
      exactStringEnum(route?.enum, EXPECTED_ROUTES)
    );
  });
}

export function assessCuaCompatibility(
  version: string,
  tools: readonly DriverToolDescriptor[],
): CuaCompatibility {
  const reasons: string[] = [];
  const versionMatches = version === PINNED_CUA_DRIVER_VERSION;
  if (!versionMatches) {
    reasons.push(
      `expected ${PINNED_CUA_DRIVER_VERSION}, received ${version || "no version"}`,
    );
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const missingTools = REQUIRED_TOOLS.filter((name) => !byName.has(name));
  const requiredToolsPresent = missingTools.length === 0;
  if (!requiredToolsPresent)
    reasons.push(`missing required tools: ${missingTools.join(", ")}`);
  const incompatibleReceipts = ACTION_TOOLS.filter(
    (name) => !actionReceiptSchemaMatches(byName.get(name)),
  );
  const receiptSchemasMatch = incompatibleReceipts.length === 0;
  if (!receiptSchemasMatch) {
    reasons.push(
      `unsupported action receipt schema: ${incompatibleReceipts.join(", ")}`,
    );
  }
  return Object.freeze({
    compatible: versionMatches && requiredToolsPresent && receiptSchemasMatch,
    versionMatches,
    requiredToolsPresent,
    receiptSchemasMatch,
    reasons: Object.freeze(reasons),
  });
}
