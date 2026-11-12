import { contextBridge, ipcRenderer } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

import { AgentIpcChannel } from '../shared/agent/constants';
import { ExpertFixtureId } from '../shared/agent/expertCatalogFixture';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
  webUtils: {},
}));

await import('./preload');
const agents = vi.mocked(contextBridge.exposeInMainWorld).mock.calls
  .find(([key]) => key === 'electron')![1].agents;

beforeEach(() => vi.mocked(ipcRenderer.invoke).mockReset());

test('preset preparation failures reach the renderer with the original main-process message', async () => {
  const message = 'SQLITE_ERROR: no such column: icon_customized';
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ success: false, error: message });

  await expect(agents.addPreset(ExpertFixtureId.Data)).rejects.toThrow(message);
  expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(AgentIpcChannel.AddPreset, ExpertFixtureId.Data);
});

test('preset preparation still returns the prepared agent on success', async () => {
  const agent = { id: ExpertFixtureId.Data };
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ success: true, agent });
  expect(await agents.addPreset(ExpertFixtureId.Data)).toBe(agent);
});

test('a failed preset response without details still rejects instead of returning null', async () => {
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ success: false });
  await expect(agents.addPreset(ExpertFixtureId.Data)).rejects.toThrow('Failed to add preset agent');
});
