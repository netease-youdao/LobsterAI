import { BrowserWindow, ipcMain, type WebContents } from 'electron';

import {
  AgentAccessErrorCode,
  AgentId,
  AgentIpcChannel,
  type AgentLegacyIdentityCleanupResult,
  AgentLegacyIdentityCleanupStatus,
  AgentSource,
} from '../../../shared/agent/constants';
import {
  AgentDraftErrorCode,
  type AgentDraftStreamChunk,
  type AgentDraftStreamPreview,
  type GenerateAgentDraftRequest,
  type GenerateAgentDraftResult,
} from '../../../shared/agent/draft';
import { parseAgentModelSelection } from '../../../shared/agent/modelSelection';
import { ExpertUpgradeStatus } from '../../../shared/agent/presets';
import { usageFailureCode, UsageOutcome, type UsageParams } from '../../../shared/analytics/usage';
import type { AgentManager } from '../../agentManager';
import { AgentAccessError } from '../../agentOwnership';
import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from '../../coworkStore';
import { getLanguage } from '../../i18n';
import type { IMGatewayManager } from '../../im';
import { createAgentDescriptionBackfiller } from '../../libs/agentDescriptionBackfill';
import type { CoworkEngineRouter } from '../../libs/agentEngine';
import { pickChangedAgentPersona, writeAgentPersonaFiles } from '../../libs/agentPersonaFiles';
import { cleanupLegacyAgentsMdIdentityBlockInWorkspace } from '../../libs/openclawAgentsMdIdentityMigration';
import { ownershipOperationGate } from '../../ownershipOperationGate';
import { isExpertBusy, upgradePreset } from './upgradePreset';

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
  hasPendingMediaTask?: (sessionId: string) => boolean;
  getIMGatewayManager: () => IMGatewayManager | null;
  refreshImSessionWorkingDirectoriesForAgent: (agentId: string) => number;
  resolveAgentWorkspacePath: (agentId: string) => string;
  resolveDefaultAgentModelRef: () => string;
  deleteAgentWithRuntime: (agentId: string, commitLocalDeletion: () => boolean) => Promise<boolean>;
  syncOpenClawConfig: SyncOpenClawConfig;
  getLanguage?: () => 'zh' | 'en';
  generateAgentDraft?: (
    request: GenerateAgentDraftRequest,
    options?: {
      signal?: AbortSignal;
      onProgress?: (preview: AgentDraftStreamPreview) => void;
    },
  ) => Promise<GenerateAgentDraftResult>;
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

/**
 * Config sync only seeds missing persona files, so a new agent writes its own:
 * a workspace left behind by a deleted agent with the same ID must not supply
 * the new agent's persona.
 */
function writeNewAgentPersonaFiles(
  agent: Agent,
  resolveAgentWorkspacePath: AgentHandlerDeps['resolveAgentWorkspacePath'],
): void {
  try {
    writeAgentPersonaFiles(resolveAgentWorkspacePath(agent.id), pickChangedAgentPersona(null, agent));
  } catch (error) {
    console.warn(`[Agents] Failed to write persona files for new agent ${agent.id}:`, error);
  }
}

/** Lets renderer windows reload agents after a change; omit excludeSender to broadcast to all windows. */
export function notifyAgentsChanged(excludeSender?: WebContents): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed?.() || win.webContents.id === excludeSender?.id) continue;
      win.webContents.send(AgentIpcChannel.Changed);
    } catch (error) {
      console.warn('[Agents] Failed to notify a window of agent changes:', error);
    }
  }
}

export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  const {
    getAgentManager,
    getCoworkStore,
    getCoworkEngineRouter,
    getIMGatewayManager,
    refreshImSessionWorkingDirectoriesForAgent,
    resolveAgentWorkspacePath,
    resolveDefaultAgentModelRef,
    syncOpenClawConfig,
  } = deps;

  const descriptionBackfiller = createAgentDescriptionBackfiller({
    getAgentManager,
    generateAgentDraft: deps.generateAgentDraft,
    syncOpenClawConfig,
    onAgentDescriptionUpdated: () => notifyAgentsChanged(),
    getLanguage: deps.getLanguage ?? getLanguage,
  });

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
        writeNewAgentPersonaFiles(agent, resolveAgentWorkspacePath);
        syncOpenClawConfig({ reason: 'agent-created' }).catch(err => {
          console.error('[OpenClaw] config sync after agent-created failed:', err);
        });
        descriptionBackfiller.scheduleForCreatedAgent(agent);
        notifyAgentsChanged(event.sender);
        return { success: true, agent };
      } catch (error) {
        console.error('[Agents] Failed to create agent:', error);
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
          // `agents.defaults.cwd` / `agents.entries.<id>.cwd` hot-reload in OpenClaw:
          // channel and cron runs resolve cwd from the republished runtime config.
          syncOpenClawConfig({
            reason: workingDirectoryChanged ? 'agent-working-directory-updated' : 'agent-updated',
          }).catch(err => {
            console.error('[OpenClaw] config sync after agent update failed:', err);
          });
        }
        if (agent) {
          descriptionBackfiller.scheduleForUpdatedAgent({
            previousAgent,
            nextAgent: agent,
            updates,
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

  const activeDraftControllers = new Map<string, AbortController>();

  ipcMain.handle(AgentIpcChannel.GenerateDraft, async (event, request: GenerateAgentDraftRequest) => {
    if (!deps.generateAgentDraft) {
      return {
        success: false,
        errorCode: AgentDraftErrorCode.RequestFailed,
        error: 'Agent draft generator is unavailable',
      } satisfies GenerateAgentDraftResult;
    }
    const sender = event?.sender;
    const senderId = sender?.id ?? 0;
    const requestId = typeof request?.requestId === 'string' ? request.requestId.trim() : '';
    const activeKey = requestId ? `${senderId}:${requestId}` : '';
    const controller = new AbortController();
    if (activeKey) {
      activeDraftControllers.get(activeKey)?.abort();
      activeDraftControllers.set(activeKey, controller);
    }
    const onSenderDestroyed = () => controller.abort();
    sender?.once?.('destroyed', onSenderDestroyed);

    try {
      const onProgress = requestId && sender
        ? (preview: AgentDraftStreamPreview) => {
            if (controller.signal.aborted || sender.isDestroyed()) return;
            const payload: AgentDraftStreamChunk = {
              requestId,
              ...(preview.instructions !== undefined ? { instructions: preview.instructions } : {}),
              ...(preview.description !== undefined ? { description: preview.description } : {}),
            };
            sender.send(AgentIpcChannel.GenerateDraftChunk, payload);
          }
        : undefined;
      return await deps.generateAgentDraft(request, {
        signal: controller.signal,
        ...(onProgress ? { onProgress } : {}),
      });
    } catch (error) {
      console.error('[Agents] Failed to generate agent draft:', error);
      return {
        success: false,
        errorCode: AgentDraftErrorCode.RequestFailed,
        error: error instanceof Error ? error.message : 'Failed to generate agent draft',
      } satisfies GenerateAgentDraftResult;
    } finally {
      sender?.removeListener?.('destroyed', onSenderDestroyed);
      if (activeKey && activeDraftControllers.get(activeKey) === controller) {
        activeDraftControllers.delete(activeKey);
      }
    }
  });

  ipcMain.handle(AgentIpcChannel.CancelDraft, (event, rawRequestId: unknown) => {
    const requestId = typeof rawRequestId === 'string' ? rawRequestId.trim() : '';
    if (!requestId) return false;
    const activeKey = `${event?.sender?.id ?? 0}:${requestId}`;
    const controller = activeDraftControllers.get(activeKey);
    if (!controller) return false;
    controller.abort();
    activeDraftControllers.delete(activeKey);
    return true;
  });

  ipcMain.handle(AgentIpcChannel.Delete, async (event, id: string) => {
    let release: (() => void) | null = null;
    try {
      const manager = getAgentManager();
      const owner = manager.captureOwner();
      const agentExists = id !== AgentId.Main && getAgentManager().getAgent(id) !== null;
      if (!agentExists) return { success: true, deleted: false, deletedSessionIds: [] };
      const deletedSessionIds = agentExists ? getCoworkStore().listSessionIdsByAgent(id) : [];
      release = ownershipOperationGate.beginOperation({ agentIds: [id], sessionIds: deletedSessionIds });
      if (!release) throw new AgentAccessError(AgentAccessErrorCode.Busy);
      // Runtime evidence can outlive a persisted status transition. Never stop work as part of deletion.
      const router = getCoworkEngineRouter();
      if (deletedSessionIds.some(sessionId => router.isSessionActive(sessionId))) {
        throw new AgentAccessError(AgentAccessErrorCode.Busy);
      }

      getCoworkStore().agentOwnership.assertDeletable(id, owner);
      const result = await deps.deleteAgentWithRuntime(id, () => {
        manager.assertCurrentOwner(owner);
        return manager.deleteAgent(id);
      });
      if (!result) return { success: true, deleted: false, deletedSessionIds: [] };
      if (result) {
        descriptionBackfiller.cancel(id);
      }

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
      console.error('[Agents] Failed to delete agent:', id, error);
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

  ipcMain.handle(AgentIpcChannel.IsExpertBusy, (_event, agentId: string) => isExpertBusy(agentId, deps));
  ipcMain.handle(AgentIpcChannel.DismissPresetUpdate, async (event, agentId: string, revision: number) => {
    const manager = getAgentManager();
    const presetId = manager.getAgent(agentId)?.presetId;
    if (!presetId) return false;
    const preset = (await manager.getExpertCatalog()).experts.find(expert => expert.id === presetId);
    if (!preset || preset.revision !== revision) return false;
    const saved = deps.getCoworkStore().dismissPresetUpdate(agentId, revision);
    if (saved) notifyAgentsChanged(event.sender);
    return saved;
  });

  const upgrades = new Map<string, { revision: number; result: Promise<ExpertUpgradeStatus> }>();
  ipcMain.handle(AgentIpcChannel.UpgradePreset, async (event, agentId: string, revision: number) => {
    const pending = upgrades.get(agentId);
    if (pending) return pending.revision === revision ? pending.result : ExpertUpgradeStatus.Unavailable;
    const result = upgradePreset(agentId, revision, deps);
    upgrades.set(agentId, { revision, result });
    try {
      const status = await result;
      if (status === ExpertUpgradeStatus.Updated) notifyAgentsChanged(event.sender);
      return status;
    } finally {
      upgrades.delete(agentId);
    }
  });

  ipcMain.handle(AgentIpcChannel.AddPreset, async (event, presetId: string, rawModelSelection?: unknown) => {
    const startedAt = Date.now();
    let failureStage: PresetPreparationStage = PresetPreparationStage.Catalog;
    let prepareMode: PresetPreparationMode = PresetPreparationMode.Install;
    const report = (outcome: string, failureCode?: string) => {
      try {
        deps.reportPresetPreparation?.({ presetId, outcome, prepareMode, durationMs: Date.now() - startedAt,
          ...(failureCode ? { failureStage, failureCode } : {}) });
      } catch { /* Reporting must not affect expert preparation. */ }
    };
    const fail = (error: unknown, failureCode: string = usageFailureCode(error)) => {
      console.error('[Agents] Failed to prepare preset agent:', {
        presetId, failureStage, prepareMode, durationMs: Date.now() - startedAt,
      }, error);
      report(UsageOutcome.Failed, failureCode);
      return {
        success: false,
        error: error instanceof Error ? error.message
          : typeof error === 'string' ? error : 'Failed to add preset agent',
      };
    };
    try {
      const manager = getAgentManager();
      const owner = manager.captureOwner();
      const existing = manager.listAgents().find(agent => agent.source === AgentSource.Preset && agent.presetId === presetId);
      prepareMode = existing ? existing.enabled ? PresetPreparationMode.Reuse : PresetPreparationMode.Reenable : PresetPreparationMode.Install;
      const modelSelection = parseAgentModelSelection(rawModelSelection);
      const agent = await manager.addPresetAgent(
        presetId,
        modelSelection ? modelSelection.model : resolveDefaultAgentModelRef(),
        modelSelection?.thinkingLevel,
      );
      manager.assertCurrentOwner(owner);
      if (!agent) return fail(new Error(`Preset agent not found: ${presetId}`), 'preset_not_found');
      // A reused or re-enabled instance keeps the persona its workspace already has.
      if (prepareMode === PresetPreparationMode.Install) writeNewAgentPersonaFiles(agent, resolveAgentWorkspacePath);
      manager.assertAgentAccess(agent.id);
      // The composer must not become ready before OpenClaw knows this agent.
      // If sync fails, a retry reuses the saved instance instead of duplicating it.
      failureStage = PresetPreparationStage.ConfigSync;
      const syncResult = await syncOpenClawConfig({ reason: 'agent-preset-added' });
      manager.assertCurrentOwner(owner);
      manager.assertAgentAccess(agent.id);
      if (!syncResult.success) {
        return fail(new Error(syncResult.error || 'Failed to sync preset agent'));
      }
      notifyAgentsChanged(event.sender);
      report(UsageOutcome.Succeeded);
      return { success: true, agent };
    } catch (error) {
      return fail(error);
    }
  });
}

const PresetPreparationStage = { Catalog: 'catalog', ConfigSync: 'config_sync' } as const;
type PresetPreparationStage = typeof PresetPreparationStage[keyof typeof PresetPreparationStage];
const PresetPreparationMode = { Install: 'install', Reuse: 'reuse', Reenable: 'reenable' } as const;
type PresetPreparationMode = typeof PresetPreparationMode[keyof typeof PresetPreparationMode];
