import { createHash, randomBytes } from "node:crypto";

import type { JsonValue } from "./types.js";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
}

export function randomOpaqueId(prefix = "c"): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested);
  }
  return value;
}

export function asRecord(
  value: unknown,
  message = "expected an object",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}

export function truncateUntrusted(value: string, maximum: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1)}…`;
}

export function redactProviderText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/\b(?:\d[ -]?){6,}\d\b/gu, "[number]")
    .replace(
      /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9_-]{8,}\b/giu,
      "[credential]",
    )
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\b/giu, "[opaque-value]");
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(
      () => gate,
      () => gate,
    );
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
