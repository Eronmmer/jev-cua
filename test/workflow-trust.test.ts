import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  readWorkflowApproval,
  WORKFLOW_APPROVAL_KEYCHAIN_SERVICE,
} from "../src/workflows/approval.js";
import {
  bindWorkflowInputs,
  loadWorkflowManifests,
  parseWorkflowManifest,
} from "../src/workflows/manifest.js";
import { parseJsonWithoutDuplicateKeys } from "../src/workflows/strict-json.js";

function manifest() {
  return {
    schema: "jev-cua.workflow.v1",
    id: "trusted-form",
    version: 7,
    enabled: true,
    description: "A bounded test workflow.",
    goal: "Enter the reviewed private reference.",
    target: {
      kind: "isolated",
      start_url: "https://fixture.invalid/start",
      navigation_effect: "read_only_landing",
    },
    allowed_origins: ["https://fixture.invalid"],
    inputs: [
      {
        id: "reference",
        description: "Private reference",
        target_hints: ["reference"],
        classification: "private",
        max_length: 8,
        pattern: "^[A-Z0-9-]+$",
        enum: ["ABC-123"],
        allowed_disclosure_origins: ["https://fixture.invalid"],
      },
    ],
    success: {
      kind: "exact_url",
      origin: "https://fixture.invalid",
      pathname: "/submitted",
    },
    steps: [
      {
        id: "enter_reference",
        description: "Enter the approved reference.",
        page: { origin: "https://fixture.invalid", pathname: "/start" },
        requires: [],
        action: {
          kind: "type",
          field: { role: "textbox", name: "Reference" },
          input_id: "reference",
          effect: "private_data_entry",
        },
        ensures: {
          kind: "exact_field_equals",
          page: { origin: "https://fixture.invalid", pathname: "/start" },
          field: { role: "textbox", name: "Reference" },
          input_id: "reference",
        },
      },
      {
        id: "submit_reference",
        description: "Submit the reviewed form.",
        page: { origin: "https://fixture.invalid", pathname: "/start" },
        requires: [
          {
            kind: "field_equals",
            field: { role: "textbox", name: "Reference" },
            input_id: "reference",
          },
        ],
        action: {
          kind: "click",
          control: { role: "button", name: "Submit" },
          input_route: "dom_event",
          effect: "consequential_submit",
        },
        ensures: {
          kind: "exact_url",
          origin: "https://fixture.invalid",
          pathname: "/submitted",
        },
      },
    ],
  };
}

async function trustedTemporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jev-cua-workflow-trust-"));
  await chmod(directory, 0o700);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

describe("workflow manifest trust boundary", () => {
  test("digests exact file bytes and retains explicit classifications and effects", async (t) => {
    const directory = await trustedTemporaryDirectory(t);
    const bytes = `${JSON.stringify(manifest(), null, 2)}\n`;
    const path = join(directory, "trusted.workflow.json");
    await writeFile(path, bytes, { mode: 0o600 });

    const [workflow] = await loadWorkflowManifests(directory);
    assert.ok(workflow);
    assert.equal(
      workflow.digest,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(workflow.inputs[0]?.classification, "private");
    assert.equal(
      workflow.inputs[0]?.allowedDisclosureOrigins[0],
      "https://fixture.invalid",
    );
    assert.equal(workflow.steps[0]?.action.effect, "private_data_entry");
    assert.equal(workflow.steps[1]?.action.effect, "consequential_submit");
  });

  test("rejects symlinked and writable manifest files", async (t) => {
    const directory = await trustedTemporaryDirectory(t);
    const outside = join(directory, "outside.json");
    await writeFile(outside, JSON.stringify(manifest()), { mode: 0o600 });
    await symlink(outside, join(directory, "linked.workflow.json"));
    await assert.rejects(loadWorkflowManifests(directory));

    await rm(join(directory, "linked.workflow.json"));
    const writable = join(directory, "writable.workflow.json");
    await writeFile(writable, JSON.stringify(manifest()), { mode: 0o600 });
    await chmod(writable, 0o622);
    await assert.rejects(
      loadWorkflowManifests(directory),
      /group- or world-writable/u,
    );
  });

  test("rejects a writable workflow directory", async (t) => {
    const directory = await trustedTemporaryDirectory(t);
    await chmod(directory, 0o777);
    await assert.rejects(
      loadWorkflowManifests(directory),
      /group- or world-writable/u,
    );
  });

  test("rejects undeclared safety-looking fields at every nested policy boundary", () => {
    const raw = manifest();
    const firstStep = raw.steps[0]!;
    Object.assign(firstStep.action, {
      requires_user_approval: true,
      risk: "r0_read_only",
    });
    assert.throws(
      () => parseWorkflowManifest(raw),
      /unrecognized_keys|Unrecognized key/u,
    );

    const inputSpoof = manifest();
    Object.assign(inputSpoof.inputs[0]!, { secret: false });
    assert.throws(
      () => parseWorkflowManifest(inputSpoof),
      /unrecognized_keys|Unrecognized key/u,
    );
  });

  test("rejects duplicate JSON keys and invisible format controls", () => {
    assert.throws(
      () =>
        parseJsonWithoutDuplicateKeys(
          '{"enabled":false,"enabled":true}',
          "fixture",
        ),
      /duplicate object key/u,
    );
    const raw = manifest();
    raw.description = "Reviewed\u202Efalse";
    assert.throws(
      () => parseWorkflowManifest(raw),
      /control or format characters/u,
    );
  });

  test("rejects a private input whose action effect downgrades its classification", () => {
    const raw = manifest();
    raw.steps[0]!.action.effect = "public_data_entry";
    assert.throws(
      () => parseWorkflowManifest(raw),
      /public_data_entry for a private input/u,
    );
  });

  test("permits only the bounded linear-time input-pattern subset", () => {
    const unsafe = manifest();
    unsafe.inputs[0]!.pattern = "^(A+)+$";
    assert.throws(
      () => parseWorkflowManifest(unsafe),
      /one anchored character class/u,
    );

    const ambiguous = manifest();
    ambiguous.inputs[0]!.pattern = "^A*A*A*A*B$";
    assert.throws(
      () => parseWorkflowManifest(ambiguous),
      /one anchored character class/u,
    );
  });

  test("rejects legacy substring and page-text success oracles", () => {
    const raw = manifest() as Record<string, unknown>;
    raw.success = { kind: "url_includes", value: "/done" };
    assert.throws(() => parseWorkflowManifest(raw));

    raw.success = { kind: "text_present", value: "Success" };
    assert.throws(() => parseWorkflowManifest(raw));
  });

  test("requires explicit mutation policy fields", () => {
    const missingRoute = manifest() as Record<string, unknown>;
    const steps = missingRoute.steps as Array<Record<string, unknown>>;
    delete (steps[1]!.action as Record<string, unknown>).input_route;
    assert.throws(() => parseWorkflowManifest(missingRoute));

    const missingRequirements = manifest() as Record<string, unknown>;
    delete (missingRequirements.steps as Array<Record<string, unknown>>)[0]!
      .requires;
    assert.throws(() => parseWorkflowManifest(missingRequirements));
  });

  test("enforces length, enum, pattern, and private classification while binding", () => {
    const workflow = parseWorkflowManifest(manifest());
    const invocation = bindWorkflowInputs(workflow, { reference: "ABC-123" });
    assert.equal(invocation.values[0]?.secret, false);
    assert.equal(invocation.values[0]?.classification, "private");
    assert.throws(
      () => bindWorkflowInputs(workflow, { reference: "abc-123" }),
      /outside its enum/u,
    );
    assert.throws(
      () => bindWorkflowInputs(workflow, { reference: "TOO-LONG-1" }),
      /max_length/u,
    );
  });

  test("accepts only a Keychain digest for the exact id and version", async () => {
    const workflow = parseWorkflowManifest(manifest());
    let observedService = "";
    let observedAccount = "";
    const matched = await readWorkflowApproval(
      workflow,
      async (service, account) => {
        observedService = service;
        observedAccount = account;
        return workflow.digest.toUpperCase();
      },
    );
    assert.equal(observedService, WORKFLOW_APPROVAL_KEYCHAIN_SERVICE);
    assert.equal(observedAccount, "trusted-form@7");
    assert.deepEqual(matched, {
      approved: true,
      account: "trusted-form@7",
      reason: "matched",
    });

    const mismatched = await readWorkflowApproval(workflow, async () =>
      "0".repeat(64),
    );
    assert.equal(mismatched.approved, false);
    assert.equal(mismatched.reason, "mismatched");
    const missing = await readWorkflowApproval(workflow, async () => undefined);
    assert.equal(missing.reason, "missing");
  });
});
