import { describe, expect, it } from 'vitest';

import { emptyAgentSettingsPermissions } from '../../shared/remote/agentSettings';
import { type AgentSettingsPersistence } from '../libs/agentSettings/types';
import { RemoteAgentSettingsAccess, type RemoteAgentSettingsConnection, settingsPermissions } from './remoteAgentSettingsAccess';

const connection: RemoteAgentSettingsConnection = { owner: { userId: 'owner', scopeKey: 'personal' }, dataSpaceId: 'test', dataGeneration: '1',
  deviceId: 'desktop', route: 'https://service.example', connectionGeneration: 'connection-1', active: true };
function fixture() {
  const data = new Map<string, unknown>(); let failing = false;
  const store: AgentSettingsPersistence = { get: key => structuredClone(data.get(key) ?? null) as never,
    set: (key, value) => { if (failing) throw new Error('disk'); data.set(key, structuredClone(value)); } };
  const access = new RemoteAgentSettingsAccess(store); access.activate(connection);
  const permissions = emptyAgentSettingsPermissions(); permissions.memory = { read: true, directUpdate: false, conversationUpdate: true };
  const input = { expectedAccountEpoch: access.epoch(), mobileDeviceId: 'phone', agentId: 'main', grantId: 'grant', grantVersion: '1', sections: permissions };
  return { access, store, input, fail: () => { failing = true; } };
}
describe('local Agent settings authorization', () => {
  it('never infers access to main from a shared account or existing session grant', () => {
    const { access } = fixture();
    expect(() => access.resolve(connection, 'binding', '1', access.epoch(), 'main')).toThrow('SETTINGS_ACCESS_STALE');
  });
  it('rejects App text-write permissions and unavailable conversational writers', () => {
    const permissions = emptyAgentSettingsPermissions(); permissions.memory = { read: true, directUpdate: true, conversationUpdate: false };
    expect(() => settingsPermissions(permissions, true)).toThrow('DIRECT_EDIT_NOT_ALLOWED');
    permissions.memory = { read: true, directUpdate: false, conversationUpdate: true };
    expect(() => settingsPermissions(permissions, false)).toThrow('DIRECT_EDIT_NOT_ALLOWED');
  });
  it('persists a revocation fence and historical revoke intent across restart', () => {
    const { access, input, store } = fixture();
    access.confirm(access.authorize(connection, input, true), { bindingId: 'binding', bindingVersion: '1' });
    access.fence(); const restored = new RemoteAgentSettingsAccess(store); restored.activate(connection);
    expect(restored.epoch()).not.toBe(input.expectedAccountEpoch);
    expect(() => restored.resolve(connection, 'binding', '1', input.expectedAccountEpoch, 'main')).toThrow();
    expect(restored.pending(connection).map(item => item.kind)).toEqual(['revoke']);
  });
  it('a late grant response cannot revive a locally fenced authorization', () => {
    const { access, input } = fixture(); const pending = access.authorize(connection, input, true);
    access.fence();
    expect(() => access.confirm(pending, { bindingId: 'binding', bindingVersion: '1' })).toThrow('SETTINGS_ACCESS_STALE');
  });
  it('fences immediately when persistence fails', () => {
    const { access, input, fail } = fixture(); access.confirm(access.authorize(connection, input, true), { bindingId: 'binding', bindingVersion: '1' });
    fail(); expect(() => access.fence()).toThrow('disk');
    expect(() => access.resolve(connection, 'binding', '1', input.expectedAccountEpoch, 'main')).toThrow('SETTINGS_ACCESS_STALE');
  });
});
