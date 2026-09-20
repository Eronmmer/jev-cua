import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { DriverToolError } from "../src/cua/client.js";
import { PINNED_CUA_DRIVER_VERSION } from "../src/cua/compatibility.js";
import {
  assertCuaReady,
  cuaReadinessFailure,
  probeCuaReadiness,
  readCuaTelemetryStatus,
  type CuaReadinessProbeDependencies,
} from "../src/cua/readiness.js";
import type {
  DriverClient,
  DriverToolDescriptor,
  JsonValue,
} from "../src/types.js";

const requiredTools = [
  "health_report",
  "check_permissions",
  "browser_prepare",
  "browser_navigate",
  "get_browser_state",
  "list_windows",
  "end_session",
];

function actionTool(name: string): DriverToolDescriptor {
  return {
    name,
    outputSchema: {
      anyOf: [
        {
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
    ...requiredTools
      .filter((name) => name !== "end_session")
      .map((name) => ({ name })),
    {
      name: "end_session",
      outputSchema: {
        anyOf: [
          {
            required: ["session", "active"],
            properties: {
              session: { type: "string" },
              active: { const: false },
            },
          },
        ],
      },
    },
    actionTool("browser_click"),
    actionTool("browser_type"),
    actionTool("browser_pointer"),
  ];
}

type ProbeDriver = Pick<DriverClient, "listTools" | "call">;

function fakeDriver(
  options: {
    tools?: readonly DriverToolDescriptor[];
    checkPermissionsError?: Error;
  } = {},
): ProbeDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listTools() {
      calls.push("listTools");
      return options.tools ?? reviewedTools();
    },
    async call(
      tool: string,
      arguments_: Record<string, JsonValue>,
    ): Promise<Record<string, unknown>> {
      calls.push(`${tool}:${JSON.stringify(arguments_)}`);
      if (tool === "health_report") {
        return { schema_version: "1", overall: "ok" };
      }
      if (tool === "check_permissions") {
        if (options.checkPermissionsError) {
          throw options.checkPermissionsError;
        }
        return { accessibility: true, screen_recording: true };
      }
      throw new Error(`Unexpected test tool: ${tool}`);
    },
  };
}

function trustedDependencies(
  overrides: Partial<CuaReadinessProbeDependencies> = {},
): CuaReadinessProbeDependencies {
  return {
    verifyProvenance: async () => ({ trusted: true, reasons: [] }),
    readDriverVersion: async () => PINNED_CUA_DRIVER_VERSION,
    readTelemetryStatus: async () => ({ enabled: false, source: "test" }),
    ...overrides,
  };
}

describe("Cua readiness gate", () => {
  test("accepts only the complete reviewed, healthy, permissioned runtime", async () => {
    const driver = fakeDriver();
    const readiness = await probeCuaReadiness(
      "/test/cua-driver",
      driver,
      trustedDependencies(),
    );

    assert.equal(readiness.ready, true);
    assert.equal(cuaReadinessFailure(readiness), null);
    assert.doesNotThrow(() => assertCuaReady(readiness));
    assert.deepEqual(driver.calls, [
      "listTools",
      "health_report:{}",
      'check_permissions:{"prompt":false}',
    ]);
    assert.equal(Object.isFrozen(readiness), true);
    assert.equal(Object.isFrozen(readiness.telemetry), true);
    assert.equal(Object.isFrozen(readiness.health), true);
    assert.equal(Object.isFrozen(readiness.permissions), true);
  });

  test("does not launch or query a driver whose provenance is untrusted", async () => {
    const driver = fakeDriver();
    let versionRead = false;
    let telemetryRead = false;
    const readiness = await probeCuaReadiness(
      "/test/untrusted-driver",
      driver,
      trustedDependencies({
        verifyProvenance: async () => ({
          trusted: false,
          reasons: ["not the reviewed binary"],
        }),
        readDriverVersion: async () => {
          versionRead = true;
          return PINNED_CUA_DRIVER_VERSION;
        },
        readTelemetryStatus: async () => {
          telemetryRead = true;
          return { enabled: false, source: "test" };
        },
      }),
    );

    assert.equal(readiness.ready, false);
    assert.equal(
      cuaReadinessFailure(readiness),
      "untrusted Cua Driver provenance: not the reviewed binary",
    );
    assert.equal(versionRead, false);
    assert.equal(telemetryRead, false);
    assert.deepEqual(driver.calls, []);
  });

  test("does not call runtime tools after detecting an incompatible contract", async () => {
    const driver = fakeDriver();
    let telemetryRead = false;
    const readiness = await probeCuaReadiness(
      "/test/cua-driver",
      driver,
      trustedDependencies({
        readDriverVersion: async () => "cua-driver 99.0.0",
        readTelemetryStatus: async () => {
          telemetryRead = true;
          return { enabled: false, source: "test" };
        },
      }),
    );

    assert.equal(readiness.driverContractCompatible, false);
    assert.match(
      cuaReadinessFailure(readiness) ?? "",
      /^incompatible Cua Driver contract:/u,
    );
    assert.equal(telemetryRead, true);
    assert.deepEqual(driver.calls, ["listTools"]);
  });

  test("does not start the MCP driver while telemetry is enabled", async () => {
    const driver = fakeDriver();
    const readiness = await probeCuaReadiness(
      "/test/cua-driver",
      driver,
      trustedDependencies({
        readTelemetryStatus: async () => ({ enabled: true, source: "test" }),
      }),
    );

    assert.equal(readiness.ready, false);
    assert.equal(
      cuaReadinessFailure(readiness),
      "Cua telemetry must be disabled",
    );
    assert.deepEqual(driver.calls, []);
  });

  test("preserves the reviewed permissions_pending refusal as setup guidance", async () => {
    const driver = fakeDriver({
      checkPermissionsError: new DriverToolError(
        "check_permissions",
        false,
        "permissions are pending",
        "permissions_pending",
      ),
    });
    const readiness = await probeCuaReadiness(
      "/test/cua-driver",
      driver,
      trustedDependencies(),
    );

    assert.equal(readiness.driverError, "DriverToolError");
    assert.equal(readiness.driverRefusalCode, "permissions_pending");
    assert.equal(
      cuaReadinessFailure(readiness),
      "Cua Accessibility and Screen Recording permissions are required",
    );
    assert.throws(
      () => assertCuaReady(readiness),
      /Accessibility and Screen Recording/u,
    );
  });

  test("reports probe failures rather than misclassifying missing telemetry", async () => {
    const driver = fakeDriver();
    const readiness = await probeCuaReadiness(
      "/test/cua-driver",
      driver,
      trustedDependencies({
        readTelemetryStatus: async () => {
          throw new SyntaxError("malformed test response");
        },
      }),
    );

    assert.equal(readiness.driverError, "SyntaxError");
    assert.equal(
      cuaReadinessFailure(readiness),
      "Cua readiness probe failed (SyntaxError)",
    );
    assert.deepEqual(driver.calls, []);
  });
});

describe("Cua telemetry status parser", () => {
  test("accepts a boolean status and rejects malformed output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jev-cua-readiness-"));
    const binary = join(directory, "cua-driver");
    try {
      await writeFile(
        binary,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"enabled":false,"source":"test"}\'\n',
      );
      await chmod(binary, 0o700);
      assert.deepEqual(await readCuaTelemetryStatus(binary), {
        enabled: false,
        source: "test",
      });

      await writeFile(
        binary,
        "#!/bin/sh\nprintf '%s\\n' '{\"enabled\":\"false\"}'\n",
      );
      await assert.rejects(
        readCuaTelemetryStatus(binary),
        /telemetry status is malformed/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
