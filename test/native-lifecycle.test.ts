import assert from "node:assert/strict";
import test from "node:test";

import { DriverToolError } from "../src/cua/client.js";
import {
  assertExactLaunchCapability,
  parseLaunchReceipt,
  verifyLaunchedIdentity,
  type NativeInstalledAppIdentity,
} from "../src/native/lifecycle.js";

const STOPPED: NativeInstalledAppIdentity = Object.freeze({
  bundleId: "com.example.Fixture",
  launchPath: "/Applications/Fixture.app",
  name: "Fixture",
  running: false,
  active: false,
  pid: 0,
});

test("launch binding rejects duplicate bundle IDs and stale running state", () => {
  assert.doesNotThrow(() => assertExactLaunchCapability(STOPPED, [STOPPED]));
  assert.throws(() =>
    assertExactLaunchCapability(STOPPED, [
      STOPPED,
      { ...STOPPED, launchPath: "/Applications/Other/Fixture.app" },
    ]),
  );
  assert.throws(() =>
    assertExactLaunchCapability(STOPPED, [
      { ...STOPPED, running: true, pid: 42 },
    ]),
  );
});

test("launch receipt and independent inventory must match exact identity", () => {
  const receipt = parseLaunchReceipt(STOPPED, {
    bundle_id: STOPPED.bundleId,
    pid: 42,
    launch_state: {
      requested: true,
      process_running: true,
      window_ready: true,
    },
    self_activation_suppressed: true,
  });
  assert.deepEqual(receipt, {
    bundleId: STOPPED.bundleId,
    pid: 42,
    windowReady: true,
  });
  const running = { ...STOPPED, running: true, pid: 42 };
  assert.deepEqual(
    verifyLaunchedIdentity(STOPPED, receipt, [running]),
    running,
  );
  assert.throws(() =>
    verifyLaunchedIdentity(STOPPED, receipt, [
      { ...running, launchPath: "/Applications/Impostor.app" },
    ]),
  );
});

test("launch receipt fails closed on foreground activation or malformed state", () => {
  assert.throws(
    () =>
      parseLaunchReceipt(STOPPED, {
        bundle_id: STOPPED.bundleId,
        pid: 42,
        launch_state: {
          requested: true,
          process_running: true,
          window_ready: false,
        },
        self_activation_suppressed: false,
      }),
    (error: unknown) =>
      error instanceof DriverToolError && error.ambiguousExecution,
  );
});
