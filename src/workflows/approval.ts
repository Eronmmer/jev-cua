import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { trustedHelperEnvironment } from "../runtime/child-environment.js";
import type { CompiledWorkflow } from "./types.js";

const execFileAsync = promisify(execFile);
const approvalBrand: unique symbol = Symbol("jev-cua-approved-workflow");

export const WORKFLOW_APPROVAL_KEYCHAIN_SERVICE =
  "ai.typesafe.jev-cua.workflow";

export type WorkflowApprovalStatus = Readonly<{
  approved: boolean;
  account: string;
  reason:
    | "matched"
    | "missing"
    | "mismatched"
    | "invalid"
    | "unsupported"
    | "unavailable";
}>;

export type WorkflowApprovalSecretReader = (
  service: string,
  account: string,
) => Promise<string | undefined>;

export type WorkflowApprovalCapability = Readonly<{
  workflowDigest: string;
  [approvalBrand]: true;
}>;

async function readMacOsKeychainSecret(
  service: string,
  account: string,
): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        encoding: "utf8",
        maxBuffer: 4096,
        timeout: 5_000,
        env: trustedHelperEnvironment(process.env, { userDirectories: true }),
      },
    );
    return stdout.trim();
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === 44 || error.code === "44")
    ) {
      return undefined;
    }
    throw error;
  }
}

function digestMatches(expected: string, stored: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/u.test(stored)) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const storedBytes = Buffer.from(stored.toLowerCase(), "hex");
  return (
    expectedBytes.length === storedBytes.length &&
    timingSafeEqual(expectedBytes, storedBytes)
  );
}

/**
 * Read-only approval check. Creating or changing the Keychain item is kept out
 * of the runtime so an MCP caller cannot silently approve its own workflow.
 */
export async function readWorkflowApproval(
  workflow: Pick<CompiledWorkflow, "id" | "version" | "digest">,
  secretReader: WorkflowApprovalSecretReader = readMacOsKeychainSecret,
): Promise<WorkflowApprovalStatus> {
  const account = `${workflow.id}@${workflow.version}`;
  if (
    process.platform !== "darwin" &&
    secretReader === readMacOsKeychainSecret
  ) {
    return Object.freeze({ approved: false, account, reason: "unsupported" });
  }
  let stored: string | undefined;
  try {
    stored = await secretReader(WORKFLOW_APPROVAL_KEYCHAIN_SERVICE, account);
  } catch {
    return Object.freeze({ approved: false, account, reason: "unavailable" });
  }
  if (stored === undefined)
    return Object.freeze({ approved: false, account, reason: "missing" });
  if (!/^[a-fA-F0-9]{64}$/u.test(stored)) {
    return Object.freeze({ approved: false, account, reason: "invalid" });
  }
  const approved = digestMatches(workflow.digest, stored);
  return Object.freeze({
    approved,
    account,
    reason: approved ? "matched" : "mismatched",
  });
}

export async function acquireWorkflowApproval(
  workflow: Pick<CompiledWorkflow, "id" | "version" | "digest">,
  secretReader: WorkflowApprovalSecretReader = readMacOsKeychainSecret,
): Promise<
  Readonly<{
    status: WorkflowApprovalStatus;
    capability?: WorkflowApprovalCapability;
  }>
> {
  const status = await readWorkflowApproval(workflow, secretReader);
  if (!status.approved) return Object.freeze({ status });
  return Object.freeze({
    status,
    capability: Object.freeze({
      workflowDigest: workflow.digest,
      [approvalBrand]: true as const,
    }),
  });
}

export function capabilityApprovesWorkflow(
  capability: WorkflowApprovalCapability | undefined,
  workflow: Pick<CompiledWorkflow, "digest">,
): boolean {
  return (
    capability?.[approvalBrand] === true &&
    capability.workflowDigest === workflow.digest
  );
}
