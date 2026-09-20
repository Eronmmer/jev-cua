import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  observeBrowser,
  parseBrowserObservation,
  verifySuccess,
} from "../src/cua/browser.js";
import type { DriverClient, JsonValue } from "../src/types.js";

describe("Cua semantic browser contract", () => {
  test("parses the documented semantic_v2 response shape", () => {
    const observed = parseBrowserObservation(
      {
        status: "ok",
        mode: "snapshot",
        target_id: "target-1",
        tab_id: "tab-1",
        page: { url: "https://example.test/inbox", title: "Inbox" },
        outline: '- heading "Message"\n- textbox "Reply body"',
        snapshot: {
          id: "p42",
          format: "semantic_v2",
          complete: false,
          continuation: "bc-next",
        },
        refs: [
          {
            ref: "p42:8",
            role: "button",
            name: "Reply",
            value: null,
            states: { disabled: false },
            actions: ["click"],
            frame: "main",
            visibility: "in_viewport",
          },
          {
            ref: "p42:9",
            role: "textbox",
            name: "Reply body",
            value: "draft",
            states: { disabled: true },
            actions: ["type"],
            frame: "main",
            visibility: "in_viewport",
          },
        ],
      },
      "target-1",
      "tab-1",
    );

    assert.equal(observed.url, "https://example.test/inbox");
    assert.equal(observed.snapshotId, "p42");
    assert.equal(observed.title, "Inbox");
    assert.equal(observed.complete, false);
    assert.equal(observed.continuation, "bc-next");
    assert.equal(observed.refs.length, 2);
    assert.equal(observed.refs[0]?.disabled, false);
    assert.equal(observed.refs[1]?.disabled, true);
    assert.deepEqual(observed.refs[0]?.actions, ["click"]);
    assert.match(observed.digest, /^[a-f0-9]{64}$/u);
  });

  test("digest changes when an actionable field changes", () => {
    const base = {
      status: "ok",
      mode: "snapshot",
      target_id: "target",
      tab_id: "tab",
      page: { url: "https://example.test/form", title: "Form" },
      snapshot: { id: "p1", format: "semantic_v2", complete: true },
      refs: [
        {
          ref: "p1:1",
          role: "textbox",
          name: "Email",
          value: "",
          states: { disabled: false },
          actions: ["type"],
          frame: "main",
          visibility: "in_viewport",
        },
      ],
    };
    const before = parseBrowserObservation(base, "target", "tab");
    const after = parseBrowserObservation(
      {
        ...base,
        refs: [{ ...base.refs[0], value: "approved@example.test" }],
      },
      "target",
      "tab",
    );
    assert.notEqual(before.digest, after.digest);
  });

  test("field verification uses the locally held slot value", () => {
    const observation = parseBrowserObservation(
      {
        status: "ok",
        mode: "snapshot",
        target_id: "target",
        tab_id: "tab",
        page: { url: "https://example.test/form", title: "Form" },
        snapshot: { id: "p1", format: "semantic_v2", complete: true },
        refs: [
          {
            ref: "p1:1",
            role: "textbox",
            name: "Account email",
            value: "approved@example.test",
            actions: ["type"],
            frame: "main",
            visibility: "in_viewport",
          },
        ],
      },
      "target",
      "tab",
    );
    assert.equal(
      verifySuccess(
        observation,
        {
          kind: "exact_field_equals",
          page: { origin: "https://example.test", pathname: "/form" },
          field: { role: "textbox", name: "Account email" },
          inputId: "email",
        },
        [
          {
            id: "email",
            description: "Account email",
            value: "approved@example.test",
            targetHints: ["email"],
            secret: false,
          },
        ],
      ),
      true,
    );
    assert.equal(
      verifySuccess(
        observation,
        {
          kind: "exact_field_equals",
          page: { origin: "https://example.test", pathname: "/form" },
          field: { role: "textbox", name: "email" },
          inputId: "email",
        },
        [
          {
            id: "email",
            description: "Account email",
            value: "approved@example.test",
            targetHints: ["email"],
            secret: false,
          },
        ],
      ),
      false,
    );
  });

  test("exact URL verification rejects query and fragment spoofing", () => {
    const base = {
      targetId: "target",
      tabId: "tab",
      snapshotId: "p1",
      title: "Done",
      refs: [],
      complete: true,
      digest: "digest",
    } as const;
    const condition = {
      kind: "exact_url" as const,
      origin: "https://example.test",
      pathname: "/done",
    };
    assert.equal(
      verifySuccess(
        { ...base, url: "https://example.test/done" },
        condition,
        [],
      ),
      true,
    );
    assert.equal(
      verifySuccess(
        { ...base, url: "https://example.test/done?error=1" },
        condition,
        [],
      ),
      false,
    );
    assert.equal(
      verifySuccess(
        { ...base, url: "https://example.test/done#failed" },
        condition,
        [],
      ),
      false,
    );
  });

  test("rejects contradictory completion and cross-snapshot continuations", async () => {
    const page = { url: "https://example.test/form", title: "Form" };
    assert.throws(() =>
      parseBrowserObservation(
        {
          status: "ok",
          mode: "snapshot",
          target_id: "target",
          tab_id: "tab",
          page,
          snapshot: {
            id: "p1",
            format: "semantic_v2",
            complete: true,
            continuation: "unexpected",
          },
          refs: [],
        },
        "target",
        "tab",
      ),
    );

    const responses = [
      {
        status: "ok",
        mode: "snapshot",
        target_id: "target",
        tab_id: "tab",
        page,
        snapshot: {
          id: "p1",
          format: "semantic_v2",
          complete: false,
          continuation: "next",
        },
        refs: [],
      },
      {
        status: "ok",
        mode: "snapshot",
        target_id: "target",
        tab_id: "tab",
        page,
        snapshot: { id: "p2", format: "semantic_v2", complete: true },
        refs: [],
      },
    ];
    let index = 0;
    const driver: DriverClient = {
      connect: async () => undefined,
      listTools: async () => [],
      call: async (_tool: string, _arguments: Record<string, JsonValue>) =>
        structuredClone(responses[index++]!),
      close: async () => undefined,
    };
    await assert.rejects(
      () =>
        observeBrowser(
          driver,
          { targetId: "target", tabId: "tab", privateState: false },
          "session",
          ["https://example.test"],
        ),
      /snapshot changed/u,
    );
  });
});
