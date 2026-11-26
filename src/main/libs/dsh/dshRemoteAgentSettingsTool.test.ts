import { afterEach, expect, test, vi } from 'vitest';

import { AgentSettingsPrivateTool } from '../../../shared/cowork/agentSettingsPrivacy';
import { RemoteRunStatus } from '../../../shared/remote/constants';
import type { CoworkStore } from '../../coworkStore';
import type { RemoteAgentSettingsProtocol } from '../../remote/remoteAgentSettingsProtocol';
import { attachDshRemoteAgentSettingsReader, createDshRemoteAgentSettingsProvider } from './dshRemoteAgentSettingsTool';
import { DSH_REMOTE_BINDING_VERSION } from './dshRemoteTurnEvidence';

let close = () => {};
afterEach(() => { close(); });

function fixture() {
  const ctx = { agentId: 'agent', coworkSessionId: 'local', sessionId: 'native', remoteRequestId: 'request', callId: 'call' };
  const args = { action: 'read', section: 'identity' };
  const owner = { userId: 'owner', scopeKey: 'personal' };
  const row = { id: 'local', agentId: 'agent', claudeSessionId: 'dsh:native', parentSessionId: null as string | null };
  const mapping = { sessionKey: 'native', runId: 'request', remoteRunId: 'run', gatewayBootId: DSH_REMOTE_BINDING_VERSION };
  const read = vi.fn(async () => ({ revision: 'revision', value: { text: 'identity' } }));
  const activeTurn = vi.fn();
  const remote = { get: (key: string) => key === 'runCommand:local' ? 'command' : mapping,
    run: () => ({ runId: 'run', status: RemoteRunStatus.Running }), owner: () => owner, assertNoDeletionEffect: vi.fn(),
    assertActor: vi.fn(), isTaskAdmitted: () => true };
  const store = { getSession: () => row, assertAgentAccess: vi.fn(), remote } as unknown as CoworkStore;
  const protocol = { readConversationSection: read } as unknown as RemoteAgentSettingsProtocol;
  close = attachDshRemoteAgentSettingsReader({ store, owner: () => owner, protocol: () => protocol, routeEpoch: () => 1, assertActiveTurn: activeTurn });
  const provider = createDshRemoteAgentSettingsProvider();
  const invoke = () => provider.execute(AgentSettingsPrivateTool, args, ctx);
  return { provider, ctx, read, row, mapping, invoke, args, remote, activeTurn };
}

test('reads only for the exact root native call and phone command that dispatched the turn', async () => {
  const f = fixture();
  expect(await f.invoke()).toMatchObject({ section: 'identity', value: { text: 'identity' } });
  expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'command', runId: 'run', agentId: 'agent', callId: 'call' }), 'identity', expect.any(Function));
  expect(f.activeTurn).toHaveBeenCalledWith('local', 'request', 'agent');
  f.row.claudeSessionId = 'native';
  await expect(f.invoke()).resolves.toMatchObject({ value: { text: 'identity' } });
  f.mapping.gatewayBootId = 'legacy-openclaw-boot';
  await expect(f.invoke()).rejects.toThrow('CONVERSATION_SOURCE_INVALID');
  f.mapping.gatewayBootId = DSH_REMOTE_BINDING_VERSION;
  f.ctx.sessionId = 'child';
  await expect(f.invoke()).rejects.toThrow('CONVERSATION_SOURCE_INVALID');
  f.ctx.sessionId = 'native';
  f.row.parentSessionId = 'parent';
  await expect(f.invoke()).rejects.toThrow('CONVERSATION_SOURCE_INVALID');
  expect(f.read).toHaveBeenCalledTimes(2);
});

test('model supplied target, writes, ad hoc desktop calls and newly inaccessible sessions cannot release settings', async () => {
  const f = fixture();
  await expect(f.provider.execute(AgentSettingsPrivateTool, { ...f.args, agentId: 'other' }, f.ctx)).rejects.toThrow('SETTINGS_INVALID_REQUEST');
  await expect(f.provider.execute(AgentSettingsPrivateTool, { ...f.args, action: 'update' }, f.ctx)).rejects.toThrow('SETTINGS_INVALID_REQUEST');
  await expect(f.provider.execute(AgentSettingsPrivateTool, f.args, { ...f.ctx, remoteRequestId: undefined })).rejects.toThrow('CONVERSATION_SOURCE_INVALID');
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockImplementationOnce(async () => {
    f.remote.isTaskAdmitted = () => false;
    return { revision: 'revision', value: { text: 'private' } };
  });
  await expect(f.invoke()).rejects.toThrow('CONVERSATION_SOURCE_INVALID');
});
