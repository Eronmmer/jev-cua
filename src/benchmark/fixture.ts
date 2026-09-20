import { createHash } from "node:crypto";

export const BENCHMARK_FIXTURE = Object.freeze({
  origin: "https://jev-cua-benchmark-fixture.erons.workers.dev",
  pathname: "/v6/catalog-search",
  version: "JEV-CUA-CATALOG-SEARCH-V6",
  sha256: "87ac1b63c8a376fdb90f1dfcc2cf507a01f1bb075c534032f2d5191ea8eb3ced",
  maximumBytes: 65_536,
  headers: Object.freeze({
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'none'",
      "object-src 'none'",
      "script-src 'sha256-W/04rw1kodOft+6sbTIgGgMpyJYvrKbO9HAu2TqoO5U='",
      "style-src 'unsafe-inline'",
    ].join("; "),
    "content-type": "text/html; charset=utf-8",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy":
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  }),
});

export type FixtureVerification = Readonly<{
  url: string;
  version: string;
  sha256: string;
  bytes: number;
  latencyMs: number;
}>;

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

export async function verifyBenchmarkFixture(
  fetchImplementation: typeof fetch = fetch,
): Promise<FixtureVerification> {
  const url = `${BENCHMARK_FIXTURE.origin}${BENCHMARK_FIXTURE.pathname}`;
  const started = performance.now();
  const response = await fetchImplementation(url, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "text/html", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || response.status !== 200) {
    throw new Error(`benchmark fixture returned HTTP ${response.status}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > BENCHMARK_FIXTURE.maximumBytes
    ) {
      throw new Error("benchmark fixture content length is unsafe");
    }
  }
  for (const [name, expected] of Object.entries(BENCHMARK_FIXTURE.headers)) {
    if (response.headers.get(name) !== expected) {
      throw new Error(`benchmark fixture security header changed: ${name}`);
    }
  }
  const version = response.headers.get("x-jev-cua-fixture-version");
  if (version !== BENCHMARK_FIXTURE.version) {
    throw new Error("benchmark fixture version changed");
  }
  const bytes = await readBoundedBody(response, BENCHMARK_FIXTURE.maximumBytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const advertisedDigest = response.headers.get("x-jev-cua-fixture-sha256");
  if (
    digest !== BENCHMARK_FIXTURE.sha256 ||
    advertisedDigest !== BENCHMARK_FIXTURE.sha256
  ) {
    throw new Error("benchmark fixture body digest changed");
  }
  return Object.freeze({
    url,
    version,
    sha256: digest,
    bytes: bytes.byteLength,
    latencyMs: elapsed(started),
  });
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) throw new Error("benchmark fixture body is absent");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("benchmark fixture body exceeds its size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("benchmark fixture body is empty");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
