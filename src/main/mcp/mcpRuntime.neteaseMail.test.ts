import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { NeteaseMail, NeteaseMailReadTools, NeteaseMailScope, NeteaseMailTool } from '../../shared/neteaseMail/constants';
import { McpRuntime } from './mcpRuntime';

const clientId = 'mail-upgrade-client';
let userData: string;

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getName: () => 'LobsterAI', getPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('./mcpStore', () => ({
  McpStore: class {
    getEnabledServers() {
      return [{ id: 'mail', registryId: NeteaseMail.RegistryId, transportType: 'http',
        toolFilter: { include: [...NeteaseMailReadTools, NeteaseMailTool.GetProfile, NeteaseMailTool.CreateDraft, NeteaseMailTool.UpdateDraft] } }];
    }
  },
}));

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-mcp-runtime-mail-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function resolveMail(scope?: string, resource: string = NeteaseMail.Endpoint) {
  vi.stubEnv('LOBSTER_NETEASE_MAIL_CLIENT_ID', clientId);
  const runtime = new McpRuntime({
    getMailToken: () => ({ serverId: 'mail', clientId, resource, mailAuthorizationId: 'grant',
      accessToken: 'test', tokenType: 'Bearer', updatedAt: 1, scope }),
    getStore: () => ({ get: () => undefined, getDatabase: () => ({}) }) as never,
    syncOpenClawConfig: async () => ({ success: true, changed: false }),
  });
  return (await runtime.refreshResolvedServersCache()).find(server => server.name === NeteaseMail.RegistryId);
}

test('upgrades a stored ten-tool connector from its grant without another OAuth login', async () => {
  const server = await resolveMail(Object.values(NeteaseMailScope).join(' '));
  expect(server).toMatchObject({ id: 'mail', auth: 'oauth', url: NeteaseMail.Endpoint });
  expect(server?.toolFilter?.include).toHaveLength(12);
  expect(server?.toolFilter?.include).toEqual(expect.arrayContaining([
    NeteaseMailTool.UpdateMessageReadState, NeteaseMailTool.UpdateMessageFlagState,
  ]));
  for (const tool of [NeteaseMailTool.SendMessage, NeteaseMailTool.ReplyMessage, NeteaseMailTool.ForwardMessage, NeteaseMailTool.TrashMessage]) {
    expect(server?.toolFilter?.include).not.toContain(tool);
  }
});

test.each([undefined, NeteaseMailScope.Read])('legacy or narrowed scope %s never inherits persisted compose tools', async scope => {
  expect((await resolveMail(scope))?.toolFilter?.include).toEqual(NeteaseMailReadTools);
});

test('an empty grant cannot produce an unrestricted remote tool list', async () => {
  expect(await resolveMail('')).toBeUndefined();
});

test('a grant from another endpoint cannot register native tools with DSH', async () => {
  expect(await resolveMail(NeteaseMailScope.Read, 'https://staging.example.com/mail/mcp')).toBeUndefined();
});
