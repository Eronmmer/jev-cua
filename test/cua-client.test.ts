import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CuaMcpClient,
  DriverToolError,
  validateDriverImageContent,
  validateStructuredReceipt,
} from "../src/cua/client.js";

const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");
const MINIMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

function clientReturning(
  result: Readonly<Record<string, unknown>>,
): CuaMcpClient {
  const client = new CuaMcpClient("unused-in-test");
  Object.assign(client, {
    client: {
      callTool: async () => result,
    },
  });
  return client;
}

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

describe("bounded Cua image content", () => {
  test("returns only validated PNG and JPEG image blocks", () => {
    assert.deepEqual(
      validateDriverImageContent([
        { type: "text", text: "not forwarded" },
        {
          type: "image",
          data: MINIMAL_PNG,
          mimeType: "image/png",
          annotations: { audience: ["assistant"] },
        },
        { type: "image", data: MINIMAL_JPEG, mimeType: "image/jpeg" },
      ]),
      [
        { type: "image", data: MINIMAL_PNG, mimeType: "image/png" },
        { type: "image", data: MINIMAL_JPEG, mimeType: "image/jpeg" },
      ],
    );
  });

  test("rejects unsupported, malformed, mismatched, excessive, and oversized images", () => {
    const validPng = {
      type: "image",
      data: MINIMAL_PNG,
      mimeType: "image/png",
    } as const;
    for (const content of [
      [{ ...validPng, mimeType: "image/gif" }],
      [{ ...validPng, data: "not base64" }],
      [{ ...validPng, mimeType: "image/jpeg" }],
      Array.from({ length: 5 }, () => validPng),
    ]) {
      assert.throws(() => validateDriverImageContent(content));
    }

    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
    Buffer.from(MINIMAL_PNG, "base64").copy(oversized);
    assert.throws(() =>
      validateDriverImageContent([
        {
          type: "image",
          data: oversized.toString("base64"),
          mimeType: "image/png",
        },
      ]),
    );
  });

  test("callWithContent returns images while call preserves structured-only behavior", async () => {
    const invalidImage = {
      type: "image",
      data: MINIMAL_PNG,
      mimeType: "image/gif",
    };
    const plainClient = clientReturning({
      structuredContent: { snapshot_id: "s1" },
      content: [invalidImage],
      isError: false,
    });
    assert.deepEqual(await plainClient.call("get_window_state", {}), {
      snapshot_id: "s1",
    });
    await assert.rejects(
      () => plainClient.callWithContent("get_window_state", {}),
      (error: unknown) =>
        error instanceof DriverToolError && !error.ambiguousExecution,
    );

    const imageClient = clientReturning({
      structuredContent: { snapshot_id: "s2" },
      content: [
        { type: "text", text: "ignored" },
        { type: "image", data: MINIMAL_PNG, mimeType: "image/png" },
      ],
      isError: false,
    });
    assert.deepEqual(
      await imageClient.callWithContent("get_window_state", {}),
      {
        structuredContent: { snapshot_id: "s2" },
        images: [{ type: "image", data: MINIMAL_PNG, mimeType: "image/png" }],
      },
    );
  });

  test("callWithContent retains centralized refusal and ambiguity handling", async () => {
    const refused = clientReturning({
      structuredContent: {
        status: "refused",
        refusal: { code: "policy_denied" },
      },
      content: [],
      isError: false,
    });
    await assert.rejects(
      () => refused.callWithContent("get_window_state", {}),
      (error: unknown) =>
        error instanceof DriverToolError &&
        !error.ambiguousExecution &&
        error.refusalCode === "policy_denied",
    );

    const malformedAfterMutation = clientReturning({
      structuredContent: {
        effect: "unverifiable",
        route: "accessibility",
      },
      content: [{ type: "image", data: MINIMAL_PNG, mimeType: "image/gif" }],
      isError: false,
    });
    await assert.rejects(
      () => malformedAfterMutation.callWithContent("click", {}),
      (error: unknown) =>
        error instanceof DriverToolError && error.ambiguousExecution,
    );
  });
});
