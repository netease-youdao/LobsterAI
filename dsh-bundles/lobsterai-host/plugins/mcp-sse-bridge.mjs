/**
 * @lobsterai/dsh-bundle — Legacy MCP SSE Transport Bridge
 *
 * DSH's built-in `@deepseek-ai/dsh-mcp-manager` / `@deepseek-ai/dsh-mcp-client`
 * supports `stdio` and `streamable-http` only. This host-bundle module bridges
 * legacy HTTP+SSE MCP servers (`transport: 'sse'`) into DSH's live `ctx.tools`
 * registry with zero DSH runtime patches, reusing `@modelcontextprotocol/client`
 * (`Client`, `SSEClientTransport`, `SseError`) and `@deepseek-ai/dsh-mcp-client`
 * (`createMcpToolDefinition`, `SERVER_NAME_PATTERN`) resolved as peer deps.
 */

import { Client, SSEClientTransport, SseError } from '@modelcontextprotocol/client';
import { createMcpToolDefinition, SERVER_NAME_PATTERN } from '@deepseek-ai/dsh-mcp-client';
import {
  createMcpSseBridgeController,
  normalizeSseServerEntry,
  publicSseToolName,
} from './mcp-sse-bridge-helpers.mjs';

export { normalizeSseServerEntry, publicSseToolName };

/**
 * Create a live legacy-SSE MCP bridge bound to the Cordis plugin context.
 *
 * @param {any} ctx
 */
export function createMcpSseBridge(ctx) {
  return createMcpSseBridgeController(ctx, {
    serverNamePattern: SERVER_NAME_PATTERN,
    isSseError: (error) => error instanceof SseError,
    createClient: ({ onToolsListChanged }) => new Client(
      {
        name: 'lobsterai-dsh-sse',
        version: '1.0.0',
      },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: onToolsListChanged,
          },
        },
      },
    ),
    createTransport: (config) => new SSEClientTransport(new URL(config.url), {
      // `SSEClientTransport` merges `requestInit.headers` via `_commonHeaders()`
      // on BOTH the initial GET EventSource stream and every POST `/messages`
      // request, ensuring `Authorization` and custom headers are always sent.
      requestInit: {
        headers: { ...config.headers },
      },
    }),
    createToolDefinition: (pluginCtx, options) => createMcpToolDefinition(pluginCtx, options),
  });
}
