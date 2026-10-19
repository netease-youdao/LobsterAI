import { BrowserWindow, ipcMain, type WebContents } from 'electron';

import {
  AgentAccessErrorCode,
  AgentId,
  AgentIpcChannel,
  type AgentLegacyIdentityCleanupResult,
  AgentLegacyIdentityCleanupStatus,
  AgentSource,
} from '../../../shared/agent/constants';
import { usageFailureCode, type UsageParams } from '../../../shared/analytics/usage';
import type { AgentManager } from '../../agentManager';
import { AgentAccessError } from '../../agentOwnership';
import type { CoworkStore, CreateAgentRequest, UpdateAgentRequest } from '../../coworkStore';
import type { IMGatewayManager } from '../../im';
import type { CoworkEngineRouter } from '../../libs/agentEngine';
import { cleanupLegacyAgentsMdIdentityBlockInWorkspace } from '../../libs/openclawAgentsMdIdentityMigration';
import { ownershipOperationGate } from '../../ownershipOperationGate';

type SyncOpenClawConfig = (options: {
  reason: string;
  restartGatewayIfRunning?: boolean;
}) => Promise<{
  success: boolean;
  changed: boolean;
  error?: string;
}>;

export interface AgentHandlerDeps {
  reportPresetPreparation?: (fields: UsageParams) => void;
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
  const manager = deps.getAgentManager();
  const owner = manager.captureOwner();
  manager.assertAgentAccess(agentId);

  const syncResult = await deps.syncOpenClawConfig({ reason: 'agent-identity-cleanup-prereq' });
  if (!syncResult.success) {
    return buildLegacyIdentityCleanupFailure(syncResult.error || 'OpenClaw config sync failed before cleanup.');
  }

  manager.assertCurrentOwner(owner);
  manager.assertAgentAccess(agentId);
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

/** Lets other windows (e.g. the desktop companion's composer) reload agents after a change. */
function notifyAgentsChanged(sender: WebContents): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.id === sender.id) continue;
    win.webContents.send(AgentIpcChannel.Changed);
  }
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
    async (event, request: CreateAgentRequest) => {
      try {
        const agent = getAgentManager().createAgent(request, resolveDefaultAgentModelRef());
        syncOpenClawConfig({ reason: 'agent-created' }).catch(err => {
          console.error('[OpenClaw] config sync after agent-created failed:', err);
        });
        notifyAgentsChanged(event.sender);
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
    async (event, id: string, updates: UpdateAgentRequest) => {
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
        notifyAgentsChanged(event.sender);
        return { success: true, agent };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update agent',
        };
      }
    },
  );

  ipcMain.handle(AgentIpcChannel.Reorder, async (event, agentIds: string[]) => {
    try {
      const agents = getAgentManager().reorderAgents(agentIds);
      notifyAgentsChanged(event.sender);
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

  ipcMain.handle(AgentIpcChannel.Delete, async (event, id: string) => {
    let release: (() => void) | null = null;
    try {
      const agentExists = id !== AgentId.Main && getAgentManager().getAgent(id) !== null;
      const deletedSessionIds = agentExists ? getCoworkStore().listSessionIdsByAgent(id) : [];
      release = ownershipOperationGate.beginOperation({ agentIds: [id], sessionIds: deletedSessionIds });
      if (!release) throw new AgentAccessError(AgentAccessErrorCode.Busy);
      // Runtime evidence can outlive a persisted status transition. Never stop work as part of deletion.
      const router = getCoworkEngineRouter();
      if (deletedSessionIds.some(sessionId => router.isSessionActive(sessionId))) {
        throw new AgentAccessError(AgentAccessErrorCode.Busy);
      }
      // The transactional delete rechecks ownership and persisted in-flight evidence before cleanup.
      const result = getAgentManager().deleteAgent(id);
      if (!result) return { success: true, deleted: false, deletedSessionIds: [] };

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
      notifyAgentsChanged(event.sender);
      return { success: true, deleted: result, deletedSessionIds: result ? deletedSessionIds : [] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete agent',
      };
    } finally { release?.(); }
  });

  ipcMain.handle(AgentIpcChannel.Presets, async () => {
    try {
      const presets = await getAgentManager().getPresetAgents();
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
      const presets = await getAgentManager().getAllPresetAgents();
      return { success: true, presets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get preset templates',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.ExpertCatalog, async () => {
    try {
      return { success: true, catalog: await getAgentManager().getExpertCatalog() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get expert catalog' };
    }
  });

  ipcMain.handle(AgentIpcChannel.AddPreset, async (event, presetId: string) => {
    const startedAt = Date.now();
    let failureStage: PresetPreparationStage = PresetPreparationStage.Catalog;
    let prepareMode: PresetPreparationMode = PresetPreparationMode.Install;
    const report = (outcome: string, failureCode?: string) => {
      try {
        deps.reportPresetPreparation?.({ presetId, outcome, prepareMode, durationMs: Date.now() - startedAt,
          ...(failureCode ? { failureStage, failureCode } : {}) });
      } catch { /* Reporting must not affect expert preparation. */ }
    };
    try {
      const manager = getAgentManager();
      const owner = manager.captureOwner();
      const existing = manager.listAgents().find(agent => agent.source === AgentSource.Preset && agent.presetId === presetId);
      prepareMode = existing ? existing.enabled ? PresetPreparationMode.Reuse : PresetPreparationMode.Reenable : PresetPreparationMode.Install;
      const agent = await manager.addPresetAgent(presetId, resolveDefaultAgentModelRef());
      manager.assertCurrentOwner(owner);
      if (!agent) { report('failed', 'preset_not_found'); return { success: false, error: 'Preset agent not found' }; }
      manager.assertAgentAccess(agent.id);
      // The composer must not become ready before OpenClaw knows this agent.
      // If sync fails, a retry reuses the saved instance instead of duplicating it.
      failureStage = PresetPreparationStage.ConfigSync;
      const syncResult = await syncOpenClawConfig({ reason: 'agent-preset-added' });
      manager.assertCurrentOwner(owner);
      manager.assertAgentAccess(agent.id);
      if (!syncResult.success) {
        report('failed', usageFailureCode(syncResult.error));
        console.error('[OpenClaw] config sync after agent-preset-added failed:', syncResult.error);
        return { success: false, error: syncResult.error || 'Failed to sync preset agent' };
      }
      notifyAgentsChanged(event.sender);
      report('succeeded');
      return { success: true, agent };
    } catch (error) {
      report('failed', usageFailureCode(error));
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add preset agent',
      };
    }
  });
}

const PresetPreparationStage = { Catalog: 'catalog', ConfigSync: 'config_sync' } as const;
type PresetPreparationStage = typeof PresetPreparationStage[keyof typeof PresetPreparationStage];
const PresetPreparationMode = { Install: 'install', Reuse: 'reuse', Reenable: 'reenable' } as const;
type PresetPreparationMode = typeof PresetPreparationMode[keyof typeof PresetPreparationMode];
