import { randomUUID } from 'node:crypto';

import { NeteaseMailAuth, NeteaseMailFailure, type NeteaseMailScope } from '../../shared/neteaseMail/constants';
import { getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';
import type { McpOAuthManager, McpOAuthTokenRecord } from './mcpOAuthManager';
import type { McpServerRecord } from './mcpStore';
import { matchesNeteaseMailRegistration, type NeteaseMailOAuthConfig } from './neteaseMailConfig';
import { type NeteaseMailCredential, NeteaseMailOAuthError } from './neteaseMailOAuth';

export interface NeteaseMailAuthStore {
  status(): Promise<{ connected: boolean; expiresAt?: number; scopes?: NeteaseMailScope[] }>;
  save(credential: NeteaseMailCredential): Promise<void>;
  remove(): Promise<void>;
}

export function mailTokenRecord(serverId: string, credential: NeteaseMailCredential, resource: string): McpOAuthTokenRecord {
  return {
    serverId, resource, accessToken: credential.access, refreshToken: credential.refresh,
    expiresAtMs: credential.expires, tokenType: 'Bearer', clientId: credential.clientId,
    scope: getNeteaseMailScopes(credential.scope).join(' '), tokenEndpoint: NeteaseMailAuth.TokenUrl,
    mailAuthorizationId: credential.authorizationId ?? randomUUID(), updatedAt: Date.now(),
  };
}

export function createNeteaseMailAuthStore(manager: McpOAuthManager, config: NeteaseMailOAuthConfig,
  getServer: () => McpServerRecord | undefined, invalidate: () => void): NeteaseMailAuthStore {
  return {
    async status() {
      const server = getServer();
      let token = server?.enabled ? manager.getToken(server.id) : null;
      if (!server || !matchesNeteaseMailRegistration(token, config)) return { connected: false };
      if (token.expiresAtMs !== undefined && token.expiresAtMs <= Date.now()) {
        const status = await manager.checkAuthorizationStatus(server.id);
        const current = manager.getToken(server.id);
        if (!status.authorized || !matchesNeteaseMailRegistration(current, config) || current.mailAuthorizationId !== token.mailAuthorizationId) return { connected: false };
        token = current;
      }
      return { connected: true, expiresAt: token.expiresAtMs, scopes: getNeteaseMailScopes(token.scope) };
    },
    async save(credential) {
      const server = getServer();
      if (!server || credential.clientId !== config.clientId) throw new NeteaseMailOAuthError(NeteaseMailFailure.StorageFailed);
      invalidate();
      manager.saveToken(mailTokenRecord(server.id, credential, config.mcpUrl));
    },
    async remove() {
      invalidate();
      const server = getServer();
      if (server) manager.deleteToken(server.id);
    },
  };
}
