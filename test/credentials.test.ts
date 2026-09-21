import assert from "node:assert/strict";
import { test } from "node:test";

import { probeTypeSafeCredential } from "../src/credentials.js";

test("credential readiness probes presence without retrieving the secret", async () => {
  let lookups = 0;
  const fromEnvironment = await probeTypeSafeCredential(
    { TYPESAFE_API_KEY: "  present  " },
    {
      keychainItemExists: async () => {
        lookups += 1;
        return true;
      },
    },
  );
  assert.deepEqual(fromEnvironment, {
    source: "environment",
    present: true,
  });
  assert.equal(lookups, 0);

  if (process.platform === "darwin") {
    const fromKeychain = await probeTypeSafeCredential(
      {},
      {
        keychainItemExists: async () => {
          lookups += 1;
          return true;
        },
      },
    );
    assert.deepEqual(fromKeychain, { source: "keychain", present: true });
    assert.equal(lookups, 1);

    const missing = await probeTypeSafeCredential(
      {},
      { keychainItemExists: async () => false },
    );
    assert.deepEqual(missing, { source: "missing", present: false });
  }
});
