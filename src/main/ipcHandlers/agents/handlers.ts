import { ipcMain } from 'electron';

import {
  AgentId,
  AgentIpcChannel,
  type AgentLegacyIdentityCleanupResult,
  AgentLegacyIdentityCleanupStatus,
} from '../../../shared/agent/constants';
import type { AgentManager } from '../../agentManager';
import type { CoworkStore, CreateAgentRequest, UpdateAgentRequest } from '../../coworkStore';
import type { IMGatewayManager } from '../../im';
import type { CoworkEngineRouter } from '../../libs/agentEngine';
import { cleanupLegacyAgentsMdIdentityBlockInWorkspace } from '../../libs/openclawAgentsMdIdentityMigration';

type SyncOpenClawConfig = (options: {
  reason: string;
  restartGatewayIfRunning?: boolean;
}) => Promise<{
  success: boolean;
  changed: boolean;
  error?: string;
}>;

export interface AgentHandlerDeps {
  getAgentManager: () => AgentManager;
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getIMGatewayManager: () => IMGatewayManager | null;
  refreshImSessionWorkingDirectoriesForAgent: (agentId: string) => number;
  resolveAgentWorkspacePath: (agentId: string) => string;
  resolveDefaultAgentModelRef: () => string;
  syncOpenClawConfig: SyncOpenClawConfig;
}

const buildLegacyIdentityCleanupFailure = (
  error: unknown,
): Extract<AgentLegacyIdentityCleanupResult, { status: typeof AgentLegacyIdentityCleanupStatus.Failed }> => ({
  status: AgentLegacyIdentityCleanupStatus.Failed,
  error: error instanceof Error ? error.message : String(error),
});

async function cleanupLegacyIdentityBlockForAgent(
  agentId: string,
  deps: Pick<
    AgentHandlerDeps,
    'getAgentManager' | 'resolveAgentWorkspacePath' | 'syncOpenClawConfig'
  >,
): Promise<AgentLegacyIdentityCleanupResult> {
  if (agentId !== AgentId.Main && deps.getAgentManager().getAgent(agentId) === null) {
    return buildLegacyIdentityCleanupFailure(`Agent ${agentId} not found`);
  }

  const syncResult = await deps.syncOpenClawConfig({ reason: 'agent-identity-cleanup-prereq' });
  if (!syncResult.success) {
    return buildLegacyIdentityCleanupFailure(syncResult.error || 'OpenClaw config sync failed before cleanup.');
  }

  const workspacePath = deps.resolveAgentWorkspacePath(agentId);
  const result = cleanupLegacyAgentsMdIdentityBlockInWorkspace(workspacePath);
  if (result.status === AgentLegacyIdentityCleanupStatus.Cleaned) {
    console.log(
      `[OpenClaw] Cleaned legacy AGENTS.md identity block for agent ${agentId}; backup=${result.backupPath}`,
    );
  } else if (result.status === AgentLegacyIdentityCleanupStatus.Failed) {
    console.warn(
      `[OpenClaw] Failed to clean legacy AGENTS.md identity block for agent ${agentId}: ${result.error}`,
    );
  }
  return result;
}

export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  const {
    getAgentManager,
    getCoworkStore,
    getCoworkEngineRouter,
    getIMGatewayManager,
    refreshImSessionWorkingDirectoriesForAgent,
    resolveDefaultAgentModelRef,
    syncOpenClawConfig,
  } = deps;

  ipcMain.handle(AgentIpcChannel.List, async () => {
    try {
      const agents = getAgentManager().listAgents();
      return { success: true, agents };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agents',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.Get, async (_event, id: string) => {
    try {
      const agent = getAgentManager().getAgent(id);
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get agent',
      };
    }
  });

  ipcMain.handle(
    AgentIpcChannel.Create,
    async (_event, request: CreateAgentRequest) => {
      try {
        const agent = getAgentManager().createAgent(request, resolveDefaultAgentModelRef());
        syncOpenClawConfig({ reason: 'agent-created' }).catch(err => {
          console.error('[OpenClaw] config sync after agent-created failed:', err);
        });
        return { success: true, agent };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create agent',
        };
      }
    },
  );

  ipcMain.handle(
    AgentIpcChannel.Update,
    async (_event, id: string, updates: UpdateAgentRequest) => {
      try {
        const previousAgent = getAgentManager().getAgent(id);
        const previousWorkingDirectory = previousAgent?.workingDirectory?.trim() || '';
        const nextWorkingDirectory = updates.workingDirectory?.trim() || '';
        const workingDirectoryChanged =
          updates.workingDirectory !== undefined
          && previousAgent !== null
          && previousWorkingDirectory !== nextWorkingDirectory;
        const agent = getAgentManager().updateAgent(id, updates);
        if (workingDirectoryChanged && agent) {
          refreshImSessionWorkingDirectoriesForAgent(agent.id);
        }
        const shouldSyncOpenClawConfig = Object.keys(updates).some(
          key => key !== 'pinned' && key !== 'sortOrder',
        );
        if (shouldSyncOpenClawConfig) {
          syncOpenClawConfig({
            reason: workingDirectoryChanged ? 'agent-working-directory-updated' : 'agent-updated',
            restartGatewayIfRunning: workingDirectoryChanged,
          }).catch(err => {
            console.error('[OpenClaw] config sync after agent update failed:', err);
          });
        }
        return { success: true, agent };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update agent',
        };
      }
    },
  );

  ipcMain.handle(AgentIpcChannel.Reorder, async (_event, agentIds: string[]) => {
    try {
      const agents = getAgentManager().reorderAgents(agentIds);
      return { success: true, agents };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reorder agents',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.CleanupLegacyIdentityBlock, async (_event, id: string) => {
    try {
      const result = await cleanupLegacyIdentityBlockForAgent(id, deps);
      return { success: true, result };
    } catch (error) {
      const result = buildLegacyIdentityCleanupFailure(error);
      console.warn(`[OpenClaw] Failed to clean legacy AGENTS.md identity block for agent ${id}: ${result.error}`);
      return { success: false, result, error: result.error };
    }
  });

  ipcMain.handle(AgentIpcChannel.Delete, async (_event, id: string) => {
    try {
      const agentExists = id !== AgentId.Main && getAgentManager().getAgent(id) !== null;
      const deletedSessionIds = agentExists ? getCoworkStore().listSessionIdsByAgent(id) : [];
      const router = getCoworkEngineRouter();
      for (const sessionId of deletedSessionIds) {
        router.stopSession(sessionId);
      }

      const result = getAgentManager().deleteAgent(id);

      try {
        const imStore = getIMGatewayManager()?.getIMStore();
        if (imStore) {
          const imSettings = imStore.getIMSettings();
          const bindings = imSettings.platformAgentBindings;
          if (bindings) {
            let changed = false;
            for (const [platform, agentId] of Object.entries(bindings)) {
              if (agentId === id) {
                delete bindings[platform];
                changed = true;
              }
            }
            if (changed) {
              imStore.setIMSettings({ platformAgentBindings: bindings });
            }
          }
        }
      } catch {
        // IM store may not be initialised yet; safe to ignore.
      }

      if (result) {
        for (const sessionId of deletedSessionIds) {
          try {
            getIMGatewayManager()?.getIMStore()?.deleteSessionMappingByCoworkSessionId(sessionId);
          } catch {
            // IM store may not be initialised yet; safe to ignore.
          }
          try {
            router.onSessionDeleted(sessionId);
          } catch {
            // Router may not be initialised yet; safe to ignore.
          }
        }
      }

      syncOpenClawConfig({ reason: 'agent-deleted' }).catch(err => {
        console.error('[OpenClaw] config sync after agent-deleted failed:', err);
      });
      return { success: true, deleted: result, deletedSessionIds: result ? deletedSessionIds : [] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete agent',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.Presets, async () => {
    try {
      const presets = getAgentManager().getPresetAgents();
      return { success: true, presets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get presets',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.PresetTemplates, async () => {
    try {
      const presets = getAgentManager().getAllPresetAgents();
      return { success: true, presets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get preset templates',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.AddPreset, async (_event, presetId: string) => {
    try {
      const agent = getAgentManager().addPresetAgent(presetId, resolveDefaultAgentModelRef());
      syncOpenClawConfig({ reason: 'agent-preset-added' }).catch(err => {
        console.error('[OpenClaw] config sync after agent-preset-added failed:', err);
      });
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add preset agent',
      };
    }
  });
}
