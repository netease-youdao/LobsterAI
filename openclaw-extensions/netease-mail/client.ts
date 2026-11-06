import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ensureAuthProfileStore, resolveApiKeyForProfile } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/provider-auth';

import { readMailAuthorization } from './authorization';
import { MAIL_PROFILE_ID, MailCode } from './protocol';
import { MailRefreshError } from './refresh';

export interface MailClientOptions {
  stateDir: string; clientId: string; endpoint: string; grantId: string;
  requiredScope: string; config: () => OpenClawConfig;
}

/** A write operation owns one MCP connection, using OpenClaw's refresh lease. */
export async function connectMailClient(options: MailClientOptions) {
  const assertGrant = () => {
    const grant = readMailAuthorization(options.stateDir, options.clientId);
    if (grant?.id !== options.grantId) throw new Error(String(MailCode.Unauthorized));
    if (!grant.scopes.includes(options.requiredScope)) throw new Error(String(MailCode.Scope));
    // Disabling/deleting the managed connector must also disable plugin writes.
    const servers = options.config().mcp?.servers ?? {};
    if (!Object.values(servers).some(server => server.url === options.endpoint && server.enabled !== false && server.oauth?.authProfileId === MAIL_PROFILE_ID)) {
      throw new Error(String(MailCode.Unauthorized));
    }
  };
  const client = new Client({ name: 'lobsterai-mail-confirmation', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(options.endpoint), {
    fetch: async (input, init) => {
      assertGrant();
      const store = ensureAuthProfileStore(undefined, { readOnly: true, syncExternalCli: false, externalCliProviderIds: [] });
      const resolved = await resolveApiKeyForProfile({ cfg: options.config(), store, profileId: MAIL_PROFILE_ID, allowProfileFallback: false }).catch(error => {
        const message = error instanceof Error ? error.message : '';
        if (message.includes(MailRefreshError.RateLimited)) throw new Error(String(MailCode.Limited));
        if (message.includes(MailRefreshError.Unauthorized)) throw new Error(String(MailCode.Unauthorized));
        throw new Error('Mail credential unavailable');
      });
      assertGrant();
      if (!resolved?.apiKey) throw new Error(String(MailCode.Unauthorized));
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${resolved.apiKey}`);
      const response = await fetch(input, { ...init, headers, redirect: 'error' });
      if (response.status === 429) throw new Error(String(MailCode.Limited));
      if (response.status === 401) throw new Error(String(MailCode.Unauthorized));
      if (response.status === 403) throw new Error(String(MailCode.Scope));
      return response;
    },
  });
  try { await client.connect(transport, { timeout: 30_000 }); }
  catch (error) { await client.close().catch(() => {}); throw error; }
  return {
    call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      assertGrant();
      return client.callTool({ name, arguments: args }, undefined, { timeout: 30_000, signal });
    },
    close: () => client.close().catch(() => {}),
  };
}
