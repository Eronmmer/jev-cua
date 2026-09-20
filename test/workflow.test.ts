import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildCompiledWorkflowCandidates } from "../src/workflows/compiler.js";
import { acquireWorkflowApproval } from "../src/workflows/approval.js";
import {
  bindWorkflowInputs,
  loadWorkflowManifests,
  parseWorkflowManifest,
} from "../src/workflows/manifest.js";
import type { BrowserObservation } from "../src/types.js";

const manifestPath = join(
  process.cwd(),
  "workflows",
  "verification-form.example.workflow.json",
);

async function workflow() {
  return parseWorkflowManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
    manifestPath,
  );
}

function observation(
  value: string,
  duplicateField = false,
  buttonName = "Continue",
): BrowserObservation {
  const field = {
    ref: "p1:field",
    role: "textbox",
    name: "verification value",
    value,
    actions: ["type"],
    disabled: false,
    frame: "main",
    visibility: "in_viewport",
  } as const;
  return Object.freeze({
    targetId: "target-1",
    tabId: "tab-1",
    snapshotId: "snapshot-1",
    url: "https://fixture.invalid/",
    title: "Private title that must not be in candidate text",
    outline: "Private outline that must not be in candidate text",
    refs: Object.freeze([
      field,
      ...(duplicateField ? [{ ...field, ref: "p1:duplicate" }] : []),
      {
        ref: "p1:continue",
        role: "button",
        name: buttonName,
        actions: ["click"],
        disabled: false,
        frame: "main",
        visibility: "in_viewport",
      },
    ]),
    complete: true,
    digest: "semantic-digest",
  });
}

describe("compiled workflow manifests", () => {
  test("loads the checked-in disabled reference manifest", async () => {
    const manifests = await loadWorkflowManifests(
      join(process.cwd(), "workflows"),
    );
    const fixture = manifests.find(
      (entry) => entry.id === "verification-form-example",
    );
    assert.ok(fixture);
    assert.equal(fixture.enabled, false);
    assert.equal(fixture.steps.length, 2);
  });

  test("binds exactly the declared inputs and rejects additions or omissions", async () => {
    const compiled = await workflow();
    const invocation = bindWorkflowInputs(compiled, {
      verification_value: "LOCAL-CANARY-42",
    });
    assert.equal(invocation.values[0]?.value, "LOCAL-CANARY-42");
    assert.throws(() => bindWorkflowInputs(compiled, {}), /requires exactly/u);
    assert.throws(
      () =>
        bindWorkflowInputs(compiled, { verification_value: "x", extra: "y" }),
      /requires exactly/u,
    );
  });

  test("emits only the exact next reviewed action and keeps local values out of descriptions", async () => {
    const compiled = await workflow();
    const values = bindWorkflowInputs(compiled, {
      verification_value: "LOCAL-CANARY-42",
    }).values;
    const authorization = await acquireWorkflowApproval(
      compiled,
      async () => compiled.digest,
    );
    assert.ok(authorization.capability);
    const before = buildCompiledWorkflowCandidates({
      workflow: compiled,
      observation: observation(""),
      values,
      approval: authorization.capability,
    });
    const type = before.find(
      (candidate) => candidate.action?.tool === "browser_type",
    );
    assert.ok(type?.action);
    assert.equal(type.risk, "r2_private");
    assert.equal(type.authorization, "approved_workflow");
    assert.equal(type.action.arguments.text, "LOCAL-CANARY-42");
    assert.equal(
      JSON.stringify(before.map((candidate) => candidate.description)).includes(
        "LOCAL-CANARY-42",
      ),
      false,
    );
    assert.equal(
      before.some((candidate) => candidate.action?.tool === "browser_click"),
      false,
    );

    const after = buildCompiledWorkflowCandidates({
      workflow: compiled,
      observation: observation("LOCAL-CANARY-42"),
      values,
      completedSemanticKeys: new Set([
        `workflow:${compiled.id}:${compiled.version}:enter_verification_value`,
      ]),
      approval: authorization.capability,
    });
    assert.equal(
      after.some((candidate) => candidate.action?.tool === "browser_type"),
      false,
    );
    assert.equal(
      after.filter((candidate) => candidate.action?.tool === "browser_click")
        .length,
      1,
    );
  });

  test("fails closed when an exact workflow field is ambiguous", async () => {
    const compiled = await workflow();
    const values = bindWorkflowInputs(compiled, {
      verification_value: "LOCAL-CANARY-42",
    }).values;
    const candidates = buildCompiledWorkflowCandidates({
      workflow: compiled,
      observation: observation("", true),
      values,
    });
    assert.equal(
      candidates.filter((candidate) => candidate.action !== null).length,
      0,
    );
  });

  test("rejects a manifest whose start URL is outside its fixed allowlist", async () => {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    raw.allowed_origins = ["https://other.invalid"];
    assert.throws(
      () => parseWorkflowManifest(raw),
      /outside its fixed origin allowlist/u,
    );
  });

  test("a manifest label cannot downgrade a destructive compiled action", async () => {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
      steps: Array<{
        description: string;
        action: { control?: { name: string } };
      }>;
    };
    const destructive = raw.steps[1]!;
    destructive.description = "Delete account through the reviewed control.";
    if (!destructive.action.control) assert.fail("expected click control");
    destructive.action.control.name = "Delete account";
    const compiled = parseWorkflowManifest(raw);
    const values = bindWorkflowInputs(compiled, {
      verification_value: "LOCAL-CANARY-42",
    }).values;
    const candidates = buildCompiledWorkflowCandidates({
      workflow: compiled,
      observation: observation("LOCAL-CANARY-42", false, "Delete account"),
      values,
      completedSemanticKeys: new Set([
        `workflow:${compiled.id}:${compiled.version}:enter_verification_value`,
      ]),
    });

    assert.equal(
      candidates.find((candidate) => candidate.action?.tool === "browser_click")
        ?.risk,
      "r4_forbidden",
    );
  });

  test("compiles a bounded reviewed scroll that must reveal an exact control", async () => {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    raw.success = {
      kind: "exact_control_visible",
      page: { origin: "https://fixture.invalid", pathname: "/" },
      control: { role: "button", name: "Continue" },
      required_action: "click",
    };
    raw.steps = [
      {
        id: "reveal_continue",
        description:
          "Reveal the exact Continue control lower on the same page.",
        page: { origin: "https://fixture.invalid", pathname: "/" },
        requires: [],
        action: {
          kind: "scroll",
          region: { role: "document", name: "Verification form" },
          direction: "down",
          pixels: 480,
          effect: "reversible_view_change",
        },
        ensures: raw.success,
      },
    ];
    const compiled = parseWorkflowManifest(raw);
    const values = bindWorkflowInputs(compiled, {
      verification_value: "LOCAL-CANARY-42",
    }).values;
    const base = observation("");
    const candidates = buildCompiledWorkflowCandidates({
      workflow: compiled,
      observation: Object.freeze({
        ...base,
        refs: Object.freeze([
          {
            ref: "p1:document",
            role: "document",
            name: "Verification form",
            actions: ["scroll"],
            disabled: false,
            frame: "main",
            visibility: "in_viewport",
          },
        ]),
      }),
      values,
    });
    const scroll = candidates.find(
      (candidate) => candidate.action?.tool === "browser_pointer",
    );

    assert.ok(scroll?.action);
    assert.equal(scroll.risk, "r1_reversible");
    assert.equal(scroll.action.arguments.delta_y, 480);
  });
});
