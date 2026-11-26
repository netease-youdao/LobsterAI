import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpOAuthManager } from '../mcpOAuthManager';
import { MailCode } from './protocol';
import { MailRefreshError } from './refresh';

/** Each protected operation owns one transport, bound to its original grant. */
export async function connectMailClient(grant: { endpoint: string; manager: McpOAuthManager; serverId: string },
  assertGrant: () => void, fetchMail: typeof fetch) {
  const client = new Client({ name: 'lobsterai-mail-confirmation', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(grant.endpoint), {
    fetch: async (input, init) => {
      assertGrant();
      const resolved = await grant.manager.resolveAuthorizationHeaders(grant.serverId).catch(error => {
        const message = error instanceof Error ? error.message : '';
        if (message.includes(MailRefreshError.RateLimited)) throw new Error(String(MailCode.Limited));
        if (message.includes(MailRefreshError.Unauthorized)) throw new Error(String(MailCode.Unauthorized));
        throw new Error('Mail credential unavailable');
      });
      assertGrant();
      if (!resolved?.Authorization) throw new Error(String(MailCode.Unauthorized));
      const headers = new Headers(init?.headers);
      headers.set('Authorization', resolved.Authorization);
      const response = await fetchMail(input, { ...init, headers, redirect: 'error' });
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
