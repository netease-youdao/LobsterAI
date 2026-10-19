import { BrowserWindow, ipcMain } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

import { AgentAccessErrorCode, AgentIpcChannel } from '../../../shared/agent/constants';
import { ExpertFixtureId } from '../../../shared/agent/expertCatalogFixture';
import { AgentAccessError } from '../../agentOwnership';
import { type AgentHandlerDeps, registerAgentHandlers } from './handlers';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

function setup(syncOpenClawConfig: AgentHandlerDeps['syncOpenClawConfig'], agent: unknown = { id: ExpertFixtureId.Data }) {
  const addPresetAgent = vi.fn().mockResolvedValue(agent);
  const assertCurrentOwner = vi.fn();
  const assertAgentAccess = vi.fn();
  const sender = { id: 1, send: vi.fn() };
  const otherWindowSend = vi.fn();
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isDestroyed: () => false, webContents: sender },
    { isDestroyed: () => false, webContents: { id: 2, send: otherWindowSend } },
  ] as unknown as BrowserWindow[]);
  registerAgentHandlers({
    getAgentManager: () => ({ addPresetAgent, listAgents: () => [], captureOwner: () => null, assertCurrentOwner, assertAgentAccess }),
    resolveDefaultAgentModelRef: () => 'provider/model',
    syncOpenClawConfig,
  } as unknown as AgentHandlerDeps);
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === AgentIpcChannel.AddPreset)![1];
  return {
    invoke: () => handler({ sender } as unknown as Electron.IpcMainInvokeEvent, ExpertFixtureId.Data),
    addPresetAgent,
    assertCurrentOwner,
    assertAgentAccess,
    otherWindowSend,
    senderSend: sender.send,
  };
}

test('summon waits for OpenClaw synchronization before reporting success and notifying other windows', async () => {
  let resolveSync!: (result: { success: boolean; changed: boolean }) => void;
  const sync = vi.fn(() => new Promise<{ success: boolean; changed: boolean }>(resolve => { resolveSync = resolve; }));
  const { invoke, otherWindowSend, senderSend } = setup(sync);
  let settled = false;
  const result = invoke().then(value => { settled = true; return value; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(otherWindowSend).not.toHaveBeenCalled();
  resolveSync({ success: true, changed: true });
  expect(await result).toEqual({ success: true, agent: { id: ExpertFixtureId.Data } });
  expect(otherWindowSend).toHaveBeenCalledExactlyOnceWith(AgentIpcChannel.Changed);
  expect(senderSend).not.toHaveBeenCalled();
});

test('sync failure is reported and a retry can finish preparation', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sync = vi.fn().mockResolvedValueOnce({ success: false, changed: false, error: 'Gateway unavailable' })
    .mockResolvedValueOnce({ success: true, changed: true });
  const { invoke, otherWindowSend } = setup(sync);
  expect(await invoke()).toMatchObject({ success: false, error: 'Gateway unavailable' });
  expect(otherWindowSend).not.toHaveBeenCalled();
  expect(await invoke()).toMatchObject({ success: true });
  expect(otherWindowSend).toHaveBeenCalledExactlyOnceWith(AgentIpcChannel.Changed);
  errorLog.mockRestore();
});

test('unknown presets do not trigger synchronization or claim success', async () => {
  const sync = vi.fn();
  const { invoke, otherWindowSend } = setup(sync, null);
  expect(await invoke()).toMatchObject({ success: false });
  expect(sync).not.toHaveBeenCalled();
  expect(otherWindowSend).not.toHaveBeenCalled();
});

test('an account change during preset loading prevents synchronization and success', async () => {
  const sync = vi.fn();
  const { invoke, assertCurrentOwner, otherWindowSend } = setup(sync);
  assertCurrentOwner.mockImplementation(() => { throw new AgentAccessError(AgentAccessErrorCode.AccountChanged); });

  expect(await invoke()).toMatchObject({ success: false });
  expect(sync).not.toHaveBeenCalled();
  expect(otherWindowSend).not.toHaveBeenCalled();
});

test.each(['account', 'access'])('changed %s during config sync cannot return or broadcast a stale agent', async change => {
  let resolveSync!: (result: { success: boolean; changed: boolean }) => void;
  const sync = vi.fn(() => new Promise<{ success: boolean; changed: boolean }>(resolve => { resolveSync = resolve; }));
  const { invoke, assertCurrentOwner, assertAgentAccess, otherWindowSend } = setup(sync);
  const result = invoke();
  await Promise.resolve();
  const check = change === 'account' ? assertCurrentOwner : assertAgentAccess;
  check.mockImplementation(() => { throw new AgentAccessError(AgentAccessErrorCode.Unavailable); });
  resolveSync({ success: true, changed: true });

  expect(await result).toMatchObject({ success: false });
  expect(otherWindowSend).not.toHaveBeenCalled();
});

test.each([
  [AgentIpcChannel.Presets, 'getPresetAgents'],
  [AgentIpcChannel.PresetTemplates, 'getAllPresetAgents'],
  [AgentIpcChannel.ExpertCatalog, 'getExpertCatalog'],
])('%s reports asynchronous catalog failures through IPC', async (channel, method) => {
  registerAgentHandlers({
    getAgentManager: () => ({ [method]: vi.fn().mockRejectedValue(new Error('Catalog unavailable')) }),
  } as unknown as AgentHandlerDeps);
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1];
  expect(await handler({} as Electron.IpcMainInvokeEvent)).toEqual({ success: false, error: 'Catalog unavailable' });
});

test('rejected Agent deletion never stops sessions, clears bindings or syncs configuration', async () => {
  const stopSession = vi.fn();
  const getIMGatewayManager = vi.fn();
  const syncOpenClawConfig = vi.fn();
  registerAgentHandlers({
    getAgentManager: () => ({ getAgent: () => ({ id: 'agent' }), deleteAgent: () => {
      throw new AgentAccessError(AgentAccessErrorCode.Busy);
    } }),
    getCoworkStore: () => ({ listSessionIdsByAgent: () => ['running-task'] }),
    getCoworkEngineRouter: () => ({ stopSession, isSessionActive: () => false }),
    getIMGatewayManager,
    syncOpenClawConfig,
  } as unknown as AgentHandlerDeps);
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === AgentIpcChannel.Delete)![1];
  await expect(handler({} as Electron.IpcMainInvokeEvent, 'agent')).resolves.toMatchObject({ success: false });
  expect(stopSession).not.toHaveBeenCalled();
  expect(getIMGatewayManager).not.toHaveBeenCalled();
  expect(syncOpenClawConfig).not.toHaveBeenCalled();
});


test('active runtime evidence rejects deletion even when the persisted session is idle', async () => {
  vi.mocked(ipcMain.handle).mockClear();
  const deleteAgent = vi.fn();
  const stopSession = vi.fn();
  registerAgentHandlers({
    getAgentManager: () => ({ getAgent: () => ({ id: 'agent' }), deleteAgent }),
    getCoworkStore: () => ({ listSessionIdsByAgent: () => ['active-task'] }),
    getCoworkEngineRouter: () => ({ stopSession, isSessionActive: () => true }),
  } as unknown as AgentHandlerDeps);
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === AgentIpcChannel.Delete)![1];
  await expect(handler({} as Electron.IpcMainInvokeEvent, 'agent')).resolves.toMatchObject({ success: false });
  expect(deleteAgent).not.toHaveBeenCalled();
  expect(stopSession).not.toHaveBeenCalled();
});
