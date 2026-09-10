import { ipcMain } from 'electron';
import { expect, test, vi } from 'vitest';

import { AgentAccessErrorCode, AgentIpcChannel } from '../../../shared/agent/constants';
import { AgentAccessError } from '../../agentOwnership';
import { type AgentHandlerDeps, registerAgentHandlers } from './handlers';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

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
