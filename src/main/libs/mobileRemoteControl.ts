import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, safeStorage } from 'electron';

import { RemoteCommandKind, type RemoteOwner } from '../../shared/remote/constants';
import type { AgentManager } from '../agentManager';
import type { CoworkStore } from '../coworkStore';
import type { LibraryFileAccessPolicy } from '../library/libraryFileAccess';
import type { LibraryIndexService } from '../library/libraryIndexService';
import { sameOwner } from '../remote/canonical';
import { prepareDefaultWorkspace } from '../remote/defaultWorkspace';
import { InputPreparationService } from '../remote/inputPreparationService';
import { createRemoteDatabaseFence,loadRemoteIdentity } from '../remote/installationIdentity';
import { RemoteBridge } from '../remote/remoteBridge';
import { RemoteImageDecoder } from '../remote/remoteImageDecoder';
import { listRemoteInputModels } from '../remote/remoteInputModels';
import { RemoteModelCatalog } from '../remote/remoteModelCatalog';
import { remoteNetworkTransport } from '../remote/remoteNetworkTransport';
import { RemoteRegistrationIdentityStore } from '../remote/remoteRegistrationIdentity';
import { RemoteSecurityCoordinator } from '../remote/remoteSecurityCoordinator';
import { RemoteSecurityJournal, RemoteSecurityJournalWorkerIo } from '../remote/remoteSecurityJournal';
import type { SessionCommandService } from '../remote/sessionCommandService';
import type { SessionDeletionService } from '../remote/sessionDeletionService';
import type { CoworkEngineRouter } from './agentEngine';
import { type AgentSettingsFactoryOptions,createAgentSettingsService } from './agentSettings/factory';
import type { AuthFetch } from './authSessionManager';
import { attachDshRemoteAgentSettingsReader } from './dsh/dshRemoteAgentSettingsTool';

interface MobileRemoteDependencies {
  store(): CoworkStore;
  commands(): SessionCommandService;
  runtime(): CoworkEngineRouter;
  deletion(): SessionDeletionService;
  agents(): AgentManager;
  settingsRuntime: AgentSettingsFactoryOptions['runtime'];
  assertSettingsTurn(sessionId: string, requestId: string, agentId: string): void;
  syncSettings: AgentSettingsFactoryOptions['syncAndConfirmConfig'];
  agentWorkspace(id: string): string;
  notifyAgents(): void;
  library(): LibraryIndexService | null;
  captureFile: LibraryFileAccessPolicy['capture'];
  owner(): RemoteOwner | null;
  displayOwner(): RemoteOwner | null;
  routeEpoch(): number;
  token(): string | null;
  endpoint(): string;
  headers(): Record<string, string>;
  fetchWithAuth(url: string, options?: RequestInit, transport?: AuthFetch): Promise<Response>;
  defaultModel(): string;
  defaultCwd(): string;
  expertEndpoint(): string;
  expertAvatar(url: string): string | null;
  hasLock: boolean;
  disposeSecurity(register: () => void): void;
  supportsCommand(type: string): boolean;
  changed(): void;
}

export function buildMobileRemoteBridge(deps: MobileRemoteDependencies): RemoteBridge {
  const { store: getCoworkStore, owner: getCurrentRemoteOwner, endpoint: getServerApiBaseUrl, defaultModel: resolveDefaultAgentModelRef } = deps;
  const commands = deps.commands();
  let remoteBridge: RemoteBridge | undefined;
  const cleanup: Array<() => void> = [];
  try {
    getCoworkStore().remote.initializeSynchronization();
    // Missing ciphertext is not a fresh installation when the database already has security evidence.
    const remoteStore = getCoworkStore().remote;
    const hasIdentityEvidence = Boolean(remoteStore.db.prepare(`SELECT 1 FROM remote_state WHERE key IN
      ('databaseInstance','databaseCheckpoint','securityJournalMigrated','securityJournalHead','securityJournalConflict')
      OR key LIKE 'ownershipProof:%' LIMIT 1`).get());
    const identity = loadRemoteIdentity(app.getPath('appData'), app.getPath('userData'), safeStorage, !hasIdentityEvidence);
    const fence = createRemoteDatabaseFence(app.getPath('appData'), app.getPath('userData'), safeStorage, identity);
    const profile = crypto.createHash('sha256').update(fs.realpathSync(app.getPath('userData'))).digest('hex');
    const journal = new RemoteSecurityJournal(identity, new RemoteSecurityJournalWorkerIo(path.join(app.getPath('appData'), 'LobsterAI-remote-identity', profile, 'security-v1')), deps.hasLock);
    cleanup.push(() => journal.close());
    const security = new RemoteSecurityCoordinator(getCoworkStore().remote, journal, identity, fence.checkpoint);
    cleanup.push(() => security.close());
    const models = new RemoteModelCatalog(getCoworkStore().remote, () => listRemoteInputModels({
      token: deps.token(), baseURL: getServerApiBaseUrl(),
    }), () => remoteBridge?.getSyncTargetId() ?? null);
    const agentSettings = createAgentSettingsService({
      stateDir: app.getPath('userData'), getWorkspaceDir: deps.agentWorkspace,
      journalDir: path.join(app.getPath('userData'), 'agent-settings'), protection: safeStorage,
      agents: deps.agents(), store: getCoworkStore(), models, runtime: deps.settingsRuntime,
      getDefaultModel: resolveDefaultAgentModelRef, access: () => remoteBridge?.agentSettingsProtocol() ?? null,
      onAgentUpdated: deps.notifyAgents, syncAndConfirmConfig: deps.syncSettings,
      authorizeConversation: () => { throw new Error('CONVERSATION_CHANGE_UNAVAILABLE'); },
    });
    const imageDecoder = new RemoteImageDecoder();
    const preparations = new InputPreparationService({
      store: getCoworkStore(), models, cacheRoot: path.join(app.getPath('userData'), 'remote-inputs'),
      getOwner: getCurrentRemoteOwner, getDefaultModel: resolveDefaultAgentModelRef,
      getTargetId: () => remoteBridge?.getSyncTargetId() ?? null,
      getAgentCatalog: () => remoteBridge?.getInputAgentCatalog() || null,
      createImagePreview: (filePath, context) => imageDecoder.preview(filePath, context!),
      convertImage: (filePath, _mimeType, targetPath, maximumBytes, context) => imageDecoder.convert(filePath, targetPath, maximumBytes, context!),
    });
    commands.configureInput({ models, preparations, getDeviceId: () => remoteBridge?.state().deviceId,
      getTargetId: () => remoteBridge?.getSyncTargetId() ?? null });
    remoteBridge = new RemoteBridge({
      security,
      agentSettings: { ...agentSettings, conversationReady: () => false },
      createSocket: url => remoteNetworkTransport.socket(url),
      deletion: { service: deps.deletion(), runtime: deps.runtime(), reconcileStop: id => commands.reconcileSession(id) },
      input: { models, preparations, refreshSessionModel: sessionId => { commands.recordCurrentInputModel(sessionId); } },
      files: {
        cacheRoot: path.join(app.getPath('userData'), 'remote-file-uploads'), access: filePath => deps.captureFile(filePath),
        recordArtifact: async (candidate, owner, assertCurrent, validateIndexed) => {
          assertCurrent();
          const libraryIndexService = deps.library();
          if (!libraryIndexService) return false;
          const result = await libraryIndexService.recordCandidates([candidate], owner, assertCurrent, validateIndexed);
          assertCurrent();
          return result.recorded === 1;
        },
      },
      getAgentDefaultInput: (owner, deviceId, agentId) => {
        try {
          const agent = getCoworkStore().getVisibleAgent(agentId, owner);
          const resolved = models.resolveRuntime(owner, deviceId, agent?.model || resolveDefaultAgentModelRef());
          const thinking = agent?.thinkingLevel || resolved.item.thinking.default || null;
          return { modelRef: resolved.item.modelRef, modelVersion: resolved.item.version,
            thinkingLevel: thinking && resolved.item.thinking.options.includes(thinking) ? thinking : null };
        } catch { return { modelRef: null, modelVersion: null, thinkingLevel: null }; }
      },
      agentOwnership: getCoworkStore().agentOwnership,
      expertAvatars: {
        getEndpoint: deps.expertEndpoint,
        resolveIcon: url => deps.expertAvatar(url),
      },
      registrationIdentities: new RemoteRegistrationIdentityStore(app.getPath('appData'), app.getPath('userData'), safeStorage, identity),
      store: getCoworkStore().remote, identity, getOwner: getCurrentRemoteOwner, getDisplayOwner: deps.displayOwner, getApiBaseUrl: getServerApiBaseUrl,
      getRouteEpoch: deps.routeEpoch,
      metadata: { name: os.hostname(), hostName: os.hostname(), instanceLabel: path.basename(app.getPath('userData')),
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux', appVersion: app.getVersion() },
      request: async (owner, pathname, init) => {
        if (!sameOwner(owner, getCurrentRemoteOwner())) throw new Error('Account changed');
        return deps.fetchWithAuth(`${getServerApiBaseUrl()}${pathname}`, { ...init, headers: { ...deps.headers(), ...init.headers } }, remoteNetworkTransport.queuedFetch);
      },
      getAgentWorkspace: async agentId => {
        const agent = getCoworkStore().getVisibleAgent(agentId, getCurrentRemoteOwner());
        const configured = agent?.workingDirectory?.trim() || getCoworkStore().getConfig().workingDirectory.trim();
        const candidate = configured ? path.resolve(configured) : '';
        try {
          if (!agent || !candidate || !(await fs.promises.stat(candidate)).isDirectory()) throw new Error('Workspace unavailable');
          await fs.promises.access(candidate, fs.constants.R_OK | fs.constants.W_OK);
          const canonicalPath = await fs.promises.realpath(candidate);
          return { path: canonicalPath, name: path.basename(canonicalPath) || os.hostname(), available: true };
        } catch {
          return { path: candidate, name: path.basename(candidate) || os.hostname(), available: false };
        }
      },
      getDefaultWorkspace: async () => {
        const candidate = path.resolve(deps.defaultCwd());
        try {
          return { ...await prepareDefaultWorkspace(candidate, path.join(os.homedir(), 'lobsterai', 'project')), available: true };
        } catch {
          return { path: candidate, name: path.basename(candidate) || os.hostname(), available: false };
        }
      },
      onStateChange: deps.changed,
      runSessionTransaction: operation => getCoworkStore().runSessionTransaction(operation),
      prepare: (command, owner, workspace) => commands.prepare(command, owner, workspace),
      execute: (entry, stillPermitted) => commands.execute(entry, stillPermitted),
      supportsCommand: deps.supportsCommand,
      supportsQuestions: () => deps.supportsCommand(RemoteCommandKind.QuestionResponse),
      reconcileQuestion: entry => commands.reconcileQuestion(entry),
      supportsDualApproval: () => deps.supportsCommand(RemoteCommandKind.ApprovalResponse),
      configureDualApproval: options => deps.runtime().configureDualApproval?.(options),
      reconcileApproval: entry => commands.reconcileApproval(entry),
      onAccountChange: (previous, current) => commands.accountChanged(previous, current),
    });
    cleanup.push(() => remoteBridge?.stop());
    remoteBridge.start();
    const detachSettingsReader = attachDshRemoteAgentSettingsReader({
      store: getCoworkStore(), owner: getCurrentRemoteOwner, routeEpoch: deps.routeEpoch,
      protocol: () => remoteBridge?.agentSettingsProtocol() ?? null, assertActiveTurn: deps.assertSettingsTurn,
    });
    cleanup.push(detachSettingsReader);
    deps.disposeSecurity(() => { detachSettingsReader(); security.close(); });
    return remoteBridge;
  } catch (error) {
    for (const close of cleanup.reverse()) {
      try { close(); } catch { /* Preserve the initialization failure. */ }
    }
    throw error;
  }
}
