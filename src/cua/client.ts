import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Ajv } from "ajv";
import formatsPlugin from "ajv-formats";

import type {
  DriverClient,
  DriverToolDescriptor,
  JsonValue,
} from "../types.js";
import { asRecord } from "../util.js";

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

function createCuaSchemaValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  const addFormats = formatsPlugin as unknown as (instance: Ajv) => Ajv;
  addFormats(ajv);
  ajv.addFormat("uint32", {
    type: "number",
    validate: (value: number) =>
      Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff,
  });
  ajv.addFormat("uint64", {
    type: "number",
    // JSON numbers above this bound cannot preserve exact integer identity.
    validate: (value: number) => Number.isSafeInteger(value) && value >= 0,
  });
  return new AjvJsonSchemaValidator(ajv);
}

export class DriverToolError extends Error {
  constructor(
    readonly tool: string,
    readonly ambiguousExecution: boolean,
    message: string,
    readonly refusalCode?: string,
  ) {
    super(message);
    this.name = "DriverToolError";
  }
}

const MUTATING_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_pointer",
  "browser_navigate",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_prepare",
  "click",
  "type_text",
  "set_value",
  "press_key",
]);

// Cua 0.28.2 reports permission-gate failures as an MCP error whose structured
// code is only `tool_invocation_failed`; retain only this reviewed, non-sensitive
// prefix from the accompanying text. Never propagate arbitrary driver text.
function knownErrorCode(
  content: readonly { type: string; text?: string }[],
): string | undefined {
  return content.some(
    (item) =>
      item.type === "text" && item.text?.startsWith("permissions_pending:"),
  )
    ? "permissions_pending"
    : undefined;
}

export async function resolveCuaDriverBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.platform === "darwin") {
    const installed = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
    await access(installed);
    return installed;
  }
  const explicit = env.CUA_DRIVER_BIN?.trim();
  const candidates = [
    explicit,
    join(homedir(), ".local", "bin", "cua-driver"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next stable path.
    }
  }
  return "cua-driver";
}

export class CuaMcpClient implements DriverClient {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connecting: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly binary: string) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Cua MCP client is closed");
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async open(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.binary,
      args: ["mcp"],
      env: getDefaultEnvironment(),
      stderr: "pipe",
      maxBufferSize: 20 * 1024 * 1024,
    });
    // Cua writes diagnostics only to stderr. Drain it so a long-lived nested
    // server cannot deadlock on pipe backpressure; never forward raw output.
    transport.stderr?.on("data", () => undefined);
    const client = new Client(
      { name: "jev-cua", version: "0.1.0" },
      { jsonSchemaValidator: createCuaSchemaValidator() },
    );
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.transport = undefined;
      }
    };
    try {
      await client.connect(transport);
      if (this.closed) {
        await client.close().catch(() => undefined);
        throw new Error("Cua MCP client closed while connecting");
      }
      this.transport = transport;
      this.client = client;
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(): Promise<readonly DriverToolDescriptor[]> {
    await this.connect();
    const result = await this.client!.listTools(undefined, { timeout: 10_000 });
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.inputSchema
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {}),
      ...(tool.outputSchema
        ? { outputSchema: tool.outputSchema as Record<string, unknown> }
        : {}),
    }));
  }

  async call(
    tool: string,
    arguments_: Record<string, JsonValue>,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<Record<string, unknown>> {
    await this.connect();
    try {
      const result = await this.client!.callTool(
        { name: tool, arguments: arguments_ },
        undefined,
        {
          timeout: DEFAULT_CALL_TIMEOUT_MS,
          maxTotalTimeout: DEFAULT_CALL_TIMEOUT_MS,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if ("toolResult" in result)
        throw new DriverToolError(
          tool,
          MUTATING_TOOLS.has(tool),
          `${tool} returned an unsupported task result`,
        );
      const structured = result.structuredContent;
      if (structured) {
        const data = asRecord(
          structured,
          `${tool} returned malformed structured output`,
        );
        if (
          data.status === "refused" ||
          data.effect === "refused" ||
          data.refusal
        ) {
          const refusal =
            data.refusal &&
            typeof data.refusal === "object" &&
            !Array.isArray(data.refusal)
              ? (data.refusal as Record<string, unknown>)
              : {};
          const code =
            typeof refusal.code === "string" ? refusal.code : undefined;
          // A refusal can be emitted after partial/unknown delivery. The public
          // Cua contract does not universally prove pre-dispatch refusal, so a
          // mutating refusal is conservatively non-retryable.
          throw new DriverToolError(
            tool,
            MUTATING_TOOLS.has(tool),
            `${tool} refused the request${code ? ` (${code})` : ""}`,
            code,
          );
        }
        if (result.isError)
          throw new DriverToolError(
            tool,
            MUTATING_TOOLS.has(tool),
            `${tool} reported an error`,
            knownErrorCode(result.content),
          );
        validateStructuredReceipt(tool, arguments_, data);
        return data;
      }
      if (result.isError)
        throw new DriverToolError(
          tool,
          MUTATING_TOOLS.has(tool),
          `${tool} reported an error`,
          knownErrorCode(result.content),
        );
      throw new DriverToolError(
        tool,
        MUTATING_TOOLS.has(tool),
        `${tool} returned no structured output`,
      );
    } catch (error: unknown) {
      if (error instanceof DriverToolError) throw error;
      if (
        this.client &&
        /connection closed|not connected/iu.test(
          error instanceof Error ? error.message : "",
        )
      ) {
        const failed = this.client;
        this.client = undefined;
        this.transport = undefined;
        await failed.close().catch(() => undefined);
      }
      throw new DriverToolError(
        tool,
        MUTATING_TOOLS.has(tool),
        `${tool} failed with ${error instanceof Error ? error.name : "UnknownError"}`,
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connecting?.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) await client.close();
  }
}

export function validateStructuredReceipt(
  tool: string,
  arguments_: Readonly<Record<string, JsonValue>>,
  data: Readonly<Record<string, unknown>>,
): void {
  if (tool === "end_session") {
    if (
      data.active !== false ||
      (typeof arguments_.session === "string" &&
        data.session !== arguments_.session)
    ) {
      throw new DriverToolError(
        tool,
        false,
        `${tool} returned no positive cleanup receipt`,
      );
    }
    return;
  }
  if (!MUTATING_TOOLS.has(tool)) return;
  if (tool === "browser_prepare") {
    if (data.status !== "ok") {
      throw new DriverToolError(
        tool,
        true,
        `${tool} returned no positive preparation receipt`,
      );
    }
    const pid = data.prepared_pid;
    if (data.prepared !== true) {
      throw new DriverToolError(
        tool,
        true,
        `${tool} did not prove that preparation completed`,
      );
    }
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new DriverToolError(
        tool,
        true,
        `${tool} returned a malformed preparation receipt`,
      );
    }
    return;
  }
  if (tool === "browser_navigate") {
    if (data.status !== "ok") {
      throw new DriverToolError(
        tool,
        true,
        `${tool} returned no positive navigation receipt`,
      );
    }
    for (const field of ["target_id", "tab_id"] as const) {
      if (
        typeof arguments_[field] === "string" &&
        data[field] !== arguments_[field]
      ) {
        throw new DriverToolError(
          tool,
          true,
          `${tool} receipt did not match the requested browser capability`,
        );
      }
    }
    if (data.url !== arguments_.url || data.refs_invalidated !== true) {
      throw new DriverToolError(
        tool,
        true,
        `${tool} receipt did not match the requested URL`,
      );
    }
    return;
  }
  if (
    tool === "browser_click" ||
    tool === "browser_type" ||
    tool === "browser_pointer"
  ) {
    const canonicalEffects = new Set(["confirmed", "partial", "unverifiable"]);
    const canonicalRoutes = new Set([
      "accessibility",
      "synthetic_events",
      "global_input",
      "system_api",
      "dom",
      "trusted_input",
    ]);
    if (data.effect === "partial") {
      throw new DriverToolError(
        tool,
        true,
        `${tool} reported partial delivery`,
      );
    }
    const canonical =
      canonicalEffects.has(String(data.effect)) &&
      canonicalRoutes.has(String(data.route));
    if (!canonical) {
      throw new DriverToolError(
        tool,
        true,
        `${tool} returned no supported dispatch receipt`,
      );
    }
    const expectedRoute = (() => {
      if (tool === "browser_type") {
        return arguments_.mode === "insert_text" ||
          arguments_.mode === "keystrokes"
          ? "trusted_input"
          : null;
      }
      if (arguments_.input_route === "dom_event") return "dom";
      if (arguments_.input_route === "trusted") return "trusted_input";
      return null;
    })();
    if (expectedRoute === null || data.route !== expectedRoute) {
      throw new DriverToolError(
        tool,
        true,
        `${tool} receipt did not match the requested delivery route`,
      );
    }
    if (
      data.effect === "confirmed" &&
      (!Array.isArray(data.evidence) || data.evidence.length === 0)
    ) {
      throw new DriverToolError(
        tool,
        true,
        `${tool} returned an unsupported confirmed receipt`,
      );
    }
    for (const field of ["target_id", "tab_id"] as const) {
      if (
        typeof arguments_[field] === "string" &&
        data[field] !== undefined &&
        data[field] !== arguments_[field]
      ) {
        throw new DriverToolError(
          tool,
          true,
          `${tool} receipt did not match the requested browser capability`,
        );
      }
    }
    if (
      typeof arguments_.ref === "string" &&
      data.ref !== undefined &&
      data.ref !== arguments_.ref
    ) {
      throw new DriverToolError(
        tool,
        true,
        `${tool} receipt did not match the requested semantic ref`,
      );
    }
    return;
  }
  if (data.status !== "ok") {
    throw new DriverToolError(
      tool,
      true,
      `${tool} returned no positive execution receipt`,
    );
  }
}
