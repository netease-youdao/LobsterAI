/**
 * Contract for listing an MCP server's tools from the settings UI.
 *
 * The main process connects to the server the way OpenClaw would and returns
 * the raw `tools/list` names, which are what `mcp.servers.*.toolFilter`
 * entries match.
 */

export interface McpToolDiscoveryRequest {
  /** Saved server id when editing, so a managed npx install can be reused. */
  serverId?: string;
  name: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpDiscoveredTool {
  /** Raw MCP tool name, the value toolFilter entries match. */
  name: string;
  /** Display title, when the server provides one. */
  title?: string;
  description?: string;
  /** Rough prompt cost of this tool's definition, in tokens. */
  estimatedTokens: number;
}

export const McpToolDiscoveryErrorCode = {
  InvalidRequest: 'invalid_request',
  Timeout: 'timeout',
  Failed: 'failed',
} as const;
export type McpToolDiscoveryErrorCode =
  typeof McpToolDiscoveryErrorCode[keyof typeof McpToolDiscoveryErrorCode];

export type McpToolDiscoveryResult =
  | { success: true; tools: McpDiscoveredTool[]; durationMs: number }
  | { success: false; code: McpToolDiscoveryErrorCode; error: string; timeoutMs?: number };
