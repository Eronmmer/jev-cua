import { execFile as execFileCallback } from "node:child_process";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveCuaDriverBinary } from "../cua/client.js";
import {
  PINNED_CUA_DRIVER_VERSION,
  verifyCuaDriverProvenance,
} from "../cua/compatibility.js";
import { trustedHelperEnvironment } from "../runtime/child-environment.js";
import { assertSupportedNodeRuntime } from "../runtime/node-version.js";
import { DesktopLease, LiveExecutionBarrier, RunStore } from "../state.js";

const execFile = promisify(execFileCallback);

type RecoveryArguments = Readonly<{ runId: string; session: string }>;

export function parseRecoveryArguments(
  arguments_: readonly string[],
): RecoveryArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (flag !== "--run-id" && flag !== "--session") ||
      !value ||
      value.startsWith("--") ||
      values.has(flag)
    ) {
      throw new Error(
        "usage: npm run reconcile-live -- --run-id <uuid> --session <session>",
      );
    }
    values.set(flag, value);
  }
  const runId = values.get("--run-id");
  const session = values.get("--session");
  if (
    !runId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      runId,
    ) ||
    !session ||
    !/^jev-cua-(?:[a-f0-9]{12}|[a-f0-9]{8}-[a-f0-9]{3})$/u.test(session)
  ) {
    throw new Error(
      "the exact doctor-reported run ID and session are required",
    );
  }
  return Object.freeze({ runId, session });
}

async function assertNoLiveCuaSessions(binary: string): Promise<void> {
  const { stdout } = await execFile(binary, ["sessions", "--json"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: trustedHelperEnvironment(process.env, { userDirectories: true }),
  });
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  if (
    !Number.isSafeInteger(parsed.count) ||
    parsed.count !== 0 ||
    !Array.isArray(parsed.sessions) ||
    parsed.sessions.length !== 0
  ) {
    throw new Error(
      "Cua still has a live session; revoke the exact session and rerun sessions --json before acknowledging reconciliation",
    );
  }
}

async function assertTrustedRecoveryRuntime(binary: string): Promise<void> {
  const provenance = await verifyCuaDriverProvenance(binary);
  if (!provenance.trusted) {
    throw new Error(
      `Cua Driver provenance is not trusted: ${provenance.reasons.join("; ") || "unknown"}`,
    );
  }
  const { stdout } = await execFile(binary, ["--version"], {
    timeout: 5_000,
    maxBuffer: 4 * 1024,
    env: trustedHelperEnvironment(process.env, { userDirectories: true }),
  });
  if (stdout.trim() !== PINNED_CUA_DRIVER_VERSION) {
    throw new Error(
      `recovery requires ${PINNED_CUA_DRIVER_VERSION}; found ${stdout.trim() || "unknown version"}`,
    );
  }
}

async function main(): Promise<void> {
  assertSupportedNodeRuntime();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "reconciliation acknowledgement requires an interactive trusted terminal",
    );
  }
  const input = parseRecoveryArguments(process.argv.slice(2));
  const stateDirectory = join(
    userInfo().homedir,
    ".local",
    "state",
    "jev-cua-runtime",
  );
  const barrier = new LiveExecutionBarrier(stateDirectory);
  const runs = new RunStore(stateDirectory);
  const lease = new DesktopLease(stateDirectory);
  const release = await lease.acquire(`recovery-${input.runId}`);
  try {
    const status = await barrier.status();
    const durableStatus = await runs.liveExecutionStatus();
    if (status.blocked) {
      if (status.runId !== input.runId || status.session !== input.session) {
        throw new Error(
          "the supplied identity does not own the active execution barrier",
        );
      }
    } else {
      const compact = input.runId.replaceAll("-", "").slice(0, 12);
      const legacy = input.runId.slice(0, 12);
      if (
        !durableStatus.blocked ||
        (input.session !== `jev-cua-${compact}` &&
          input.session !== `jev-cua-${legacy}`)
      ) {
        throw new Error(
          "no matching barrier or unresolved durable run was found",
        );
      }
    }
    const binary = await resolveCuaDriverBinary();
    // Recovery needs the reviewed read-only sessions contract, but it must not
    // depend on action readiness: lost TCC permissions, unhealthy action tools,
    // or telemetry drift must not make an execution barrier irrecoverable.
    await assertTrustedRecoveryRuntime(binary);
    await assertNoLiveCuaSessions(binary);

    process.stdout.write(
      [
        `Run: ${input.runId}`,
        `Session: ${input.session}`,
        `Barrier state: ${status.blocked ? (status.state ?? "malformed") : "ledger_only"}`,
        "This command cannot verify the target site's remote state.",
        "Continue only after you have reconciled the real external outcome.",
      ].join("\n") + "\n",
    );
    const phrase = `RECONCILED ${input.runId}`;
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answer: string;
    try {
      answer = await prompt.question(`Type exactly '${phrase}' to continue: `);
    } finally {
      prompt.close();
    }
    if (answer !== phrase)
      throw new Error("reconciliation was not acknowledged");
    await assertTrustedRecoveryRuntime(binary);
    await assertNoLiveCuaSessions(binary);

    // The acknowledgement is committed first. A crash before archiving the
    // barrier remains fail-closed; the original run ledger is never removed,
    // so the old idempotency key can never execute again.
    await runs.acknowledgeReconciliation(input.runId, {
      barrierOwnerConfirmed: status.blocked,
    });
    const archivePath = status.blocked
      ? await barrier.archiveResolved(input.runId, input.session)
      : null;
    const [barrierAfter, runsAfter] = await Promise.all([
      barrier.status(),
      runs.liveExecutionStatus(),
    ]);
    if (barrierAfter.blocked || runsAfter.blocked) {
      throw new Error(
        "reconciliation was recorded, but another safety blocker remains",
      );
    }
    process.stdout.write(
      archivePath
        ? `Reconciliation acknowledged. Barrier archived at ${archivePath}.\n`
        : "Reconciliation acknowledged. The original run ledger remains in place.\n",
    );
  } finally {
    await release();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Reconciliation failed: ${error instanceof Error ? error.message : "UnknownError"}\n`,
    );
    process.exitCode = 1;
  });
}
