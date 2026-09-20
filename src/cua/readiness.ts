import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { DriverToolError } from "./client.js";
import {
  assessCuaCompatibility,
  verifyCuaDriverProvenance,
} from "./compatibility.js";
import type { DriverClient } from "../types.js";
import { trustedHelperEnvironment } from "../runtime/child-environment.js";

const execFile = promisify(execFileCallback);

export type CuaTelemetryStatus = Readonly<{
  enabled: boolean;
  source: string | null;
}>;

export type CuaReadiness = Readonly<{
  ready: boolean;
  driverVersion: string | null;
  driverTools: number | null;
  driverError: string | null;
  driverRefusalCode: string | null;
  health: Readonly<Record<string, unknown>> | null;
  permissions: Readonly<Record<string, unknown>> | null;
  permissionsReady: boolean;
  requiredToolsPresent: boolean;
  receiptSchemasMatch: boolean;
  cleanupReceiptSchemaMatches: boolean;
  driverContractCompatible: boolean;
  compatibilityReasons: readonly string[];
  provenanceTrusted: boolean;
  provenanceReasons: readonly string[];
  telemetry: CuaTelemetryStatus | null;
}>;

export type CuaReadinessProbeDependencies = Readonly<{
  verifyProvenance: typeof verifyCuaDriverProvenance;
  readDriverVersion: (binary: string) => Promise<string>;
  readTelemetryStatus: typeof readCuaTelemetryStatus;
}>;

export async function readCuaTelemetryStatus(
  binary: string,
): Promise<CuaTelemetryStatus> {
  const { stdout } = await execFile(binary, ["telemetry", "status", "--json"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: trustedHelperEnvironment(process.env, { userDirectories: true }),
  });
  const value = JSON.parse(stdout) as Record<string, unknown>;
  if (typeof value.enabled !== "boolean") {
    throw new Error("Cua telemetry status is malformed");
  }
  return Object.freeze({
    enabled: value.enabled,
    source: typeof value.source === "string" ? value.source : null,
  });
}

async function readCuaDriverVersion(binary: string): Promise<string> {
  const { stdout } = await execFile(binary, ["--version"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: trustedHelperEnvironment(process.env, { userDirectories: true }),
  });
  return stdout.trim().slice(0, 160);
}

export async function probeCuaReadiness(
  binary: string,
  driver: Pick<DriverClient, "listTools" | "call">,
  dependencyOverrides: Partial<CuaReadinessProbeDependencies> = {},
): Promise<CuaReadiness> {
  const verifyProvenance =
    dependencyOverrides.verifyProvenance ?? verifyCuaDriverProvenance;
  const readDriverVersion =
    dependencyOverrides.readDriverVersion ?? readCuaDriverVersion;
  const readTelemetryStatus =
    dependencyOverrides.readTelemetryStatus ?? readCuaTelemetryStatus;
  let driverVersion: string | null = null;
  let driverTools: number | null = null;
  let driverError: string | null = null;
  let driverRefusalCode: string | null = null;
  let health: Record<string, unknown> | null = null;
  let permissions: Record<string, unknown> | null = null;
  let requiredToolsPresent = false;
  let receiptSchemasMatch = false;
  let cleanupReceiptSchemaMatches = false;
  let driverContractCompatible = false;
  let compatibilityReasons: readonly string[] = [];
  let provenanceTrusted = false;
  let provenanceReasons: readonly string[] = [];
  let telemetry: CuaTelemetryStatus | null = null;

  try {
    const provenance = await verifyProvenance(binary);
    provenanceTrusted = provenance.trusted;
    provenanceReasons = provenance.reasons;
    if (!provenance.trusted) {
      driverError = "UntrustedDriver";
    } else {
      driverVersion = await readDriverVersion(binary);
      const telemetryStatus = await readTelemetryStatus(binary);
      telemetry = Object.freeze({
        enabled: telemetryStatus.enabled,
        source: telemetryStatus.source,
      });
      if (!telemetry.enabled) {
        const tools = await driver.listTools();
        driverTools = tools.length;
        const compatibility = assessCuaCompatibility(driverVersion, tools);
        requiredToolsPresent = compatibility.requiredToolsPresent;
        receiptSchemasMatch = compatibility.receiptSchemasMatch;
        cleanupReceiptSchemaMatches = compatibility.cleanupReceiptSchemaMatches;
        driverContractCompatible = compatibility.compatible;
        compatibilityReasons = compatibility.reasons;
        if (compatibility.compatible) {
          health = await driver.call("health_report", {});
          permissions = await driver.call("check_permissions", {
            prompt: false,
          });
        }
      }
    }
  } catch (error: unknown) {
    driverError = error instanceof Error ? error.name : "UnknownError";
    driverRefusalCode =
      error instanceof DriverToolError ? (error.refusalCode ?? null) : null;
  }

  const permissionsReady =
    permissions?.accessibility === true &&
    permissions?.screen_recording === true;
  const ready =
    Boolean(driverVersion) &&
    provenanceTrusted &&
    driverContractCompatible &&
    health?.schema_version === "1" &&
    health.overall === "ok" &&
    permissionsReady &&
    telemetry?.enabled === false &&
    !driverError;
  return Object.freeze({
    ready,
    driverVersion,
    driverTools,
    driverError,
    driverRefusalCode,
    health: health ? Object.freeze(health) : null,
    permissions: permissions ? Object.freeze(permissions) : null,
    permissionsReady,
    requiredToolsPresent,
    receiptSchemasMatch,
    cleanupReceiptSchemaMatches,
    driverContractCompatible,
    compatibilityReasons: Object.freeze([...compatibilityReasons]),
    provenanceTrusted,
    provenanceReasons: Object.freeze([...provenanceReasons]),
    telemetry,
  });
}

export function cuaReadinessFailure(readiness: CuaReadiness): string | null {
  if (readiness.ready) return null;
  if (!readiness.provenanceTrusted) {
    return `untrusted Cua Driver provenance: ${readiness.provenanceReasons.join("; ") || "unknown"}`;
  }
  if (
    readiness.driverError &&
    readiness.driverRefusalCode !== "permissions_pending"
  ) {
    return `Cua readiness probe failed (${readiness.driverError})`;
  }
  if (readiness.telemetry?.enabled === true) {
    return "Cua telemetry must be disabled";
  }
  if (!readiness.driverContractCompatible) {
    return `incompatible Cua Driver contract: ${readiness.compatibilityReasons.join("; ") || "unknown"}`;
  }
  if (readiness.telemetry?.enabled !== false) {
    return "Cua telemetry must be disabled";
  }
  if (!readiness.permissionsReady) {
    return "Cua Accessibility and Screen Recording permissions are required";
  }
  if (
    readiness.health?.schema_version !== "1" ||
    readiness.health.overall !== "ok"
  ) {
    return "Cua health report is not ready";
  }
  return `Cua readiness failed (${readiness.driverError ?? "UnknownError"})`;
}

export function assertCuaReady(readiness: CuaReadiness): void {
  const failure = cuaReadinessFailure(readiness);
  if (failure) throw new Error(failure);
}
