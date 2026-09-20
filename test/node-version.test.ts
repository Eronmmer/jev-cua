import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  assertSupportedNodeRuntime,
  compareSemanticVersions,
  isSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
  parseSemanticVersion,
  UnsupportedNodeRuntimeError,
} from "../src/runtime/node-version.js";

describe("Node runtime version guard", () => {
  test("parses release, prerelease, build, and Node-prefixed versions", () => {
    assert.deepEqual(parseSemanticVersion("v24.21.0+local.1"), {
      major: 24,
      minor: 21,
      patch: 0,
      prerelease: [],
    });
    assert.deepEqual(parseSemanticVersion("24.21.0-rc.2"), {
      major: 24,
      minor: 21,
      patch: 0,
      prerelease: ["rc", 2],
    });
  });

  test("rejects malformed or non-semantic versions", () => {
    for (const value of [
      "",
      "24",
      "24.21",
      "24.021.0",
      "24.21.0-01",
      "24.21.0+",
      "not-node",
    ]) {
      assert.equal(parseSemanticVersion(value), null, value);
    }
  });

  test("compares semantic versions including prerelease precedence", () => {
    const prerelease = parseSemanticVersion("24.21.0-rc.1")!;
    const release = parseSemanticVersion("24.21.0")!;
    const nextMajorPrerelease = parseSemanticVersion("25.0.0-rc.1")!;

    assert.equal(compareSemanticVersions(prerelease, release), -1);
    assert.equal(compareSemanticVersions(release, release), 0);
    assert.equal(compareSemanticVersions(nextMajorPrerelease, release), 1);
  });

  test("accepts the minimum and newer releases and rejects older ones", () => {
    assert.equal(isSupportedNodeVersion(MINIMUM_NODE_VERSION), true);
    assert.equal(isSupportedNodeVersion("24.21.1"), true);
    assert.equal(isSupportedNodeVersion("25.0.0-rc.1"), true);
    assert.equal(isSupportedNodeVersion("24.21.0-rc.1"), false);
    assert.equal(isSupportedNodeVersion("24.20.99"), false);
    assert.equal(isSupportedNodeVersion("invalid"), false);
  });

  test("fails closed with an actionable typed error", () => {
    assert.throws(
      () => assertSupportedNodeRuntime("22.23.2"),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedNodeRuntimeError);
        assert.equal(error.currentVersion, "22.23.2");
        assert.equal(error.minimumVersion, MINIMUM_NODE_VERSION);
        assert.match(error.message, /requires Node\.js 24\.21\.0 or newer/u);
        return true;
      },
    );
    assert.doesNotThrow(() => assertSupportedNodeRuntime("24.21.0"));
  });
});
