import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  assessCuaCompatibility,
  PINNED_CUA_DRIVER_VERSION,
  verifyCuaDriverProvenance,
} from "../src/cua/compatibility.js";
import type { DriverToolDescriptor } from "../src/types.js";

const required = [
  "health_report",
  "check_permissions",
  "get_accessibility_tree",
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "start_session",
  "click",
  "type_text",
  "set_value",
  "press_key",
  "scroll",
  "invoke_menu",
  "browser_prepare",
  "browser_navigate",
  "get_browser_state",
  "end_session",
];

const actions = [
  "click",
  "type_text",
  "set_value",
  "press_key",
  "scroll",
  "invoke_menu",
  "browser_click",
  "browser_type",
  "browser_pointer",
];

function actionTool(name: string): DriverToolDescriptor {
  return {
    name,
    outputSchema: {
      type: "object",
      anyOf: [
        {
          type: "object",
          required: ["effect", "route"],
          properties: {
            effect: {
              enum: [
                "confirmed",
                "partial",
                "unverifiable",
                "suspected_noop",
                "refused",
              ],
            },
            route: {
              enum: [
                "accessibility",
                "synthetic_events",
                "global_input",
                "system_api",
                "dom",
                "trusted_input",
              ],
            },
          },
        },
      ],
    },
  };
}

function reviewedTools(): DriverToolDescriptor[] {
  return [
    ...required
      .filter((name) => name !== "end_session" && !actions.includes(name))
      .map((name) => ({ name })),
    {
      name: "end_session",
      outputSchema: {
        type: "object",
        anyOf: [
          {
            type: "object",
            required: ["session", "active"],
            properties: {
              session: { type: "string" },
              active: { const: false },
            },
          },
        ],
      },
    },
    ...actions.map(actionTool),
  ];
}

describe("Cua runtime trust contract", () => {
  test("accepts only the pinned version and exact reviewed action receipt enums", () => {
    assert.equal(
      assessCuaCompatibility(PINNED_CUA_DRIVER_VERSION, reviewedTools())
        .compatible,
      true,
    );

    const changedVersion = assessCuaCompatibility(
      "cua-driver 0.28.3",
      reviewedTools(),
    );
    assert.equal(changedVersion.compatible, false);
    assert.equal(changedVersion.versionMatches, false);

    const changedSchema = reviewedTools();
    const click = changedSchema.find((tool) => tool.name === "browser_click")!;
    const branch = click.outputSchema!.anyOf as Array<Record<string, unknown>>;
    const properties = branch[0]!.properties as Record<
      string,
      Record<string, unknown>
    >;
    properties.effect!.enum = ["confirmed"];
    const assessment = assessCuaCompatibility(
      PINNED_CUA_DRIVER_VERSION,
      changedSchema,
    );
    assert.equal(assessment.compatible, false);
    assert.equal(assessment.receiptSchemasMatch, false);

    const changedCleanup = reviewedTools().map((tool) =>
      tool.name === "end_session"
        ? { name: "end_session", outputSchema: { type: "object" } }
        : tool,
    );
    const cleanupAssessment = assessCuaCompatibility(
      PINNED_CUA_DRIVER_VERSION,
      changedCleanup,
    );
    assert.equal(cleanupAssessment.compatible, false);
    assert.equal(cleanupAssessment.cleanupReceiptSchemaMatches, false);
  });

  test(
    "accepts the installed signed Cua application identity on macOS",
    { skip: process.platform !== "darwin" },
    async () => {
      const provenance = await verifyCuaDriverProvenance(
        "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      );
      assert.deepEqual(provenance, { trusted: true, reasons: [] });
    },
  );
});
