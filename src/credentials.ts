import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const TYPESAFE_KEYCHAIN_SERVICE = "ai.typesafe.jev-cua";

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
      ["find-generic-password", "-s", TYPESAFE_KEYCHAIN_SERVICE, "-w"],
      { timeout: 1_500, maxBuffer: 16 * 1024 },
    );
    const key = stdout.trim();
    return key
      ? Object.freeze({ source: "keychain", apiKey: key })
      : Object.freeze({ source: "missing" });
  } catch {
    return Object.freeze({ source: "missing" });
  }
}
