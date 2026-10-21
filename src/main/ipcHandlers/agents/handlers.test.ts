import { BrowserWindow, ipcMain } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

import { AgentIpcChannel } from '../../../shared/agent/constants';
import { ExpertFixtureId } from '../../../shared/agent/expertCatalogFixture';
import { type AgentHandlerDeps,registerAgentHandlers } from './handlers';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

function setup(syncOpenClawConfig: AgentHandlerDeps['syncOpenClawConfig'], agent: unknown = { id: ExpertFixtureId.Data }) {
  const addPresetAgent = vi.fn().mockResolvedValue(agent);
  const sender = { id: 1, send: vi.fn() };
  const otherWindowSend = vi.fn();
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isDestroyed: () => false, webContents: sender },
    { isDestroyed: () => false, webContents: { id: 2, send: otherWindowSend } },
  ] as unknown as BrowserWindow[]);
  registerAgentHandlers({
    getAgentManager: () => ({ addPresetAgent, listAgents: () => [] }),
    resolveDefaultAgentModelRef: () => 'provider/model',
    syncOpenClawConfig,
  } as unknown as AgentHandlerDeps);
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === AgentIpcChannel.AddPreset)![1];
  return {
    invoke: () => handler({ sender } as unknown as Electron.IpcMainInvokeEvent, ExpertFixtureId.Data),
    addPresetAgent,
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
