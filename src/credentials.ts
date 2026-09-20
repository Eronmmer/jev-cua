import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { trustedHelperEnvironment } from "./runtime/child-environment.js";

const execFile = promisify(execFileCallback);
export const TYPESAFE_KEYCHAIN_SERVICE = "ai.typesafe.jev-cua";
export const TYPESAFE_KEYCHAIN_ACCOUNT = "typesafe-api-key";

export type CredentialSource = "environment" | "keychain" | "missing";

export type TypeSafeCredential = Readonly<{
  source: CredentialSource;
  apiKey?: string;
}>;

export async function loadTypeSafeCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TypeSafeCredential> {
  const environmentKey = env.TYPESAFE_API_KEY?.trim();
  if (environmentKey)
    return Object.freeze({ source: "environment", apiKey: environmentKey });
  if (process.platform !== "darwin")
    return Object.freeze({ source: "missing" });
  try {
    const { stdout } = await execFile(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        TYPESAFE_KEYCHAIN_SERVICE,
        "-a",
        TYPESAFE_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      {
        timeout: 1_500,
        maxBuffer: 16 * 1024,
        env: trustedHelperEnvironment(process.env, { userDirectories: true }),
      },
    );
    const key = stdout.trim();
    return key
      ? Object.freeze({ source: "keychain", apiKey: key })
      : Object.freeze({ source: "missing" });
  } catch {
    return Object.freeze({ source: "missing" });
  }
}
