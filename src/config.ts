import { homedir } from "node:os";
import { join } from "node:path";

export type Thresholds = Readonly<{
  minimumProbability: number;
  minimumConfidence: number;
  minimumMargin: number;
  minimumFit: number;
}>;

export type RuntimeConfig = Readonly<{
  model: string;
  providerTimeoutMs: number;
  maxCandidates: number;
  labelMaxLength: number;
  stateDirectory: string;
  workflowDirectory: string;
  logLevel: "debug" | "info" | "warn" | "error" | "off";
  thresholds: Thresholds;
}>;

export const PINNED_JEV_MODEL = "jev-1.13.0";

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    return fallback;
  return parsed;
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const stateDirectory =
    env.JEV_CUA_STATE_DIR?.trim() ||
    join(
      env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"),
      "jev-cua",
    );
  const requestedLogLevel = env.JEV_CUA_LOG_LEVEL?.trim();
  const logLevel =
    requestedLogLevel === "debug" ||
    requestedLogLevel === "info" ||
    requestedLogLevel === "warn" ||
    requestedLogLevel === "error" ||
    requestedLogLevel === "off"
      ? requestedLogLevel
      : "warn";

  return Object.freeze({
    // Model and conservative experimental gates are pinned. They are not a
    // substitute for per-workflow calibration, and environment variables must
    // not silently swap or weaken them in a production MCP launch.
    model: PINNED_JEV_MODEL,
    providerTimeoutMs: boundedInteger(
      env.JEV_CUA_PROVIDER_TIMEOUT_MS,
      1_500,
      250,
      10_000,
    ),
    maxCandidates: boundedInteger(env.JEV_CUA_MAX_CANDIDATES, 24, 4, 32),
    labelMaxLength: boundedInteger(env.JEV_CUA_LABEL_MAX_LENGTH, 120, 24, 240),
    stateDirectory,
    workflowDirectory:
      env.JEV_CUA_WORKFLOW_DIR?.trim() || join(process.cwd(), "workflows"),
    logLevel,
    thresholds: Object.freeze({
      minimumProbability: 0.9,
      minimumConfidence: 0.8,
      minimumMargin: 0.5,
      minimumFit: 0.9,
    }),
  });
}
