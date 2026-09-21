import assert from "node:assert/strict";
import test from "node:test";

import {
  DriverToolError,
  driverToolMayMutate,
  validateStructuredReceipt,
} from "../src/cua/client.js";

test("native common action receipts use effect and route instead of status", () => {
  for (const tool of ["click", "set_value", "invoke_menu"]) {
    assert.doesNotThrow(() =>
      validateStructuredReceipt(
        tool,
        { delivery_mode: "background" },
        {
          effect: "unverifiable",
          route: "accessibility",
          delivery: { mode: "not_applicable" },
        },
      ),
    );
    assert.throws(
      () =>
        validateStructuredReceipt(
          tool,
          {},
          {
            effect: "partial",
            route: "accessibility",
            delivery: { mode: "not_applicable" },
          },
        ),
      (error: unknown) =>
        error instanceof DriverToolError && error.ambiguousExecution,
    );
    assert.equal(driverToolMayMutate(tool), true);
  }
  for (const tool of ["type_text", "press_key", "scroll"]) {
    assert.doesNotThrow(() =>
      validateStructuredReceipt(
        tool,
        { delivery_mode: "background" },
        {
          effect: "unverifiable",
          route: "synthetic_events",
          delivery: { mode: "background" },
        },
      ),
    );
  }
});

test("synthetic native delivery cannot claim not_applicable background mode", () => {
  assert.throws(
    () =>
      validateStructuredReceipt(
        "scroll",
        { delivery_mode: "background" },
        {
          effect: "unverifiable",
          route: "synthetic_events",
          delivery: { mode: "not_applicable" },
        },
      ),
    (error: unknown) =>
      error instanceof DriverToolError && error.ambiguousExecution,
  );
});

test("all exposed native mutations are classified ambiguous on transport error", () => {
  for (const tool of [
    "click",
    "double_click",
    "right_click",
    "type_text",
    "set_value",
    "press_key",
    "hotkey",
    "scroll",
    "drag",
    "invoke_menu",
    "launch_app",
    "bring_to_front",
    "set_window_frame",
    "kill_app",
    "clipboard_write",
    "move_cursor",
    "set_agent_cursor_enabled",
    "set_agent_cursor_motion",
    "set_agent_cursor_theme",
    "set_config",
    "start_recording",
    "stop_recording",
    "replay_trajectory",
    "install_ffmpeg",
    "escalate_session",
    "page",
  ]) {
    assert.equal(driverToolMayMutate(tool), true, tool);
  }
});

test("native confirmed receipts require bounded evidence", () => {
  assert.doesNotThrow(() =>
    validateStructuredReceipt(
      "click",
      {},
      {
        effect: "confirmed",
        route: "accessibility",
        evidence: [{ kind: "value_readback" }],
      },
    ),
  );
  assert.throws(
    () =>
      validateStructuredReceipt(
        "click",
        {},
        {
          effect: "confirmed",
          route: "accessibility",
          evidence: [],
        },
      ),
    (error: unknown) =>
      error instanceof DriverToolError && error.ambiguousExecution,
  );
});

test("native receipt validation rejects silent foreground fallback", () => {
  assert.throws(
    () =>
      validateStructuredReceipt(
        "click",
        { delivery_mode: "background" },
        {
          effect: "unverifiable",
          route: "accessibility",
          delivery: { mode: "foreground" },
        },
      ),
    (error: unknown) =>
      error instanceof DriverToolError && error.ambiguousExecution,
  );
});
