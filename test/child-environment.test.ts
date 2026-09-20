import assert from "node:assert/strict";
import test from "node:test";

import { trustedHelperEnvironment } from "../src/runtime/child-environment.js";

test("trusted helper children never inherit provider credentials", () => {
  const environment = trustedHelperEnvironment(
    {
      TYPESAFE_API_KEY: "must-not-cross-process-boundary",
      OPENAI_API_KEY: "must-not-cross-process-boundary",
      XDG_CONFIG_HOME: "/tmp/reviewed-config",
      MALICIOUS_PRELOAD: "must-not-cross-process-boundary",
    },
    { userDirectories: true },
  );

  assert.equal(environment.TYPESAFE_API_KEY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.MALICIOUS_PRELOAD, undefined);
  assert.equal(environment.XDG_CONFIG_HOME, "/tmp/reviewed-config");
  assert.ok(environment.HOME);
  assert.ok(environment.TMPDIR);
  assert.equal(environment.LANG, "C");
});
