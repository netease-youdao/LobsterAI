import { beforeEach, expect, test, vi } from 'vitest';

import { NeteaseMail, NeteaseMailAuth, NeteaseMailFailure, NeteaseMailOutcome, NeteaseMailReadTools } from '../../shared/neteaseMail/constants';
import type { McpServerFormData, McpStore } from './mcpStore';
import { getNeteaseMailOAuthConfig } from './neteaseMailConfig';
import { NeteaseMailConnection } from './neteaseMailConnection';

const authorize = vi.hoisted(() => vi.fn());
vi.mock('./neteaseMailOAuth', async importOriginal => ({ ...await importOriginal<typeof import('./neteaseMailOAuth')>(), authorizeNeteaseMail: authorize }));
const credential = { type: NeteaseMailAuth.CredentialType, provider: NeteaseMailAuth.Provider, clientId: 'test', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 };
beforeEach(() => { authorize.mockReset().mockResolvedValue(credential); });
function fixture(syncSuccess = true) {
  const records: Array<McpServerFormData & { id: string; enabled: boolean }> = [];
  const store = {
    listServers: () => records,
    createServer: vi.fn((data: McpServerFormData) => { const server = { ...data, id: 'server', enabled: true }; records.push(server); return server; }),
    updateServer: vi.fn((id: string, data: McpServerFormData) => Object.assign(records.find(server => server.id === id)!, data)),
    setEnabled: vi.fn((id: string, enabled: boolean) => { records.find(server => server.id === id)!.enabled = enabled; }),
  };
  let saved = false;
  const authStore = {
    initialize: vi.fn(async () => {}),
    status: vi.fn(async () => ({ connected: saved })),
    save: vi.fn(async () => { saved = true; }), remove: vi.fn(async () => { saved = false; }),
  };
  const sync = vi.fn(async () => ({ success: syncSuccess }));
  const broadcast = vi.fn();
  const connection = new NeteaseMailConnection({ config: getNeteaseMailOAuthConfig(false, { LOBSTER_NETEASE_MAIL_CLIENT_ID: credential.clientId }), getAuthStore: () => authStore,
    getMcpStore: () => store as unknown as McpStore, fetch, openExternal: async () => {}, callbackText: () => 'Return', sync, broadcast });
  return { connection, records, authStore, store, sync, broadcast };
}

test('stores credentials once, registers only read tools and never exposes tokens in availability', async () => {
  const { connection, records, authStore } = fixture();
  expect(await Promise.all([connection.authorize(), connection.authorize()])).toEqual([
    { success: true, outcome: NeteaseMailOutcome.Connected }, { success: true, outcome: NeteaseMailOutcome.Connected },
  ]);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(authStore.save).toHaveBeenCalledExactlyOnceWith(credential);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ registryId: NeteaseMail.RegistryId, toolFilter: { include: NeteaseMailReadTools } });
  expect(JSON.stringify(records)).not.toContain(credential.access);
  expect(await connection.getAvailability()).toEqual({ connected: true, authorization: true, confirmation: false });
  await connection.disconnect();
  expect(await connection.getAvailability()).toMatchObject({ connected: false });
  expect(records[0].enabled).toBe(false);
});

test('does not report connected success when runtime sync fails and reauthorization updates the same server', async () => {
  const { connection, records } = fixture(false);
  expect(await connection.authorize()).toEqual({ success: false, code: NeteaseMailFailure.SyncFailed });
  expect(await connection.getAvailability()).toMatchObject({ connected: false });
  await connection.authorize();
  expect(records).toHaveLength(1);
});

test('waits for hot credential reload before reporting or broadcasting a connected server', async () => {
  const { connection, authStore, sync, broadcast } = fixture();
  let finishReload!: (result: { success: boolean }) => void;
  sync.mockImplementation(() => new Promise(resolve => { finishReload = resolve; }));
  const login = connection.authorize();
  await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
  expect(authStore.save).toHaveBeenCalledOnce();
  expect(await connection.getAvailability()).toMatchObject({ connected: false });
  expect(broadcast).not.toHaveBeenCalled();
  finishReload({ success: true });
  expect(await login).toEqual({ success: true, outcome: NeteaseMailOutcome.Connected });
  expect(await connection.getAvailability()).toMatchObject({ connected: true });
  expect(broadcast).toHaveBeenCalledOnce();
});

test('reauthorization reloads even when the MCP server identity is unchanged', async () => {
  const { connection, authStore, records, sync } = fixture();
  await connection.authorize();
  authorize.mockResolvedValueOnce({ ...credential, access: 'replacement-access' });
  expect(await connection.authorize()).toEqual({ success: true, outcome: NeteaseMailOutcome.Connected });
  expect(authStore.save).toHaveBeenLastCalledWith(expect.objectContaining({ access: 'replacement-access' }));
  expect(records).toHaveLength(1);
  expect(sync).toHaveBeenCalledTimes(2);
});

test('reload errors report sync failure while disconnect still removes credentials and disables the server', async () => {
  const { connection, authStore, records, sync } = fixture();
  await connection.authorize();
  sync.mockRejectedValue(new Error('reload unavailable'));
  expect(await connection.disconnect()).toEqual({ success: false, code: NeteaseMailFailure.SyncFailed });
  expect(authStore.remove).toHaveBeenCalledOnce();
  expect(records[0].enabled).toBe(false);
  expect(await connection.getAvailability()).toMatchObject({ connected: false });
});

test('cancelling an in-flight authorization cannot install a connector', async () => {
  authorize.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const { connection, records, authStore } = fixture();
  const pending = connection.authorize();
  await connection.cancelAuthorization();
  expect(await pending).toEqual({ success: true, outcome: NeteaseMailOutcome.Cancelled });
  expect(records).toHaveLength(0);
  expect(authStore.save).not.toHaveBeenCalled();
});

test('disconnect waits for an accepted callback to finish saving, then removes the credentials', async () => {
  const { connection, authStore, records } = fixture();
  let finishSave!: () => void;
  const realSave = authStore.save.getMockImplementation()!;
  authStore.save.mockImplementation(async () => {
    await new Promise<void>(resolve => { finishSave = resolve; });
    await realSave();
  });
  const login = connection.authorize();
  await vi.waitFor(() => expect(authStore.save).toHaveBeenCalledTimes(1));
  const disconnect = connection.disconnect();
  expect(authStore.remove).not.toHaveBeenCalled();
  finishSave();
  await login;
  expect(await disconnect).toEqual({ success: true, outcome: NeteaseMailOutcome.Disconnected });
  expect(await connection.getAvailability()).toMatchObject({ connected: false });
  expect(records[0].enabled).toBe(false);
});
