import { homedir, tmpdir } from "node:os";
import { isAbsolute } from "node:path";

const FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";

/**
 * Builds the small environment allowed into trusted local helper processes.
 * Provider credentials and arbitrary MCP process variables are deliberately
 * excluded.
 */
export function trustedHelperEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ userDirectories?: boolean }> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: FIXED_PATH,
    LANG: "C",
    LC_ALL: "C",
  };
  if (options.userDirectories) {
    result.HOME = homedir();
    result.TMPDIR = tmpdir();
    for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const) {
      const value = source[name]?.trim();
      if (value && isAbsolute(value)) result[name] = value;
    }
  }
  return result;
}
