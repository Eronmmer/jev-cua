import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  FIXTURE_HTML,
  FIXTURE_V2_HTML,
  FIXTURE_V3_HTML,
  FIXTURE_V4_HTML,
  FIXTURE_V5_HTML,
  FIXTURE_V6_HTML,
} from "../benchmark-fixture/src/page.js";
import {
  BENCHMARK_FIXTURE,
  verifyBenchmarkFixture,
} from "../src/benchmark/fixture.js";

function fixtureResponse(
  overrides: Readonly<Record<string, string | null>> = {},
) {
  const body = new TextEncoder().encode(FIXTURE_V6_HTML);
  const headers = new Headers({
    "content-length": String(body.byteLength),
    ...BENCHMARK_FIXTURE.headers,
    "x-jev-cua-fixture-sha256": BENCHMARK_FIXTURE.sha256,
    "x-jev-cua-fixture-version": BENCHMARK_FIXTURE.version,
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Response(body, {
    status: 200,
    headers,
  });
}

describe("benchmark fixture contract", () => {
  it("preserves the immutable v1-v5 bodies and pins the exact v6 body", () => {
    assert.equal(
      createHash("sha256").update(FIXTURE_HTML).digest("hex"),
      "64783705fd3c88cc627a77c560c14f3924373b9fb006d61daf0c401f536b828e",
    );
    assert.equal(
      createHash("sha256").update(FIXTURE_V2_HTML).digest("hex"),
      "9bcbceedbf4f2794147f49f8be910779358403e38a5907fa9fd4906c5797b002",
    );
    assert.equal(
      createHash("sha256").update(FIXTURE_V3_HTML).digest("hex"),
      "ea986984af9fda74bce548cb5fbfd80be233848f147f4eccbd8752c87af3447a",
    );
    assert.equal(
      createHash("sha256").update(FIXTURE_V4_HTML).digest("hex"),
      "1b913c3e84b2b84a670af57c322a34c2d683198a027b0a03d8a37b51a24d00be",
    );
    assert.equal(
      createHash("sha256").update(FIXTURE_V5_HTML).digest("hex"),
      "007ba6a8b9deca9d34bdad26e931feefa3e58d12f901f902fd650d8ba9611def",
    );
    assert.equal(
      createHash("sha256").update(FIXTURE_V6_HTML).digest("hex"),
      BENCHMARK_FIXTURE.sha256,
    );
    assert.match(
      FIXTURE_V6_HTML,
      /Fixture contract: JEV-CUA-CATALOG-SEARCH-V6/u,
    );
    for (const label of [
      "Search products",
      "Sort by price low to high",
      "On sale only",
    ]) {
      assert.match(
        FIXTURE_V6_HTML,
        new RegExp(`aria-label="${label} — JEV-CUA-CATALOG-SEARCH-V6"`, "u"),
      );
    }
    assert.doesNotMatch(FIXTURE_V6_HTML, /id="fixture-contract"/u);
  });

  it("accepts only the exact bounded immutable response", async () => {
    const requested: string[] = [];
    const result = await verifyBenchmarkFixture(async (input, init) => {
      requested.push(String(input));
      assert.equal(init?.redirect, "error");
      return fixtureResponse();
    });
    assert.deepEqual(requested, [
      `${BENCHMARK_FIXTURE.origin}${BENCHMARK_FIXTURE.pathname}`,
    ]);
    assert.equal(result.sha256, BENCHMARK_FIXTURE.sha256);
    assert.equal(result.bytes, Buffer.byteLength(FIXTURE_V6_HTML));

    const compressedTransportStyle = await verifyBenchmarkFixture(async () =>
      fixtureResponse({ "content-length": null }),
    );
    assert.equal(compressedTransportStyle.sha256, BENCHMARK_FIXTURE.sha256);
  });

  it("rejects a body or security-contract change", async () => {
    await assert.rejects(
      verifyBenchmarkFixture(async () =>
        fixtureResponse({ "x-jev-cua-fixture-sha256": "0".repeat(64) }),
      ),
      /digest changed/u,
    );
    await assert.rejects(
      verifyBenchmarkFixture(async () =>
        fixtureResponse({
          "content-security-policy":
            "connect-src https://attacker.invalid; " +
            BENCHMARK_FIXTURE.headers["content-security-policy"],
        }),
      ),
      /security header changed/u,
    );
    await assert.rejects(
      verifyBenchmarkFixture(async () =>
        fixtureResponse({ "cross-origin-opener-policy": null }),
      ),
      /security header changed/u,
    );
    const headers = new Headers(fixtureResponse().headers);
    headers.delete("content-length");
    await assert.rejects(
      verifyBenchmarkFixture(
        async () =>
          new Response(new Uint8Array(BENCHMARK_FIXTURE.maximumBytes + 1), {
            status: 200,
            headers,
          }),
      ),
      /size limit/u,
    );
  });
});
