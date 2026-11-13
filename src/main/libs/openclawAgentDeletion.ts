import { AgentId } from '../../shared/agent/constants';
import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import type { OpenClawConfigRpcClient } from './openclawConfigDelivery';

export const OpenClawAgentRpcMethod = {
  List: 'agents.list',
  Delete: 'agents.delete',
} as const;
export type OpenClawAgentRpcMethod = typeof OpenClawAgentRpcMethod[keyof typeof OpenClawAgentRpcMethod];

type AgentDeletionInput = {
  agentId: string;
  previousConfigSync: Promise<unknown>;
  getGatewayState: () => { phase: OpenClawEnginePhase; processId: number | null };
  ensureRpcClient: () => Promise<OpenClawConfigRpcClient | null>;
  commitLocalDeletion: () => boolean;
};

async function isAgentConfigured(client: OpenClawConfigRpcClient, agentId: string): Promise<boolean> {
  const result = await client.request<{ agents?: Array<{ id: string }> }>(
    OpenClawAgentRpcMethod.List, {}, { timeoutMs: 10_000 },
  );
  if (!Array.isArray(result?.agents) || result.agents.some(agent => typeof agent?.id !== 'string')) {
    throw new Error('Gateway returned no agent roster');
  }
  return result.agents.some(agent => agent.id === agentId);
}

/**
 * The caller adds this operation to the config-sync queue. Remove the runtime
 * identity explicitly before committing the local deletion; a full config
 * write cannot remove roster entries, and a failed RPC must remain retryable.
 */
export async function deleteOpenClawAgent(input: AgentDeletionInput): Promise<boolean> {
  await input.previousConfigSync.catch(() => {});
  if (input.agentId === AgentId.Main) return false;
  const { phase, processId } = input.getGatewayState();
  const hasRuntime = processId !== null || phase === OpenClawEnginePhase.Running || phase === OpenClawEnginePhase.Starting;
  if (hasRuntime) {
    const client = await input.ensureRpcClient();
    if (!client) throw new Error('Gateway unavailable while deleting agent');
    if (await isAgentConfigured(client, input.agentId)) {
      try {
        // The user deletes the agent and its task records, not workspace files.
        const result = await client.request<{ ok?: boolean; agentId?: string }>(
          OpenClawAgentRpcMethod.Delete,
          { agentId: input.agentId, deleteFiles: false },
          { timeoutMs: 30_000 },
        );
        if (result?.ok !== true || result.agentId !== input.agentId) {
          throw new Error('Gateway did not confirm agent deletion');
        }
      } catch (error) {
        // A lost response or another caller can leave the deletion committed.
        // Only a fresh roster proving absence makes that safe to accept.
        const stillConfigured = await isAgentConfigured(client, input.agentId).catch(() => true);
        if (stillConfigured) throw error;
      }
      console.log('[OpenClaw] Removed agent from gateway:', input.agentId);
    }
  }
  // A stopped runtime reads the subsequent local config sync on its next start.
  return input.commitLocalDeletion();
}
