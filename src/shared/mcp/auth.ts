/**
 * Authentication for remote (SSE / Streamable HTTP) MCP servers.
 *
 * `none`  – no auth, or static request headers configured by the user.
 * `oauth` – MCP OAuth 2.1 (PKCE + dynamic client registration). OpenClaw
 *           stores and refreshes the tokens in its own state directory; the
 *           app only flips `auth: "oauth"` in openclaw.json and drives
 *           `openclaw mcp login|logout|status`.
 */
export const McpAuthMode = {
  None: 'none',
  OAuth: 'oauth',
} as const;
export type McpAuthMode = typeof McpAuthMode[keyof typeof McpAuthMode];

export function normalizeMcpAuthMode(value: unknown): McpAuthMode | undefined {
  return value === McpAuthMode.OAuth ? McpAuthMode.OAuth : undefined;
}

/** Mirrors `authStatus.state` from `openclaw mcp status --json` (plus `unknown`). */
export const McpOAuthState = {
  Authorized: 'authorized',
  RequiresAuthorization: 'requires-authorization',
  PendingAuthorization: 'pending-authorization',
  Unauthenticated: 'unauthenticated',
  Unknown: 'unknown',
} as const;
export type McpOAuthState = typeof McpOAuthState[keyof typeof McpOAuthState];

export const McpOAuthErrorCode = {
  NotOAuthServer: 'not_oauth_server',
  RuntimeUnavailable: 'runtime_unavailable',
  /** The server is disabled, so OpenClaw does not load it and the app shows no OAuth state for it. */
  ServerNotLoaded: 'server_not_loaded',
  AlreadyInProgress: 'already_in_progress',
  CallbackUnavailable: 'callback_unavailable',
  Timeout: 'timeout',
  /** The user cancelled the sign-in, or the server was removed / the app quit while it was waiting. */
  Cancelled: 'cancelled',
  Failed: 'failed',
} as const;
export type McpOAuthErrorCode = typeof McpOAuthErrorCode[keyof typeof McpOAuthErrorCode];

export type McpOAuthActionResult =
  | { success: true; state: McpOAuthState }
  | { success: false; code: McpOAuthErrorCode; error: string };

export type McpOAuthStatusResult =
  | { success: true; states: Record<string, McpOAuthState> }
  | { success: false; error: string };
