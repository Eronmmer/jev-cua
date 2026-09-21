import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("native MCP tools advertise bounded object output schemas and the reviewed step contract", async (t) => {
  const client = new Client(
    { name: "jev-cua-contract-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  t.after(async () => client.close().catch(() => undefined));
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const names = [
    "jev_cua_native_start",
    "jev_cua_native_list_windows",
    "jev_cua_native_observe",
    "jev_cua_native_step",
    "jev_cua_native_end",
  ];
  for (const name of names) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    assert.equal(tool.outputSchema?.type, "object", name);
    assert.equal(tool.outputSchema?.additionalProperties, false, name);
    assert.deepEqual(tool.outputSchema?.required, ["outcome"], name);
  }

  const step = tools.find(
    (candidate) => candidate.name === "jev_cua_native_step",
  );
  assert.ok(step);
  const input = step.inputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(input.properties?.text);
  const serialized = JSON.stringify(step.inputSchema);
  assert.match(serialized, /label_contains/u);
  assert.match(serialized, /value_equals/u);
  assert.doesNotMatch(serialized, /"kind":\{"const":"window"\}/u);
});
