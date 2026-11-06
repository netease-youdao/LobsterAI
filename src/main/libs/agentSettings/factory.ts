import { AgentId, AgentSource } from '../../../shared/agent/constants';
import { parseModelThinkingLevel } from '../../../shared/providers/modelThinking';
import type { RemoteOwner } from '../../../shared/remote/constants';
import { RemoteInputReason } from '../../../shared/remote/input';
import type { AgentManager } from '../../agentManager';
import type { CoworkStore, UpdateAgentRequest } from '../../coworkStore';
import { sameOwner } from '../../remote/canonical';
import type { RemoteModelCatalog } from '../../remote/remoteModelCatalog';
import type { AgentSettingsRuntimeBridge } from '../agentSettingsConversation/runtime';
import { AgentSettingsService } from './service';
import { AgentSettingsFileStore, isSettingsEncryptionAvailable } from './storage';
import {
  AgentSettingsAction, type AgentSettingsCollaborator, type AgentSettingsContext, type AgentSettingsDependencies, AgentSettingsError,
  AgentSettingsReason, AgentSettingsSection, AgentSettingsSource,
} from './types';

interface SettingsAccess {
  assertAccess: AgentSettingsDependencies['assertAccess'];
  assertRecoveryAccess(context: AgentSettingsContext): void;
}
export interface AgentSettingsFactoryOptions {
  stateDir: string;
  journalDir: string;
  store: CoworkStore;
  agents: AgentManager;
  models: RemoteModelCatalog;
  runtime: Pick<AgentSettingsRuntimeBridge, 'ready' | 'acquireWriteLease'>;
  protection: { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string; encryptString(value: string): Buffer; decryptString(value: Buffer): string };
  /** Missing/not-yet-created binding protocol must fail closed during initialization. */
  access(): SettingsAccess | null;
  getDefaultModel(): string;
  authorizeConversation: NonNullable<AgentSettingsDependencies['authorizeConversation']>;
  /** Must confirm actual gateway application, and reject pending/rejected config; never await this run's end. */
  syncAndConfirmConfig(context: AgentSettingsContext, section: AgentSettingsSection): Promise<void>;
}

/** Production ports over existing SQLite ownership, opaque catalog, encrypted state and gateway writer lease. */
export function createAgentSettingsService(options: AgentSettingsFactoryOptions) {
  const protection = {
    encryptString(value: string): Buffer {
      if (!isSettingsEncryptionAvailable(options.protection)) throw new AgentSettingsError(AgentSettingsReason.Unavailable);
      return options.protection.encryptString(value);
    },
    decryptString(value: Buffer): string {
      if (!isSettingsEncryptionAvailable(options.protection)) throw new AgentSettingsError(AgentSettingsReason.Unavailable);
      return options.protection.decryptString(value);
    },
  };
  const persistence = new AgentSettingsFileStore(options.journalDir, protection);
  let runtimeReady = false;
  const access = (): SettingsAccess => {
    const port = options.access();
    if (!port || !isSettingsEncryptionAvailable(options.protection)) throw new AgentSettingsError(AgentSettingsReason.Unavailable);
    return port;
  };
  const assertOwner = (owner: RemoteOwner): void => {
    if (!sameOwner(owner, options.agents.captureOwner())) throw new AgentSettingsError(AgentSettingsReason.Agent);
  };
  const assertAgent = (context: AgentSettingsContext): void => {
    assertOwner(context.owner);
    options.store.assertAgentAccess(context.agentId, context.owner);
    // Existing local UI intentionally sees anonymous Agents. Remote settings do not adopt them.
    if (!options.store.agentOwnership.canPublish(context.agentId, context.owner)) throw new AgentSettingsError(AgentSettingsReason.Agent);
    if (!options.store.getAgent(context.agentId)?.enabled) throw new AgentSettingsError(AgentSettingsReason.Agent);
  };
  const service = new AgentSettingsService({
    stateDir: options.stateDir, store: persistence,
    assertAccess(context, section, action) {
      access().assertAccess(context, section, action); assertAgent(context);
      if (action === AgentSettingsAction.ConversationUpdate && section === AgentSettingsSection.Identity
        && options.store.getAgent(context.agentId)?.source === AgentSource.Preset) throw new AgentSettingsError(AgentSettingsReason.LocalAction);
    },
    // Do not require a live Agent, epoch or binding for an already-written minimal receipt.
    assertRecoveryAccess(context) { access().assertRecoveryAccess(context); assertOwner(context.owner); },
    assertRecoverySourceAccess(context) { access().assertRecoveryAccess(context); assertAgent(context); },
    getAgent(context) { return options.store.getAgent(context.agentId); },
    updateAgent(context, patch) {
      assertAgent(context);
      for (const id of patch.subagentAllowAgentIds ?? []) assertAgent({ ...context, agentId: id });
      // Local entry points own the local-writer guard; this call already holds the same runtime lease.
      const { thinkingLevel, ...fields } = patch;
      const normalized: UpdateAgentRequest = { ...fields };
      if (thinkingLevel !== undefined) {
        const parsed = thinkingLevel === '' ? '' : parseModelThinkingLevel(thinkingLevel);
        if (parsed === undefined) throw new AgentSettingsError(AgentSettingsReason.Invalid);
        normalized.thinkingLevel = parsed;
      }
      if (!options.store.updateAgent(context.agentId, normalized, context.owner)) throw new AgentSettingsError(AgentSettingsReason.Agent);
    },
    readModel(context, agent) {
      const inherited = !agent.model;
      const runtimeRef = agent.model || options.getDefaultModel();
      if (!runtimeRef) return { modelRef: null, modelVersion: null, thinkingLevel: null, inherited,
        selectionState: 'unconfigured', unavailableReason: null };
      try {
        const { item } = options.models.resolveRuntime(context.owner, context.deviceId, runtimeRef);
        const thinking = agent.thinkingLevel || item.thinking.default;
        if (thinking && !item.thinking.options.includes(thinking)) return { modelRef: item.modelRef, modelVersion: item.version,
          thinkingLevel: null, inherited, selectionState: 'unavailable', unavailableReason: RemoteInputReason.Invalid };
        return { modelRef: item.modelRef, modelVersion: item.version, thinkingLevel: thinking || null, inherited,
          selectionState: 'available', unavailableReason: null };
      } catch {
        // A deleted/invalid default is repairable. Never include a runtime reference or thrown config detail.
        return { modelRef: null, modelVersion: null, thinkingLevel: null, inherited,
          selectionState: 'unavailable', unavailableReason: RemoteInputReason.ModelUnavailable };
      }
    },
    resolveModel(context, selection) {
      const { item, local } = options.models.resolve(context.owner, context.deviceId, selection.modelRef, selection.modelVersion);
      if (selection.thinkingLevel !== null && (!parseModelThinkingLevel(selection.thinkingLevel) || !item.thinking.options.includes(selection.thinkingLevel))) throw new AgentSettingsError(RemoteInputReason.Invalid);
      return { model: local.runtimeRef, thinkingLevel: selection.thinkingLevel ?? '' };
    },
    listCollaborators(context) {
      assertAgent(context);
      return options.agents.listAgents().filter(agent => agent.id !== context.agentId && agent.enabled
        && options.store.agentOwnership.canPublish(agent.id, context.owner)).map((agent): AgentSettingsCollaborator => ({
        agentId: agent.id, agentVersion: options.store.agentOwnership.get(agent.id)!.version,
        name: agent.name.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 120),
        // Desktop icons may be local file paths. The phone can render its standard Agent placeholder.
        icon: null,
      }));
    },
    acquireWriteLease: context => options.runtime.acquireWriteLease(context),
    acquireRecoveryLease: context => options.runtime.acquireWriteLease({ ...context, source: AgentSettingsSource.App,
      commandId: undefined, runId: undefined, toolCallId: undefined }),
    async confirmApplied(context, section) {
      if (section === AgentSettingsSection.Model || section === AgentSettingsSection.Collaboration
        || section === AgentSettingsSection.Identity && context.agentId !== AgentId.Main) await options.syncAndConfirmConfig(context, section);
      // Workspace documents are loaded at the next run boundary. The core verifies exact file/DB read-back.
    },
    authorizeConversation: options.authorizeConversation,
  });
  return {
    service, store: persistence,
    available: () => runtimeReady && isSettingsEncryptionAvailable(options.protection),
    async refreshAvailability(): Promise<boolean> {
      runtimeReady = isSettingsEncryptionAvailable(options.protection) && await options.runtime.ready();
      return runtimeReady;
    },
    listAgents: () => options.agents.listAgents().filter(agent => agent.enabled
      && options.store.agentOwnership.canPublish(agent.id, options.agents.captureOwner())).map(agent => ({ agentId: agent.id, name: agent.name })),
  };
}
