import { DriverToolError } from "../cua/client.js";

export type NativeInstalledAppIdentity = Readonly<{
  bundleId: string;
  launchPath: string | null;
  name: string;
  running: boolean;
  active: boolean;
  pid: number;
}>;

export type NativeLaunchReceipt = Readonly<{
  bundleId: string;
  pid: number;
  windowReady: boolean;
}>;

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * Launch by bundle ID is safe only when the current inventory maps that ID to
 * one exact installed path. Cua does not accept a launch path, so duplicates
 * must fail closed instead of allowing LaunchServices to choose one.
 */
export function assertExactLaunchCapability(
  requested: NativeInstalledAppIdentity,
  inventory: readonly NativeInstalledAppIdentity[],
): void {
  if (
    !requested.bundleId.trim() ||
    requested.bundleId.length > 512 ||
    requested.launchPath === null ||
    !requested.launchPath.startsWith("/") ||
    requested.launchPath.length > 4_096 ||
    requested.running ||
    requested.pid !== 0
  ) {
    throw new Error("native app is not an exact stopped launch capability");
  }
  const matches = inventory.filter(
    (app) => app.bundleId === requested.bundleId,
  );
  if (
    matches.length !== 1 ||
    matches[0]?.launchPath !== requested.launchPath ||
    matches[0]?.running
  ) {
    throw new Error("native app launch identity is ambiguous or stale");
  }
}

export function parseLaunchReceipt(
  requested: NativeInstalledAppIdentity,
  output: Readonly<Record<string, unknown>>,
): NativeLaunchReceipt {
  const state =
    output.launch_state &&
    typeof output.launch_state === "object" &&
    !Array.isArray(output.launch_state)
      ? (output.launch_state as Record<string, unknown>)
      : undefined;
  if (
    output.bundle_id !== requested.bundleId ||
    !positiveInteger(output.pid) ||
    state?.requested !== true ||
    state.process_running !== true ||
    typeof state.window_ready !== "boolean" ||
    output.self_activation_suppressed !== true
  ) {
    throw new DriverToolError(
      "launch_app",
      true,
      "launch_app returned no exact background-launch receipt",
    );
  }
  return Object.freeze({
    bundleId: requested.bundleId,
    pid: output.pid,
    windowReady: state.window_ready,
  });
}

export function verifyLaunchedIdentity(
  requested: NativeInstalledAppIdentity,
  receipt: NativeLaunchReceipt,
  inventory: readonly NativeInstalledAppIdentity[],
): NativeInstalledAppIdentity {
  const matches = inventory.filter(
    (app) =>
      app.bundleId === requested.bundleId &&
      app.launchPath === requested.launchPath &&
      app.running &&
      app.pid === receipt.pid,
  );
  if (matches.length !== 1)
    throw new Error("native app launch could not be independently verified");
  return matches[0]!;
}
