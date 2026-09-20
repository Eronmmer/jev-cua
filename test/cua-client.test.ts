import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DriverToolError,
  validateStructuredReceipt,
} from "../src/cua/client.js";

describe("Cua 0.28.2 mutation receipts", () => {
  test("accepts canonical unverifiable delivery for independent post-verification", () => {
    assert.doesNotThrow(() =>
      validateStructuredReceipt(
        "browser_click",
        {
          target_id: "target",
          tab_id: "tab",
          ref: "p2:4",
          input_route: "dom_event",
        },
        {
          effect: "unverifiable",
          route: "dom",
          delivery: { mode: "background" },
          escalation: { target: "page", reason: "effect_unconfirmed" },
        },
      ),
    );
  });

  test("treats partial delivery and malformed confirmation as ambiguous", () => {
    for (const receipt of [
      {
        effect: "partial",
        route: "trusted_input",
        delivery: { mode: "background", delivered_count: 2 },
      },
      { effect: "confirmed", route: "trusted_input", evidence: [] },
    ]) {
      assert.throws(
        () =>
          validateStructuredReceipt(
            "browser_type",
            { target_id: "target", tab_id: "tab", ref: "p2:2", text: "abc" },
            receipt,
          ),
        (error: unknown) =>
          error instanceof DriverToolError && error.ambiguousExecution,
      );
    }
  });

  test("rejects silent fallback outside the requested delivery route", () => {
    for (const [tool, arguments_, route] of [
      [
        "browser_click",
        {
          target_id: "target",
          tab_id: "tab",
          ref: "p2:4",
          input_route: "dom_event",
        },
        "accessibility",
      ],
      [
        "browser_pointer",
        {
          target_id: "target",
          tab_id: "tab",
          ref: "p2:6",
          action: "scroll",
          input_route: "trusted",
        },
        "global_input",
      ],
      [
        "browser_type",
        {
          target_id: "target",
          tab_id: "tab",
          ref: "p2:2",
          text: "abc",
          mode: "insert_text",
        },
        "dom",
      ],
    ] as const) {
      assert.throws(
        () =>
          validateStructuredReceipt(tool, arguments_, {
            effect: "unverifiable",
            route,
          }),
        (error: unknown) =>
          error instanceof DriverToolError && error.ambiguousExecution,
      );
    }
  });

  test("requires the exact prepare and navigation receipts", () => {
    assert.doesNotThrow(() =>
      validateStructuredReceipt(
        "browser_prepare",
        { allow_launch: true },
        { status: "ok", prepared: true, prepared_pid: 42 },
      ),
    );
    assert.throws(() =>
      validateStructuredReceipt(
        "browser_prepare",
        { allow_launch: true },
        { status: "ok", prepared: false, prepared_pid: 42 },
      ),
    );
    assert.doesNotThrow(() =>
      validateStructuredReceipt(
        "browser_navigate",
        { target_id: "target", tab_id: "tab", url: "https://example.test/" },
        {
          status: "ok",
          target_id: "target",
          tab_id: "tab",
          url: "https://example.test/",
          refs_invalidated: true,
        },
      ),
    );
    assert.throws(() =>
      validateStructuredReceipt(
        "browser_navigate",
        { target_id: "target", tab_id: "tab", url: "https://example.test/" },
        {
          status: "ok",
          target_id: "other",
          tab_id: "tab",
          url: "https://example.test/",
          refs_invalidated: true,
        },
      ),
    );
  });

  test("requires a positive session-cleanup receipt", () => {
    assert.doesNotThrow(() =>
      validateStructuredReceipt(
        "end_session",
        { session: "run" },
        { active: false, session: "run" },
      ),
    );
    assert.throws(
      () =>
        validateStructuredReceipt(
          "end_session",
          { session: "run" },
          { active: false, session: "other" },
        ),
      (error: unknown) =>
        error instanceof DriverToolError && !error.ambiguousExecution,
    );
  });
});
