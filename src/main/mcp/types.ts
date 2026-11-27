// Engine-independent MCP server descriptor resolved by McpRuntime and
// built-in MCP servers (Office, Computer Use, Web Search, etc.).

import type { McpToolFilter } from '../../shared/mcp/toolFilter';

export interface ResolvedMcpServer {
  id?: string;
  name: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  gatewayEnvRefs?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolFilter?: McpToolFilter;
  supportsParallelToolCalls?: boolean;
  auth?: 'oauth';
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
}
