/**
 * One-off `tools/list` against an MCP server, for the tool picker in settings.
 *
 * Kept free of Electron imports so it can be tested against real stdio and
 * HTTP servers; the caller resolves the launch settings (see
 * McpRuntime.resolveToolDiscoveryLaunch) and supplies a proxy-aware fetch.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, ListToolsResultSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  type McpDiscoveredTool,
  McpToolDiscoveryErrorCode,
  type McpToolDiscoveryRequest,
} from '../../shared/mcp/toolDiscovery';
import { normalizeMcpServerUrlInput } from '../../shared/mcp/url';

/** Launch settings in the shape OpenClaw receives them (see ResolvedMcpServer). */
export interface McpToolDiscoveryLaunch {
  name: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolDiscoveryOptions {
  timeoutMs: number;
  /** Used by the SSE and streamable HTTP transports. */
  fetch?: FetchLike;
  clientVersion?: string;
}

/**
 * A first `npx -y` run may still be downloading the package; heavy servers
 * (browser automation) take over a minute, so stdio gets the same budget as a
 * managed npx install.
 */
export const McpToolDiscoveryTimeoutMs = {
  Stdio: 120_000,
  Remote: 20_000,
} as const;

const MAX_TOOL_LIST_PAGES = 50;
const MAX_TOOL_COUNT = 2_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_STDERR_TAIL_CHARS = 1_500;
// Tokenizers average ~3.5 characters per token on JSON-heavy English text and
// about one token per CJK character.
const ASCII_CHARS_PER_TOKEN = 3.5;

export class McpToolDiscoveryError extends Error {
  constructor(
    readonly code: McpToolDiscoveryErrorCode,
    message: string,
    readonly timeoutMs?: number,
  ) {
    super(message);
    this.name = 'McpToolDiscoveryError';
  }
}

const toStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.trim() && typeof item === 'string') record[key.trim()] = item;
  }
  return record;
};

/**
 * Validates a renderer request; returns the cleaned request, or the reason it
 * cannot run (missing command, unusable URL).
 */
export function normalizeMcpToolDiscoveryRequest(raw: unknown): McpToolDiscoveryRequest | string {
  if (!raw || typeof raw !== 'object') return 'Invalid request';
  const input = raw as Partial<Record<keyof McpToolDiscoveryRequest, unknown>>;
  const transportType = input.transportType;
  if (transportType !== 'stdio' && transportType !== 'sse' && transportType !== 'http') {
    return 'Unsupported transport';
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'mcp-server';
  const serverId = typeof input.serverId === 'string' && input.serverId ? input.serverId : undefined;

  if (transportType === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) return 'Missing command';
    const args = Array.isArray(input.args)
      ? input.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    return { serverId, name, transportType, command, args, env: toStringRecord(input.env) };
  }

  const url = normalizeMcpServerUrlInput(typeof input.url === 'string' ? input.url : '');
  if (!url.ok) return 'Invalid URL';
  return { serverId, name, transportType, url: url.url, headers: toStringRecord(input.headers) };
}

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string };
}

/** Approximate prompt tokens for one tool definition (name, description, schema). */
export function estimateMcpToolTokens(tool: Pick<ListedTool, 'name' | 'description' | 'inputSchema'>): number {
  const text = JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? {},
  });
  let asciiChars = 0;
  let otherChars = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) asciiChars += 1;
    else otherChars += 1;
  }
  return Math.max(1, Math.ceil(asciiChars / ASCII_CHARS_PER_TOKEN + otherChars));
}

function toDiscoveredTool(tool: ListedTool): McpDiscoveredTool {
  const title = (tool.title ?? tool.annotations?.title)?.trim();
  const description = tool.description?.trim();
  return {
    name: tool.name,
    ...(title && title !== tool.name ? { title } : {}),
    ...(description ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) } : {}),
    estimatedTokens: estimateMcpToolTokens(tool),
  };
}

function createStderrTail(): { append: (chunk: unknown) => void; read: () => string } {
  let tail = '';
  return {
    append: (chunk) => {
      tail = (tail + String(chunk)).slice(-MAX_STDERR_TAIL_CHARS);
    },
    read: () => tail.trim(),
  };
}

function createTransport(
  launch: McpToolDiscoveryLaunch,
  options: McpToolDiscoveryOptions,
  stderrTail: ReturnType<typeof createStderrTail>,
): Transport {
  if (launch.transportType === 'stdio') {
    if (!launch.command) {
      throw new McpToolDiscoveryError(McpToolDiscoveryErrorCode.InvalidRequest, 'Missing command');
    }
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args ?? [],
      env: launch.env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', chunk => stderrTail.append(chunk));
    return transport;
  }

  let url: URL;
  try {
    url = new URL(launch.url ?? '');
  } catch {
    throw new McpToolDiscoveryError(McpToolDiscoveryErrorCode.InvalidRequest, 'Invalid URL');
  }
  const transportOptions = {
    requestInit: { headers: launch.headers ?? {} },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  return launch.transportType === 'sse'
    ? new SSEClientTransport(url, transportOptions)
    : new StreamableHTTPClientTransport(url, transportOptions);
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.MethodNotFound;
}

/** Same paging rules as OpenClaw's catalog listing, without its outputSchema compilation. */
async function listAllTools(client: Client, remainingMs: () => number): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    let result;
    try {
      result = await client.request(
        { method: 'tools/list', params: cursor === undefined ? undefined : { cursor } },
        ListToolsResultSchema,
        { timeout: remainingMs() },
      );
    } catch (error) {
      // Resource- or prompt-only servers have no tools to pick from.
      if (page === 0 && isMethodNotFound(error)) return [];
      throw error;
    }
    for (const tool of result.tools as ListedTool[]) {
      const name = tool.name?.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      tools.push({ ...tool, name });
      if (tools.length >= MAX_TOOL_COUNT) return tools;
    }
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return tools;
}

function toDiscoveryError(
  error: unknown,
  stderr: string,
  timeoutMs: number,
): McpToolDiscoveryError {
  if (error instanceof McpToolDiscoveryError) return error;
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new McpToolDiscoveryError(McpToolDiscoveryErrorCode.Timeout, error.message, timeoutMs);
  }
  let message = error instanceof Error ? error.message : String(error);
  // HTTP transports keep the status on `code` and put the response body in
  // the message; "HTTP 401" is what tells a user the key is wrong.
  const httpStatus = error instanceof StreamableHTTPError || error instanceof SseError
    ? error.code
    : undefined;
  if (typeof httpStatus === 'number' && httpStatus > 0) {
    message = `HTTP ${httpStatus}: ${message}`;
  }
  // When the process exits early the SDK only reports "Connection closed";
  // the server's own stderr usually says why (missing key, bad args).
  return new McpToolDiscoveryError(
    McpToolDiscoveryErrorCode.Failed,
    stderr ? `${message}\n${stderr}` : message,
  );
}

/**
 * Connects, lists every tool page, and disconnects. Stdio servers are spawned
 * for the duration of the call only; closing the client stops the process.
 */
export async function discoverMcpTools(
  launch: McpToolDiscoveryLaunch,
  options: McpToolDiscoveryOptions,
): Promise<McpDiscoveredTool[]> {
  const stderrTail = createStderrTail();
  const transport = createTransport(launch, options, stderrTail);
  const client = new Client(
    { name: 'lobsterai-tool-discovery', version: options.clientVersion ?? '0.0.0' },
    { capabilities: {} },
  );
  const deadline = Date.now() + options.timeoutMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());

  const work = (async () => {
    await client.connect(transport, { timeout: remainingMs() });
    return await listAllTools(client, remainingMs);
  })();
  // The deadline may settle the race first; the work promise then rejects
  // once the client is closed below, which must not surface as unhandled.
  work.catch((): void => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineReached = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new McpToolDiscoveryError(
        McpToolDiscoveryErrorCode.Timeout,
        `No response within ${options.timeoutMs}ms`,
        options.timeoutMs,
      ));
    }, options.timeoutMs);
  });

  try {
    const tools = await Promise.race([work, deadlineReached]);
    return tools.map(toDiscoveredTool);
  } catch (error) {
    throw toDiscoveryError(error, stderrTail.read(), options.timeoutMs);
  } finally {
    clearTimeout(timer);
    // Stdio close waits for the process to exit (up to SIGKILL); don't hold
    // the answer back for it.
    void client.close().catch((): void => undefined);
  }
}
