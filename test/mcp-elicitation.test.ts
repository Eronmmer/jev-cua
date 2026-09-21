import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ElicitRequestSchema,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { requestNativeApproval } from "../src/native/approval.js";
import type { NativeApprovalContext } from "../src/native/manager.js";

test("SDK form elicitation carries one exact native approval through the pending tool call", async (t) => {
  const server = new McpServer({
    name: "native-approval-protocol-test",
    version: "1.0.0",
  });
  const context: NativeApprovalContext = Object.freeze({
    runRef: "nrun_public",
    observationRef: "nobs_public",
    actionRef: "nact_public",
    operationFingerprint: "0123456789abcdef",
    actionKind: "click",
    risk: "r3_consequential",
    appLabel: "Fixture App",
    windowLabel: "Fixture Window",
    controlRole: "AXButton",
    controlLabel: "Continue",
    untrustedUiData: true,
  });
  server.registerTool(
    "approve_once",
    { inputSchema: {} },
    async (_input, extra) => {
      const decision = await requestNativeApproval(context, {
        supportsForm:
          server.server.getClientCapabilities()?.elicitation?.form !==
          undefined,
        signal: extra.signal,
        send: async (request) => {
          const response = await extra.sendRequest(
            {
              method: "elicitation/create",
              params: {
                mode: request.mode,
                message: request.message,
                requestedSchema: {
                  type: "object",
                  properties: {
                    approve: {
                      ...request.requestedSchema.properties.approve,
                    },
                  },
                  required: [...request.requestedSchema.required],
                },
              },
            },
            ElicitResultSchema,
          );
          return {
            action: response.action,
            ...(response.content === undefined
              ? {}
              : { content: response.content }),
          };
        },
      });
      return {
        content: [{ type: "text", text: decision.status }],
        structuredContent: { status: decision.status },
      };
    },
  );

  const client = new Client(
    { name: "native-approval-client", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  let requests = 0;
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    requests += 1;
    assert.equal(request.params.mode, "form");
    assert.match(request.params.message, /Action reference: nact_public/u);
    return { action: "accept", content: { approve: true } };
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const result = await client.callTool({ name: "approve_once", arguments: {} });
  assert.equal(requests, 1);
  assert.deepEqual(result.structuredContent, { status: "approved" });
});
