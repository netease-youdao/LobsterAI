import { NeteaseMail, NeteaseMailAuth } from '../../shared/neteaseMail/constants';
import type { McpOAuthTokenRecord } from './mcpOAuthManager';

export interface NeteaseMailOAuthConfig {
  clientId: string;
  mcpUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

/** A single OAuth client can be registered for more than one protected resource. */
export function matchesNeteaseMailRegistration(
  token: McpOAuthTokenRecord | null | undefined,
  config: NeteaseMailOAuthConfig,
): token is McpOAuthTokenRecord & { mailAuthorizationId: string } {
  return Boolean(token?.mailAuthorizationId && token.clientId === config.clientId && token.resource === config.mcpUrl);
}

/** Desktop builds share the registered defaults; local development may override them. */
export function getNeteaseMailOAuthConfig(isPackaged: boolean, env = process.env): NeteaseMailOAuthConfig | undefined {
  const clientId = (!isPackaged && env.LOBSTER_NETEASE_MAIL_CLIENT_ID?.trim()) || NeteaseMail.ClientId;
  if (!clientId) return undefined;
  const mcpUrl = (!isPackaged && env.LOBSTER_NETEASE_MAIL_MCP_URL?.trim()) || NeteaseMail.Endpoint;
  try {
    const url = new URL(mcpUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  } catch { return undefined; }
  return {
    clientId,
    mcpUrl,
    authorizeUrl: NeteaseMailAuth.AuthorizeUrl,
    tokenUrl: NeteaseMailAuth.TokenUrl,
    redirectUri: NeteaseMailAuth.RedirectUri,
  };
}
