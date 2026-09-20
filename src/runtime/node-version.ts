export const MINIMUM_NODE_VERSION = "24.21.0";

export type SemanticVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (number | string)[];
}>;

const SEMANTIC_VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = SEMANTIC_VERSION.exec(value);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;

  const prerelease = match[4]
    ? match[4].split(".").map((identifier) => {
        const numeric = Number(identifier);
        return /^0$|^[1-9]\d*$/u.test(identifier) &&
          Number.isSafeInteger(numeric)
          ? numeric
          : identifier;
      })
    : [];

  return Object.freeze({
    major,
    minor,
    patch,
    prerelease: Object.freeze(prerelease),
  });
}

function comparePrerelease(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (
      typeof leftIdentifier === "number" &&
      typeof rightIdentifier === "string"
    ) {
      return -1;
    }
    if (
      typeof leftIdentifier === "string" &&
      typeof rightIdentifier === "number"
    ) {
      return 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function compareSemanticVersions(
  left: SemanticVersion,
  right: SemanticVersion,
): number {
  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isSupportedNodeVersion(
  currentVersion: string,
  minimumVersion = MINIMUM_NODE_VERSION,
): boolean {
  const current = parseSemanticVersion(currentVersion);
  const minimum = parseSemanticVersion(minimumVersion);
  return Boolean(
    current && minimum && compareSemanticVersions(current, minimum) >= 0,
  );
}

export class UnsupportedNodeRuntimeError extends Error {
  override readonly name = "UnsupportedNodeRuntimeError";

  constructor(
    readonly currentVersion: string,
    readonly minimumVersion: string,
  ) {
    super(
      `jev-cua requires Node.js ${minimumVersion} or newer; current runtime is ${currentVersion || "unknown"}.`,
    );
  }
}

export function assertSupportedNodeRuntime(
  currentVersion = process.versions.node,
  minimumVersion = MINIMUM_NODE_VERSION,
): void {
  if (!isSupportedNodeVersion(currentVersion, minimumVersion)) {
    throw new UnsupportedNodeRuntimeError(currentVersion, minimumVersion);
  }
}
