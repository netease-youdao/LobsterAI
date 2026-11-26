import { expect, test, vi } from 'vitest';

import { NeteaseMail, NeteaseMailError, NeteaseMailScope, NeteaseMailTool } from '../../../shared/neteaseMail/constants';
import type { McpOAuthManager } from '../mcpOAuthManager';
import type { McpServerRecord } from '../mcpStore';
import { getNeteaseMailOAuthConfig } from '../neteaseMailConfig';
import { NeteaseMailHost } from './host';

function fixture() {
  const token = { clientId: NeteaseMail.ClientId, mailAuthorizationId: 'grant', scope: Object.values(NeteaseMailScope).join(' ') };
  const server = { enabled: true, id: 'managed' } as McpServerRecord;
  const session = { claudeSessionId: 'dsh:session-root', imPlatform: null as string | null, scheduledTaskId: null as string | null };
  const fetch = vi.fn();
  const resolveAuthorizationHeaders = vi.fn().mockResolvedValue(null);
  const host = new NeteaseMailHost({ config: getNeteaseMailOAuthConfig(false), getServer: () => server,
    getManager: () => ({ getToken: () => token, resolveAuthorizationHeaders }) as unknown as McpOAuthManager, getSession: () => session,
    getTurnSignal: () => new AbortController().signal, publish: vi.fn(), fetch });
  return { host, server, token, session, fetch, resolveAuthorizationHeaders };
}

test('only granted protected operations appear after a host tool sync', () => {
  const { host, server, token } = fixture();
  expect(host.listDescriptors().map(tool => tool.name)).toEqual([
    NeteaseMailTool.SendMessage, NeteaseMailTool.ReplyMessage, NeteaseMailTool.ForwardMessage, NeteaseMailTool.TrashMessage,
  ]);
  token.scope = NeteaseMailScope.Delete;
  expect(host.listDescriptors().map(tool => tool.name)).toEqual([NeteaseMailTool.TrashMessage]);
  token.scope = NeteaseMailScope.Read;
  expect(host.listDescriptors()).toEqual([]);
  server.enabled = false;
  token.scope = NeteaseMailScope.Send;
  expect(host.listDescriptors()).toEqual([]);
});

test.each(['im', 'scheduled', 'subagent', 'unbound'])('%s cannot start a protected external write', async origin => {
  const { host, session, fetch } = fixture();
  if (origin === 'im') session.imPlatform = 'weixin';
  if (origin === 'scheduled') session.scheduledTaskId = 'task';
  const result = await host.execute(NeteaseMailTool.SendMessage, {}, {
    coworkSessionId: origin === 'unbound' ? undefined : 'desktop', callId: 'call', agentId: 'main',
    sessionId: origin === 'subagent' ? 'child' : 'session-root',
  });
  expect(result.details.code).toBe(NeteaseMailError.InsufficientScope);
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['dsh:session-root', 'session-root'])('resumed desktop session %s checks the managed credential', async storedId => {
  const { host, session, resolveAuthorizationHeaders, fetch } = fixture();
  session.claudeSessionId = storedId;
  await host.execute(NeteaseMailTool.SendMessage, {}, {
    coworkSessionId: 'desktop', callId: 'call', agentId: 'main', sessionId: 'session-root',
  });
  expect(resolveAuthorizationHeaders).toHaveBeenCalledWith('managed');
  expect(fetch).not.toHaveBeenCalled();
});
