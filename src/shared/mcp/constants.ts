export const McpIpcChannel = {
  List: 'mcp:list',
  Create: 'mcp:create',
  Update: 'mcp:update',
  Delete: 'mcp:delete',
  DeleteByRegistryId: 'mcp:deleteByRegistryId',
  SetEnabled: 'mcp:setEnabled',
  SetEnabledByRegistryId: 'mcp:setEnabledByRegistryId',
  RetryLaunchResolution: 'mcp:retryLaunchResolution',
  ListTools: 'mcp:listTools',
  FetchMarketplace: 'mcp:fetchMarketplace',
  ConnectQichacha: 'mcp:qichachaConnect',
  OAuthLogin: 'mcp:oauthLogin',
  OAuthCancel: 'mcp:oauthCancel',
  OAuthLogout: 'mcp:oauthLogout',
  OAuthStatus: 'mcp:oauthStatus',
  Changed: 'mcp:changed',
} as const;
export type McpIpcChannel = typeof McpIpcChannel[keyof typeof McpIpcChannel];

/** Node.js env names that matter when launching stdio MCP servers. */
export const McpNodeEnv = {
  // Dropped by OpenClaw's stdio env policy; the server form warns about it.
  Options: 'NODE_OPTIONS',
  // Same effect as --use-system-ca (Node.js 22.19+), and allowed through.
  UseSystemCa: 'NODE_USE_SYSTEM_CA',
} as const;
export type McpNodeEnv = typeof McpNodeEnv[keyof typeof McpNodeEnv];
