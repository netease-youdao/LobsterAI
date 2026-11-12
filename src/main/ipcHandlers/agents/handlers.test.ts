import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, ipcMain } from 'electron';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AgentIpcChannel } from '../../../shared/agent/constants';
import { ExpertFixtureId } from '../../../shared/agent/expertCatalogFixture';
import { type AgentHandlerDeps,registerAgentHandlers } from './handlers';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

let stateDir: string;
const resolveAgentWorkspacePath = (agentId: string) => path.join(stateDir, `workspace-${agentId}`);
const readPersonaFile = (agentId: string, filename: string) =>
  fs.readFileSync(path.join(resolveAgentWorkspacePath(agentId), filename), 'utf8');
const writePersonaFile = (agentId: string, filename: string, content: string) => {
  fs.mkdirSync(resolveAgentWorkspacePath(agentId), { recursive: true });
  fs.writeFileSync(path.join(resolveAgentWorkspacePath(agentId), filename), content, 'utf8');
};

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agent-handlers-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function setup(
  syncOpenClawConfig: AgentHandlerDeps['syncOpenClawConfig'],
  agent: unknown = { id: ExpertFixtureId.Data },
  existingAgents: unknown[] = [],
) {
  const addPresetAgent = vi.fn().mockResolvedValue(agent);
  const sender = { id: 1, send: vi.fn() };
  const otherWindowSend = vi.fn();
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isDestroyed: () => false, webContents: sender },
    { isDestroyed: () => false, webContents: { id: 2, send: otherWindowSend } },
  ] as unknown as BrowserWindow[]);
  registerAgentHandlers({
    getAgentManager: () => ({ addPresetAgent, listAgents: () => existingAgents }),
    resolveAgentWorkspacePath,
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
  expect(errorLog).toHaveBeenCalledWith('[Agents] Failed to prepare preset agent:',
    expect.objectContaining({ presetId: ExpertFixtureId.Data, durationMs: expect.any(Number) }),
    expect.objectContaining({ message: 'Gateway unavailable' }));
  expect(otherWindowSend).not.toHaveBeenCalled();
  expect(await invoke()).toMatchObject({ success: true });
  expect(otherWindowSend).toHaveBeenCalledExactlyOnceWith(AgentIpcChannel.Changed);
  errorLog.mockRestore();
});

test('unknown presets do not trigger synchronization or claim success', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sync = vi.fn();
  const { invoke, otherWindowSend } = setup(sync, null);
  expect(await invoke()).toMatchObject({ success: false });
  expect(sync).not.toHaveBeenCalled();
  expect(otherWindowSend).not.toHaveBeenCalled();
  expect(errorLog).toHaveBeenCalledWith('[Agents] Failed to prepare preset agent:',
    expect.objectContaining({ presetId: ExpertFixtureId.Data }),
    expect.objectContaining({ message: `Preset agent not found: ${ExpertFixtureId.Data}` }));
});

test('preparation exceptions keep their original error and stack in local logs without analytics', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sync = vi.fn();
  const { invoke, addPresetAgent, otherWindowSend } = setup(sync);
  const error = Object.assign(new Error('SQLITE_ERROR: no such column: icon_customized'), { code: 'SQLITE_ERROR' });
  addPresetAgent.mockRejectedValueOnce(error);

  expect(await invoke()).toEqual({ success: false, error: error.message });
  expect(errorLog).toHaveBeenCalledExactlyOnceWith('[Agents] Failed to prepare preset agent:',
    expect.objectContaining({ presetId: ExpertFixtureId.Data, durationMs: expect.any(Number) }), error);
  expect(sync).not.toHaveBeenCalled();
  expect(otherWindowSend).not.toHaveBeenCalled();
});

test('installing a preset writes its persona over files left by a deleted agent with the same ID', async () => {
  writePersonaFile(ExpertFixtureId.Data, 'SOUL.md', 'deleted agent soul\n');
  const sync = vi.fn().mockResolvedValue({ success: true, changed: true });
  const { invoke } = setup(sync, { id: ExpertFixtureId.Data, systemPrompt: 'Preset soul', identity: 'Preset identity' });

  expect(await invoke()).toMatchObject({ success: true });
  expect(readPersonaFile(ExpertFixtureId.Data, 'SOUL.md')).toBe('Preset soul\n');
  expect(readPersonaFile(ExpertFixtureId.Data, 'IDENTITY.md')).toBe('Preset identity\n');
});

test('summoning an existing preset keeps the persona its workspace already has', async () => {
  writePersonaFile(ExpertFixtureId.Data, 'SOUL.md', 'soul edited by the agent\n');
  const existing = {
    id: ExpertFixtureId.Data,
    source: 'preset',
    presetId: ExpertFixtureId.Data,
    enabled: true,
    systemPrompt: 'Preset soul',
    identity: '',
  };
  const sync = vi.fn().mockResolvedValue({ success: true, changed: true });
  const { invoke } = setup(sync, existing, [existing]);

  expect(await invoke()).toMatchObject({ success: true });
  expect(readPersonaFile(ExpertFixtureId.Data, 'SOUL.md')).toBe('soul edited by the agent\n');
});

test('creating an agent writes its persona over files left by a deleted agent with the same ID', async () => {
  writePersonaFile('writer', 'SOUL.md', 'deleted agent soul\n');
  const sync = vi.fn().mockResolvedValue({ success: true, changed: true });
  const createAgent = vi.fn(() => ({ id: 'writer', systemPrompt: 'Writer soul', identity: '' }));
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
  registerAgentHandlers({
    getAgentManager: () => ({ createAgent }),
    resolveAgentWorkspacePath,
    resolveDefaultAgentModelRef: () => 'provider/model',
    syncOpenClawConfig: sync,
  } as unknown as AgentHandlerDeps);
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === AgentIpcChannel.Create)![1];

  const result = await handler({ sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent, { name: 'Writer' });

  expect(result).toMatchObject({ success: true });
  expect(readPersonaFile('writer', 'SOUL.md')).toBe('Writer soul\n');
  expect(readPersonaFile('writer', 'IDENTITY.md')).toBe('');
  expect(sync).toHaveBeenCalledExactlyOnceWith({ reason: 'agent-created' });
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

test('working directory change hot-reloads OpenClaw config without restarting the gateway', async () => {
  const sync = vi.fn().mockResolvedValue({ success: true, changed: true });
  const refreshImSessionWorkingDirectoriesForAgent = vi.fn().mockReturnValue(0);
  const updateAgent = vi.fn((id: string, updates: { workingDirectory?: string }) => ({ id, ...updates }));
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
  registerAgentHandlers({
    getAgentManager: () => ({ getAgent: () => ({ id: 'main', workingDirectory: '/repo/old' }), updateAgent }),
    refreshImSessionWorkingDirectoriesForAgent,
    syncOpenClawConfig: sync,
  } as unknown as AgentHandlerDeps);
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === AgentIpcChannel.Update)![1];
  const result = await handler({ sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent, 'main', { workingDirectory: '/repo/new' });
  expect(result).toMatchObject({ success: true });
  expect(refreshImSessionWorkingDirectoriesForAgent).toHaveBeenCalledExactlyOnceWith('main');
  expect(sync).toHaveBeenCalledExactlyOnceWith({ reason: 'agent-working-directory-updated' });
});
