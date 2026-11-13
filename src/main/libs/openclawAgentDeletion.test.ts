import { expect, test, vi } from 'vitest';

import { AgentId } from '../../shared/agent/constants';
import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { deleteOpenClawAgent, OpenClawAgentRpcMethod } from './openclawAgentDeletion';
import type { OpenClawConfigRpcClient } from './openclawConfigDelivery';

const expertId = 'expert-instance';

function setup(overrides: Partial<Parameters<typeof deleteOpenClawAgent>[0]> = {}) {
  let configured = true;
  const request = vi.fn(async (method: string) => {
    if (method === OpenClawAgentRpcMethod.List) {
      return { agents: [{ id: AgentId.Main }, ...(configured ? [{ id: expertId }] : [])] };
    }
    if (method === OpenClawAgentRpcMethod.Delete) {
      configured = false;
      return { ok: true, agentId: expertId };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const commitLocalDeletion = vi.fn(() => true);
  const ensureRpcClient = vi.fn(async () => ({ request }) as OpenClawConfigRpcClient);
  const input = {
    agentId: expertId,
    previousConfigSync: Promise.resolve(),
    getGatewayState: () => ({ phase: OpenClawEnginePhase.Running, processId: 42 }),
    ensureRpcClient,
    commitLocalDeletion,
    ...overrides,
  };
  return { input, request, commitLocalDeletion, ensureRpcClient };
}

test('waits for earlier config writes and explicitly deletes the runtime identity before local data', async () => {
  let finishSync!: () => void;
  const { input, request, commitLocalDeletion } = setup({
    previousConfigSync: new Promise<void>(resolve => { finishSync = resolve; }),
  });
  const pending = deleteOpenClawAgent(input);
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
  expect(commitLocalDeletion).not.toHaveBeenCalled();

  finishSync();
  expect(await pending).toBe(true);
  expect(request.mock.calls.map(([method]) => method)).toEqual([OpenClawAgentRpcMethod.List, OpenClawAgentRpcMethod.Delete]);
  expect(request).toHaveBeenLastCalledWith(OpenClawAgentRpcMethod.Delete,
    { agentId: expertId, deleteFiles: false }, { timeoutMs: 30_000 });
  expect(request.mock.invocationCallOrder.at(-1)).toBeLessThan(commitLocalDeletion.mock.invocationCallOrder[0]);
});

test('a rejected gateway deletion preserves local data for retry', async () => {
  const { input, request, commitLocalDeletion } = setup();
  const failure = new Error('Agent owns inherited credentials');
  request.mockResolvedValueOnce({ agents: [{ id: expertId }] }).mockRejectedValueOnce(failure);
  await expect(deleteOpenClawAgent(input)).rejects.toBe(failure);
  expect(commitLocalDeletion).not.toHaveBeenCalled();
  expect(await deleteOpenClawAgent(input)).toBe(true);
  expect(commitLocalDeletion).toHaveBeenCalledOnce();
});

test('a lost deletion response requires fresh evidence of removal before local deletion', async () => {
  const { input, request, commitLocalDeletion } = setup();
  request.mockResolvedValueOnce({ agents: [{ id: expertId }] })
    .mockRejectedValueOnce(new Error('Request timed out'))
    .mockResolvedValueOnce({ agents: [{ id: AgentId.Main }] });
  expect(await deleteOpenClawAgent(input)).toBe(true);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    OpenClawAgentRpcMethod.List, OpenClawAgentRpcMethod.Delete, OpenClawAgentRpcMethod.List,
  ]);
  expect(commitLocalDeletion).toHaveBeenCalledOnce();
});

test('a failed deletion with an unchanged or unavailable roster cannot remove local data', async () => {
  for (const rosterUnavailable of [false, true]) {
    const { input, request, commitLocalDeletion } = setup();
    const failure = new Error('Agent deletion failed');
    request.mockResolvedValueOnce({ agents: [{ id: expertId }] }).mockRejectedValueOnce(failure);
    if (rosterUnavailable) request.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(deleteOpenClawAgent(input)).rejects.toBe(failure);
    expect(commitLocalDeletion).not.toHaveBeenCalled();
  }
});

test('an already removed runtime identity does not need another delete RPC', async () => {
  const { input, request, commitLocalDeletion } = setup();
  request.mockResolvedValueOnce({ agents: [{ id: AgentId.Main }] });
  expect(await deleteOpenClawAgent(input)).toBe(true);
  expect(request).toHaveBeenCalledExactlyOnceWith(OpenClawAgentRpcMethod.List, {}, { timeoutMs: 10_000 });
  expect(commitLocalDeletion).toHaveBeenCalledOnce();
});

test('a stopped gateway uses the subsequent config sync without starting a runtime', async () => {
  const { input, ensureRpcClient, commitLocalDeletion } = setup({
    getGatewayState: () => ({ phase: OpenClawEnginePhase.Ready, processId: null }),
  });
  expect(await deleteOpenClawAgent(input)).toBe(true);
  expect(ensureRpcClient).not.toHaveBeenCalled();
  expect(commitLocalDeletion).toHaveBeenCalledOnce();
});

test.each([OpenClawEnginePhase.Starting, OpenClawEnginePhase.Running])('%s requires a gateway acknowledgement', async phase => {
  const { input, commitLocalDeletion } = setup({
    getGatewayState: () => ({ phase, processId: null }),
    ensureRpcClient: async () => null,
  });
  await expect(deleteOpenClawAgent(input)).rejects.toThrow('Gateway unavailable');
  expect(commitLocalDeletion).not.toHaveBeenCalled();
});

test('an unrecognized roster response is not treated as an empty roster', async () => {
  const { input, request, commitLocalDeletion } = setup();
  request.mockResolvedValueOnce({ ok: true, agentId: expertId });
  await expect(deleteOpenClawAgent(input)).rejects.toThrow('Gateway returned no agent roster');
  expect(commitLocalDeletion).not.toHaveBeenCalled();
});

test('the main agent cannot be deleted', async () => {
  const { input, request, commitLocalDeletion } = setup({ agentId: AgentId.Main });
  expect(await deleteOpenClawAgent(input)).toBe(false);
  expect(request).not.toHaveBeenCalled();
  expect(commitLocalDeletion).not.toHaveBeenCalled();
});
