import { describe, expect, test, vi } from 'vitest';

import { type RemoteConfigureRequest, type RemoteOwner, RemoteSettingsError, type RemoteSettingsState } from '../../shared/remote/constants';
import { configureRemoteSettings } from './configureRemoteSettings';
import { RemoteSettingsController } from './remoteSettingsController';

function fixture() {
  let generation = 1;
  let owner: RemoteOwner | null = { userId: 'A', scopeKey: 'personal' };
  let preference = false;
  let active = false;
  const state: RemoteSettingsState = { enabled: false, connected: false, name: 'Desktop', owner,
    workspaces: [], accessRequests: [] };
  const getAccountEpoch = () => `boot:${generation}`;
  const save = vi.fn((enabled: boolean) => { preference = enabled; });
  const power = vi.fn((enabled: boolean) => { active = enabled; });
  const publish = vi.fn();
  const controller = new RemoteSettingsController({
    getRemoteState: () => ({ ...state, owner }), getAccountEpoch,
    getKeepAwakePreference: () => preference, saveKeepAwakePreference: save,
    applyKeepAwake: power, isKeepAwakeActive: () => active, publish,
  });
  const configureRemote = vi.fn(async (changes: { enabled?: boolean; name?: string }) => {
    if (changes.enabled !== undefined) state.enabled = changes.enabled;
    if (changes.name !== undefined) state.name = changes.name;
  });
  const selectWorkspace = vi.fn(async () => ({ name: 'Project', path: '/project' }));
  const deps = { getAccountEpoch, getOwner: () => owner, getController: () => controller,
    configureRemote, selectWorkspace };
  return { deps, controller, save, power, publish, configureRemote, selectWorkspace,
    epoch: getAccountEpoch,
    switchAccount: (next: RemoteOwner | null) => { owner = next; generation++; } };
}

describe('remote settings account preconditions', () => {
  test.each<RemoteConfigureRequest>([
    { enabled: true }, { enabled: false }, { name: 'New name' }, { retry: true },
    { keepAwakeEnabled: true }, { keepAwakeEnabled: false }, { addWorkspace: true },
    { removeWorkspaceId: 'workspace-1' },
  ])('rejects stale requests before any settings or connection effects: %j', async changes => {
    const f = fixture();
    await expect(configureRemoteSettings({ ...changes, expectedAccountEpoch: 'old' }, f.deps))
      .rejects.toThrow(RemoteSettingsError.AccountChanged);
    for (const effect of [f.save, f.power, f.publish, f.configureRemote, f.selectWorkspace]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  test('rejects an expired epoch before the logged-out validation', async () => {
    const f = fixture();
    const expectedAccountEpoch = f.epoch();
    f.switchAccount(null);
    await expect(configureRemoteSettings({ expectedAccountEpoch, enabled: true }, f.deps))
      .rejects.toThrow(RemoteSettingsError.AccountChanged);
    expect(f.configureRemote).not.toHaveBeenCalled();
  });

  test('accepts a current epoch without forwarding it to remote device configuration', async () => {
    const f = fixture();
    const result = await configureRemoteSettings({ expectedAccountEpoch: f.epoch(), name: 'New name' }, f.deps);
    expect(result).toMatchObject({ name: 'New name', accountEpoch: f.epoch() });
    expect(f.configureRemote).toHaveBeenCalledWith({ enabled: undefined, name: 'New name', workspace: undefined,
      removeWorkspaceId: undefined, retry: undefined });
    expect(f.publish).toHaveBeenCalledOnce();
  });

  test('preserves legacy calls without an epoch and keeps power-only updates local', async () => {
    const f = fixture();
    const result = await configureRemoteSettings({ keepAwakeEnabled: true }, f.deps);
    expect(result).toMatchObject({ keepAwakeEnabled: true, keepAwakeActive: true });
    expect(f.save).toHaveBeenCalledWith(true);
    expect(f.power).toHaveBeenCalledWith(true);
    expect(f.configureRemote).not.toHaveBeenCalled();
    await configureRemoteSettings({ enabled: true }, f.deps);
    expect(f.configureRemote).toHaveBeenCalledOnce();
  });

  test('directory selection across A to B to A stops all subsequent effects', async () => {
    const f = fixture();
    let completeSelection!: (value: { name: string; path: string }) => void;
    f.selectWorkspace.mockReturnValueOnce(new Promise(resolve => { completeSelection = resolve; }));
    const pending = configureRemoteSettings({ expectedAccountEpoch: f.epoch(), keepAwakeEnabled: true,
      enabled: true, retry: true, addWorkspace: true }, f.deps);
    f.switchAccount({ userId: 'B', scopeKey: 'personal' });
    f.switchAccount({ userId: 'A', scopeKey: 'personal' });
    completeSelection({ name: 'Project', path: '/project' });
    await expect(pending).rejects.toThrow(RemoteSettingsError.AccountChanged);
    for (const effect of [f.save, f.power, f.publish, f.configureRemote]) expect(effect).not.toHaveBeenCalled();
  });

  test('a current directory selection can configure its workspace', async () => {
    const f = fixture();
    await configureRemoteSettings({ expectedAccountEpoch: f.epoch(), addWorkspace: true }, f.deps);
    expect(f.configureRemote).toHaveBeenCalledWith(expect.objectContaining({ workspace: { name: 'Project', path: '/project' } }));
  });

  test('rejects stale asynchronous bridge completion without publishing its result', async () => {
    const f = fixture();
    let completeConfigure!: () => void;
    f.configureRemote.mockReturnValueOnce(new Promise(resolve => { completeConfigure = resolve; }));
    const pending = configureRemoteSettings({ expectedAccountEpoch: f.epoch(), name: 'New name' }, f.deps);
    expect(f.configureRemote).toHaveBeenCalledOnce();
    f.switchAccount({ userId: 'A', scopeKey: 'enterprise:1' });
    completeConfigure();
    await expect(pending).rejects.toThrow(RemoteSettingsError.AccountChanged);
    expect(f.publish).not.toHaveBeenCalled();
  });

  test('an account change during bridge failure uses the fixed account-changed error', async () => {
    const f = fixture();
    f.configureRemote.mockImplementationOnce(async () => {
      f.switchAccount(null);
      throw new Error('Connection failed');
    });
    await expect(configureRemoteSettings({ expectedAccountEpoch: f.epoch(), retry: true }, f.deps))
      .rejects.toThrow(RemoteSettingsError.AccountChanged);
  });
});
