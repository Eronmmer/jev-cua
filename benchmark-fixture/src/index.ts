import {
  FIXTURE_HTML,
  FIXTURE_PATH,
  FIXTURE_SCRIPT,
  FIXTURE_V2_HTML,
  FIXTURE_V2_PATH,
  FIXTURE_V3_HTML,
  FIXTURE_V3_PATH,
  FIXTURE_V4_HTML,
  FIXTURE_V4_PATH,
  FIXTURE_V5_HTML,
  FIXTURE_V5_PATH,
  FIXTURE_V6_HTML,
  FIXTURE_V6_PATH,
} from "./page.js";

const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

function securityHeaders(
  bodyDigest: string,
  scriptDigest: string,
  version: string,
): HeadersInit {
  return {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Security-Policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'none'",
      "object-src 'none'",
      `script-src 'sha256-${scriptDigest}'`,
      "style-src 'unsafe-inline'",
    ].join("; "),
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Jev-Cua-Fixture-Sha256": bodyDigest,
    "X-Jev-Cua-Fixture-Version": version,
  };
}

function fixtureForPath(
  pathname: string,
): Readonly<{ html: string; version: string }> | undefined {
  if (pathname === FIXTURE_PATH) {
    return {
      html: FIXTURE_HTML,
      version: "JEV-CUA-CATALOG-SEARCH-V1",
    };
  }
  if (pathname === FIXTURE_V2_PATH) {
    return {
      html: FIXTURE_V2_HTML,
      version: "JEV-CUA-CATALOG-SEARCH-V2",
    };
  }
  if (pathname === FIXTURE_V3_PATH) {
    return {
      html: FIXTURE_V3_HTML,
      version: "JEV-CUA-CATALOG-SEARCH-V3",
    };
  }
  if (pathname === FIXTURE_V4_PATH) {
    return {
      html: FIXTURE_V4_HTML,
      version: "JEV-CUA-CATALOG-SEARCH-V4",
    };
  }
  if (pathname === FIXTURE_V5_PATH) {
    return {
      html: FIXTURE_V5_HTML,
      version: "JEV-CUA-CATALOG-SEARCH-V5",
    };
  }
  if (pathname === FIXTURE_V6_PATH) {
    return {
      html: FIXTURE_V6_HTML,
      version: "JEV-CUA-CATALOG-SEARCH-V6",
    };
  }
  return undefined;
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const fixture = fixtureForPath(url.pathname);
      if (
        (request.method !== "GET" && request.method !== "HEAD") ||
        !fixture ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        return new Response("Not Found\n", {
          status: 404,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const [bodyDigest, scriptDigest] = await Promise.all([
        sha256Hex(fixture.html),
        sha256Base64(FIXTURE_SCRIPT),
      ]);
      return new Response(request.method === "HEAD" ? null : fixture.html, {
        status: 200,
        headers: securityHeaders(bodyDigest, scriptDigest, fixture.version),
      });
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          message: "benchmark fixture request failed",
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return new Response("Internal Server Error\n", {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  },
} satisfies ExportedHandler;
