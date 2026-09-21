import assert from "node:assert/strict";
import test from "node:test";

import { parseRecoveryArguments } from "../src/recovery/cli.js";

test("recovery CLI requires exact run and session identities", () => {
  assert.deepEqual(
    parseRecoveryArguments([
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--session",
      "jev-cua-123e4567e89b",
    ]),
    {
      runId: "123e4567-e89b-42d3-a456-426614174000",
      session: "jev-cua-123e4567e89b",
    },
  );
  assert.deepEqual(
    parseRecoveryArguments([
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--session",
      "jev-cua-123e4567-e89",
    ]),
    {
      runId: "123e4567-e89b-42d3-a456-426614174000",
      session: "jev-cua-123e4567-e89",
    },
  );
  assert.deepEqual(
    parseRecoveryArguments([
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--session",
      "jev-cua-native-0123456789abcdef",
    ]),
    {
      runId: "123e4567-e89b-42d3-a456-426614174000",
      session: "jev-cua-native-0123456789abcdef",
    },
  );
  for (const arguments_ of [
    [],
    ["--run-id", "not-a-uuid", "--session", "jev-cua-123e4567e89b"],
    [
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--session",
      "other-session",
    ],
    [
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--session",
      "jev-cua-native-0123456789abcde",
    ],
    [
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--session",
      "jev-cua-native-0123456789abcdeG",
    ],
    [
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--run-id",
      "123e4567-e89b-42d3-a456-426614174000",
    ],
  ]) {
    assert.throws(() => parseRecoveryArguments(arguments_));
  }
});
