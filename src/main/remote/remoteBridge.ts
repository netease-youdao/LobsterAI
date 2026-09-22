import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { resolve } from 'path';

import { AgentOwnerKind } from '../../shared/agent/constants';
import type { ApprovalDecisionOutcome } from '../../shared/cowork/approval';
import { OwnershipSyncState, OwnershipTargetKind } from '../../shared/ownership/constants';
import type { OwnershipTarget } from '../../shared/ownership/types';
import { REMOTE_CONNECTION_MANAGEMENT_CAPABILITY, RemoteConnectionReasonCode, type RemoteConnectionRemoveRequest, type RemoteConnectionResumeRequest, RemoteDeviceAdmissionState, type RemoteDeviceConnection, RemoteDeviceConnectionState } from '../../shared/remote/connections';
import { REMOTE_AGENT_CATALOG_BYTES, REMOTE_AGENT_CATALOG_ITEMS, REMOTE_PROTOCOL_VERSION, REMOTE_TEXT_BYTES, type RemoteAgentCatalogItem, RemoteCapability, RemoteConnectionReason, type RemoteConnectionReasonValue, RemoteConnectionStatus, type RemoteOwner, type RemoteSettingsState, RemoteSyncConflict, type RemoteSyncHealth, RemoteSyncHealthReason, RemoteSyncHealthStatus, RemoteSyncStatus, type RemoteWorkspace } from '../../shared/remote/constants';
import { RemoteDeletion } from '../../shared/remote/deletions';
import type { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteFileCapability } from '../../shared/remote/files';
import { RemoteInputCapability, RemoteInputReason, RemoteInputStatus, type RemotePreparationClaim } from '../../shared/remote/input';
import { type QuestionDecisionOutcome, RemoteQuestion } from '../../shared/remote/questions';
import { REMOTE_REPLY_PROJECTION_VERSION, REMOTE_REPLY_SYNC_DELAY_MS,RemoteReplyCapability } from '../../shared/remote/reply';
import { RemoteRetention, type RetentionImport, type RetentionState } from '../../shared/remote/retention';
import { parseRemoteSyncTarget, RemoteSyncTarget, remoteSyncTargetHeaders, type RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import type { AgentOwnerStore } from '../agentOwnership';
import { OwnershipAssociationStore, type OwnershipClaimBlocks } from '../ownershipAssociationStore';
import { payloadHash, remoteError, sameOwner, stableJson } from './canonical';
import type { InputPreparationService } from './inputPreparationService';
import type { RemoteIdentity } from './installationIdentity';
import { type AgentWorkspace,RemoteAgentCatalog, RemoteAgentError } from './remoteAgentCatalog';
import { approvalCommandError, RemoteApprovalError } from './remoteApproval';
import { RemoteConnectionClient } from './remoteConnectionClient';
import { remoteDiagnostics } from './remoteDiagnostics';
import { RemoteFileSync, type RemoteFileSyncDependencies } from './remoteFileSync';
import { RemoteImportSnapshotError, RemoteImportSnapshots } from './remoteImportSnapshots';
import type { ImportPartIndex } from './remoteImportSnapshotWorker';
import { RemoteInputError, type RemoteModelCatalog } from './remoteModelCatalog';
import { RemoteQuestionError } from './remoteQuestionService';
import { RemoteReplyTransport } from './remoteReplyTransport';
import { RemoteSyncStateError, retentionSequence } from './remoteRetention';
import { RemoteSessionDeletionClient, type SessionDeletionDependencies } from './remoteSessionDeletionClient';
import { type ProjectionRecord, RemoteStore, type SyncRow } from './remoteStore';
import { REMOTE_SYNC_REQUEST_ID_HEADER, remoteSyncErrorMetadata, remoteSyncRequestId, remoteSyncRequestMetadata, remoteSyncResultMetadata } from './remoteSyncLog';
import { RemoteSyncTargetActivationKind, RemoteSyncTargetStore } from './remoteSyncTargetStore';

export interface RemoteCommand {
  commandId: string; type: string; sessionId?: string; runId?: string; status: string; statusVersion: string;
  detailState?: string; expiresAt: string; request: any; requestHash: string; claimId?: string; claimToken?: string; claimUntil?: string;
}
export interface InboxEntry {
  targetId?: string;
  command: RemoteCommand; owner: RemoteOwner; localSessionId: string | null; remoteSessionId: string | null;
  runId: string | null; state: 'prepared' | 'executing' | 'applied' | 'rejected' | 'unknown'; result: any; preparationError?: any;
}
interface Registration { deviceId: string; userId: string; scopeKey: string; metadataVersion: string; syncTarget?: RemoteSyncTargetIdentity }
interface LocalSettings { createSessionAvailable?: boolean; enabled: boolean; name: string; workspaces: Array<RemoteWorkspace & { path: string }>; settingsVersion: string }
interface ControlIntent { createSessionAvailable?: boolean; id: string; enabled: boolean; workspaces: RemoteWorkspace[] }
interface SettingsChanges { enabled?: boolean; name?: string; workspace?: { name: string; path: string }; removeWorkspaceId?: string; retry?: boolean }
interface PendingConfiguration { route: string; changes: SettingsChanges[] }
interface SavedImport extends RetentionImport { reason?: string; projectionVersion?: number; replyProjection?: boolean; importId: string; sessionId: string; baseSourceSeq: string; snapshotEpoch: number; expectedSourceSeq: string; expectedServerSeq: string; beginConfirmed?: boolean; beginAttempted?: boolean; fileSet?: string; manifest: any; parts: Array<ImportPartIndex & { payload?: { records: ProjectionRecord[] } }>; stateVersion?: string }
export interface BridgeDependencies {
  deletion?: Pick<SessionDeletionDependencies, 'service' | 'runtime' | 'reconcileStop'>;
  security?: { available(): Promise<void>; commit<T>(operationId: string, operation: unknown, apply: () => T): Promise<T> };
  input?: { models: RemoteModelCatalog; preparations: InputPreparationService };
  files?: Pick<RemoteFileSyncDependencies, 'cacheRoot' | 'access' | 'recordArtifact'>;
  getAgentDefaultInput?(owner: RemoteOwner, deviceId: string, agentId: string): RemoteAgentCatalogItem['defaultInput'];
  store: RemoteStore; identity: RemoteIdentity;
  /** Session creation and inbox persistence share the outer commit/notification boundary. */
  runSessionTransaction<T>(operation: () => T): T;
  agentOwnership?: AgentOwnerStore;
  supportsQuestions?(): boolean;
  reconcileQuestion?(entry: InboxEntry): Promise<QuestionDecisionOutcome | null>;
  supportsDualApproval?(): boolean;
  configureDualApproval?(options: { enabled: boolean; projectionSupported: boolean }): void;
  reconcileApproval?(entry: InboxEntry): Promise<ApprovalDecisionOutcome | null>;
  getAgentWorkspace?(agentId: string): AgentWorkspace | Promise<AgentWorkspace>;
  getDefaultWorkspace?(): { path: string; name: string; available?: boolean } | Promise<{ path: string; name: string; available?: boolean }>;
  onStateChange?(): void;
  getOwner(): RemoteOwner | null;
  /** Legacy compatibility only; client mode never decides synchronization admission. */
  getEnvironment?(): RemoteEnvironment;
  getApiBaseUrl(): string;
  request(owner: RemoteOwner, pathname: string, init: RequestInit): Promise<Response>;
  metadata: { name: string; hostName: string; instanceLabel: string; platform: string; appVersion: string };
  prepare(command: RemoteCommand, owner: RemoteOwner, workspacePath: string | null): { localSessionId: string; remoteSessionId: string; runId: string | null };
  execute(entry: InboxEntry, stillPermitted: () => boolean): Promise<any>;
  onAccountChange(previous: RemoteOwner | null, current: RemoteOwner | null): void;
}
export class RemoteApiError extends Error {
  constructor(readonly code: number, message: string, readonly data: any = null, readonly httpStatus: number = 0, readonly requestId: string | null = null) { super(message); }
}
const capabilities = ['session.read', RemoteCapability.CreateSession, 'session.continue', 'run.cancel', 'approval.respond'];
const SocketFailureCode = { Transport: 1006, Protocol: 1002, PayloadTooLarge: 1009, HeartbeatTimeout: 4408 } as const;
const CONNECTION_REMOVED_CODE = 47121;
const IDLE_POLL_MS = 60000;
const COMMAND_IDLE_POLL_MS = 30000;
const ACTIVE_POLL_MS = 5000;
const CATALOG_RECHECK_MS = 300000;
export class RemoteBridge {
  private readonly deletions: RemoteSessionDeletionClient | null;
  private deletionSupported = false;
  private deletionAvailable = false;
  private owner: RemoteOwner | null = null;
  private accountGeneration = 0;
  private accountRoute: string;
  private targetId: string | null = null;
  private discoveredTarget: RemoteSyncTargetIdentity | null = null;
  private readonly targets: RemoteSyncTargetStore;
  private registration: Registration | null = null;
  private registrationPending: Promise<void> | null = null;
  private socket: WebSocket | null = null;
  private generation: string | null = null;
  private stopped = false;
  private readonly syncSkipReasons = new Map<string, string>();
  private suspended = false;
  private running = false;
  private tickRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private connectionAttempt = 0;
  private lastPong = 0;
  private heartbeatTimeout = 75000;
  private error: string | undefined;
  private errorCode: number | undefined;
  private errorRequestKey: string | undefined;
  private readonly requestErrorKeys = new WeakMap<object, string>();
  private lastGoodState: RemoteSettingsState | null = null;
  private sessionSyncFailed = false;
  private historyWork: Promise<void> | null = null;
  private historyRetryAt = 0;
  private connectionManagement = false;
  private connectionManagementKnown = false;
  private connectionManagementEnabled = false;
  private connectionManagementClusterReady = false;
  private connectionRemoved = false;
  private quotaBlocked = false;
  private connectionVersion = '0';
  private connectionPolicyCheckAt = 0;
  private receiptCursor: string | undefined;
  readonly connections: RemoteConnectionClient;
  private connectionReason: RemoteConnectionReasonValue = RemoteConnectionReason.Connecting;
  private backoff = 5000;
  private accesses: RemoteSettingsState['accessRequests'] = [];
  private scheduledAt = 0;
  private settingsQueue: Promise<unknown> = Promise.resolve();
  private retryAfter = 0;
  private sameAccountAccess = false;
  private workspaceUnavailable = false;
  private readonly agentCatalog: RemoteAgentCatalog | null;
  private readonly ownershipAssociations: OwnershipAssociationStore;
  private ownershipClaimCapability: { environment: string; owner: RemoteOwner; enabled: boolean } | null = null;
  private agentCapabilities: string[] = [];
  private declaredDualApproval = false;
  private declaredQuestions = false;
  private declaredAgentCapabilities: string[] = [];
  private agentCatalogRevision = 0;
  private publishedCatalogRevision = -1;
  private lastAgentCatalogCheck = 0;
  private lastCatalogConnection: string | null = null;
  private agentLimits = { items: REMOTE_AGENT_CATALOG_ITEMS, bytes: REMOTE_AGENT_CATALOG_BYTES };
  private lastCapabilityCheck = 0;
  private capabilitySnapshot: any = null;
  private inputCapabilities: string[] = [];
  private lastInputPublish = 0;
  private inputWork: Promise<void> | null = null;
  private commandPollAt = 0;
  private commandRetryAt = 0;
  private inputPollAt = 0;
  private inputRetryAt = 0;
  private agentCatalogRetryAt = 0;
  private readonly files: RemoteFileSync | null;
  private fileCapabilities: string[] = [];
  private projectionVersion = 1;
  private replySupported = false;
  private questionsSupported = false;
  private retentionSupported = false;
  private receiptsSupported = false;
  private capabilitiesKnown = false;
  private fenceCheckedAt = 0;
  private readonly retentionVerifiedAt = new Map<string, number>();
  private readonly replies = new RemoteReplyTransport();
  private readonly importSnapshots: RemoteImportSnapshots;
  private fileTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly deps: BridgeDependencies) {
    this.accountRoute = deps.getApiBaseUrl();
    this.targets = new RemoteSyncTargetStore(deps.store);
    this.importSnapshots = new RemoteImportSnapshots(deps.store);
    this.deletions = deps.deletion ? new RemoteSessionDeletionClient({ ...deps.deletion, store: deps.store, security: deps.security,
      context: () => this.owner && this.registration && this.targetId && sameOwner(this.owner, deps.getOwner()) ? {
        owner: this.owner, environment: this.remoteEnvironment(), deviceId: this.registration.deviceId, generation: this.generation,
        enabled: this.settings().enabled && !this.stopped && !this.syncPaused(),
      } : null,
      request: (path, method, body) => this.api(path, method, body),
    }) : null;
    this.connections = new RemoteConnectionClient({
      guard: () => {
        this.ensureAccount();
        const owner = this.owner, generation = this.accountGeneration, route = this.deps.getApiBaseUrl();
        return () => {
          if (generation !== this.accountGeneration || !sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())
            || route !== this.deps.getApiBaseUrl()) throw new Error('Account changed during connection management');
        };
      },
      ensure: async () => {
        this.ensureAccount();
        if (!this.owner) throw new Error('Sign in before managing connections');
        await this.ensureRegistration();
        if (Date.now() - this.lastCapabilityCheck > 45000) await this.refreshCapabilities();
        return this.connectionManagement || this.connectionManagementKnown;
      },
      request: (path, method, body) => this.api(path, method, body, true, 2),
      deviceId: () => this.registration?.deviceId,
      observe: value => this.observeConnection(value),
      retry: () => { if (!this.connectionRemoved) { this.retryAfter = 0; this.schedule(0); } },
    });
    this.files = deps.files ? new RemoteFileSync({ store: deps.store, ...deps.files, owner: deps.getOwner,
      environment: () => this.remoteEnvironment(), enabled: () => this.accountRoute === deps.getApiBaseUrl()
        && this.settings().enabled && !this.stopped && !this.syncPaused(),
      request: async (connection, pathname, init) => {
        const epoch = this.accountGeneration, route = deps.getApiBaseUrl();
        if (route !== this.accountRoute || !this.registration || connection.deviceId !== this.registration.deviceId || connection.generation !== this.generation
          || this.syncPaused() || !sameOwner(connection.owner, deps.getOwner()) || connection.environment !== this.remoteEnvironment() || !this.settings().enabled || this.stopped) throw new Error('FILE_WRITER_STALE');
        const response = await deps.request(connection.owner, `/api/remote/v1${pathname}`, { ...init, headers: { ...init.headers,
          ...remoteSyncTargetHeaders(this.registration.syncTarget ?? null),
          'X-Remote-Device-Credential': `${connection.deviceId}.${deps.identity.deviceKey}`, 'X-Remote-Connection-Generation': connection.generation,
          'X-Remote-Projection-Version': String(this.projectionVersion) } });
        if (epoch !== this.accountGeneration || route !== deps.getApiBaseUrl()) throw new Error('FILE_WRITER_STALE');
        return response;
      } }) : null;
    this.ownershipAssociations = new OwnershipAssociationStore(deps.store);
    deps.store.setWake((urgent?: boolean) => this.schedule(urgent ? 0 : this.replySupported ? REMOTE_REPLY_SYNC_DELAY_MS : 1000));
    this.agentCatalog = deps.agentOwnership && deps.getAgentWorkspace ? new RemoteAgentCatalog(deps.store, deps.agentOwnership, deps.getAgentWorkspace,
      (owner, deviceId, agentId) => this.inputCapabilities.includes(RemoteInputCapability.Schema) ? deps.getAgentDefaultInput?.(owner, deviceId, agentId) : undefined,
      () => this.getSyncTargetId()) : null;
    deps.agentOwnership?.subscribe(() => { this.agentCatalogRevision++; this.schedule(300); });
  }
  start(): void {
    remoteDiagnostics.start(() => {
      const health = this.state().syncHealth;
      remoteDiagnostics.gauge('pendingSessions', health?.pendingSessions ?? null);
      remoteDiagnostics.gauge('oldestPendingAgeMs', health?.oldestPendingAt ? Math.max(0, Date.now() - Date.parse(health.oldestPendingAt)) : null);
    });
    this.stopped = false; this.deps.input?.preparations.startCleanup?.(); this.accountChanged();
    if (this.files && !this.fileTimer) { this.fileTimer = setInterval(() => this.syncFiles(), 2000); this.fileTimer.unref?.(); }
  }
  private syncFiles(): void {
    if (!this.deps.store.needsSecurityRecovery() && !this.syncPaused() && this.owner && this.registration && this.generation && this.projectionVersion >= 3) this.files?.tick({ owner: this.owner,
      deviceId: this.registration.deviceId, generation: this.generation, environment: this.remoteEnvironment() });
  }
  async prepareFileRun(sessionId: string, roots: string[]): Promise<void> {
    if (!this.canCaptureRemoteFiles()) return;
    const epoch = this.accountGeneration;
    await this.files?.prepareRun(sessionId, roots, () => epoch === this.accountGeneration && !this.deps.store.needsSecurityRecovery());
  }
  canCaptureRemoteFiles(): boolean { return !this.deps.store.needsSecurityRecovery() && this.files?.canCaptureInput() === true && this.settings().enabled; }
  getInputAgentCatalog(): RemoteAgentCatalog | null { return this.agentCatalog; }
  stop(): void { this.importSnapshots.cancel(); remoteDiagnostics.stop(); this.deps.input?.preparations.stopCleanup?.(); this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.fileTimer) clearInterval(this.fileTimer); this.fileTimer = null; this.files?.pause(); this.disconnect(); }
  accountChanged(): void { this.ensureAccount(); this.schedule(0); }
  private changed(): void { try { this.deps.onStateChange?.(); } catch { console.warn('[RemoteSync] State notification deferred'); } }
  private targetKey(prefix: string): string { return `${prefix}:${this.targetId ? `${this.targetId}:` : ''}${this.owner?.userId}:${this.owner?.scopeKey}`; }
  private settingsKey(): string { return this.targetKey('settings'); }
  private controlKey(): string { return this.targetKey('controlQueue'); }
  private nameKey(): string { return this.targetKey('namePending'); }
  private pendingConfigurationKey(): string { return `pendingConfiguration:${this.owner?.userId}:${this.owner?.scopeKey}`; }
  private catalogFailureKey(): string { return `${this.targetKey('agentCatalogFailure')}:${this.registration?.deviceId}`; }
  private settings(): LocalSettings {
    const saved = this.owner ? this.deps.store.get<LocalSettings>(this.settingsKey()) : null;
    return { enabled: Boolean(this.owner), name: this.deps.metadata.hostName, workspaces: [], settingsVersion: '0', ...saved };
  }
  private controls(): ControlIntent[] { return this.deps.store.get<ControlIntent[]>(this.controlKey()) || []; }
  state(): RemoteSettingsState {
    try { const state = this.readState(); this.lastGoodState = state; return state; }
    catch {
      // Read-only settings failures must not break the shell or turn unknown health into a successful sync.
      let owner: RemoteOwner | null = null;
      try { owner = this.deps.getOwner(); } catch { /* The current account is unknown; never reuse another account's summary. */ }
      const saved = this.lastGoodState && (owner ? sameOwner(owner, this.lastGoodState.owner) : this.lastGoodState.owner === null) ? this.lastGoodState : null;
      return { ...saved, enabled: saved?.enabled ?? false, connected: false, name: saved?.name || this.deps.metadata.hostName, hostName: this.deps.metadata.hostName,
        owner, workspaces: saved?.workspaces || [], accessRequests: [], error: 'REMOTE_SETTINGS_UNAVAILABLE', syncHealth: { status: RemoteSyncHealthStatus.Degraded,
          reason: RemoteSyncHealthReason.StorageDependency, pendingSessions: null, oldestPendingAt: null,
          lastSuccessfulSyncAt: null, observedAt: new Date().toISOString() } };
    }
  }
  private readState(): RemoteSettingsState {
    const settings = this.settings();
    const connected = sameOwner(this.owner, this.deps.getOwner()) && settings.enabled && this.generation !== null && Date.now() - this.lastPong < this.heartbeatTimeout;
    const pendingSettings = this.controls().length > 0;
    const pendingName = !!this.deps.store.get(this.nameKey());
    const pending = this.owner ? this.deps.store.db.prepare(`SELECT COUNT(*) AS count,MIN(r.dirty_at) AS oldest FROM remote_sync s
      LEFT JOIN remote_session_revisions r ON r.session_id=s.local_id
      JOIN cowork_session_ownership o ON o.session_id=s.local_id
      WHERE o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=?
        AND NOT EXISTS(SELECT 1 FROM remote_state closed WHERE closed.key='deletionClosed:'||s.local_id)
        AND (s.needs_snapshot=1 OR s.source_seq>s.ack_seq OR EXISTS(SELECT 1 FROM remote_dirty d WHERE d.session_id=s.local_id))`)
      .get(this.owner.userId, this.owner.scopeKey) as { count: number; oldest: number | null } : null;
    const recoveryRequired = this.deps.store.needsSecurityRecovery();
    const projectionFailed = !!this.owner && !!this.deps.store.db.prepare(`SELECT 1 FROM remote_projection_failures f JOIN cowork_session_ownership o ON o.session_id=f.session_id WHERE o.owner_user_id=? AND o.owner_scope_key=? LIMIT 1`).get(this.owner.userId, this.owner.scopeKey);
    const filesHealth = this.files?.health();
    const filesDegraded = filesHealth?.degraded === true;
    const reason = recoveryRequired ? RemoteSyncHealthReason.LocalRecovery : this.connectionRemoved ? RemoteSyncHealthReason.Removed : this.quotaBlocked ? RemoteSyncHealthReason.Quota
      : (this.sessionSyncFailed || projectionFailed) ? RemoteSyncHealthReason.Projection : filesDegraded ? RemoteSyncHealthReason.Files : settings.enabled && !connected ? RemoteSyncHealthReason.Connection : undefined;
    // History scans also run when idle; only outstanding content should change the device's visible sync status.
    const syncHealth: RemoteSyncHealth = {
      status: recoveryRequired ? RemoteSyncHealthStatus.Paused : !this.owner || !settings.enabled || this.connectionRemoved || this.quotaBlocked ? RemoteSyncHealthStatus.Paused
        : this.sessionSyncFailed || projectionFailed || filesDegraded ? RemoteSyncHealthStatus.Degraded : (pending?.count || 0) > 0 || (filesHealth?.pending || 0) > 0 ? RemoteSyncHealthStatus.Syncing : RemoteSyncHealthStatus.Idle,
      ...(reason ? { reason } : {}), pendingSessions: pending?.count ?? null, oldestPendingAt: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
      lastSuccessfulSyncAt: this.owner ? this.deps.store.get<string>(`lastSuccessfulSync:${this.owner.userId}:${this.owner.scopeKey}`) : null,
      observedAt: new Date().toISOString(),
    };
    return { syncHealth, enabled: settings.enabled, connected, deviceConnectionManagementSupported: this.capabilitiesKnown || this.connectionManagementKnown ? this.connectionManagement || this.connectionManagementKnown : undefined, deviceConnectionManagementEnabled: this.connectionManagementEnabled, deviceConnectionManagementClusterReady: this.connectionManagementClusterReady, deviceId: this.registration?.deviceId,
      name: settings.name, hostName: this.deps.metadata.hostName, owner: this.owner,
      connectionStatus: connected ? RemoteConnectionStatus.Online : RemoteConnectionStatus.Offline,
      connectionReason: !this.owner ? RemoteConnectionReason.SignedOut : !settings.enabled ? RemoteConnectionReason.Disabled : this.connectionRemoved ? RemoteConnectionReason.Removed : this.quotaBlocked ? RemoteConnectionReason.QuotaBlocked : this.workspaceUnavailable && !this.error ? RemoteConnectionReason.WorkspaceUnavailable : this.connectionReason,
      settingsSyncStatus: pendingSettings ? RemoteSyncStatus.Pending : RemoteSyncStatus.Synced,
      nameSyncStatus: pendingName ? RemoteSyncStatus.Pending : RemoteSyncStatus.Synced,
      agentCatalogSyncStatus: this.owner && this.deps.store.get(this.catalogFailureKey()) ? RemoteSyncStatus.Error : RemoteSyncStatus.Synced,
      sessionSyncStatus: this.sessionSyncFailed ? RemoteSyncStatus.Error : RemoteSyncStatus.Synced,
      workspaces: settings.workspaces.map(({ path: _path, ...w }) => w), error: this.error, errorCode: this.errorCode, accessRequests: this.accesses };
  }
  associationSyncState(target: OwnershipTarget): OwnershipSyncState {
    const currentOwner = this.deps.getOwner();
    if (!currentOwner) return OwnershipSyncState.Local;
    if (target.kind === OwnershipTargetKind.Task) {
      if (!sameOwner(this.deps.store.owner(target.id), currentOwner)) return OwnershipSyncState.Local;
    } else {
      const identity = this.deps.agentOwnership?.get(target.id);
      if (identity?.ownerKind !== AgentOwnerKind.Owned || !sameOwner(identity.owner, currentOwner)) return OwnershipSyncState.Local;
    }
    if (!this.owner || !sameOwner(this.owner, currentOwner)) return OwnershipSyncState.Pending;
    if (!this.registration) return OwnershipSyncState.Pending;
    // Reading UI state must not grant an operation its first durable remote admission.
    const blocked = this.ownershipClaimBlocks(false);
    const waiting = target.kind === OwnershipTargetKind.Agent ? blocked.blockedAgentIds.has(target.id) : this.ownershipSyncBlocked(target.id, blocked);
    if (waiting) return !this.settings().enabled || this.canAdmitOwnershipClaim() ? OwnershipSyncState.Pending : OwnershipSyncState.WaitingService;
    if (target.kind === OwnershipTargetKind.Agent) {
      if (this.deps.store.get(this.catalogFailureKey())) return OwnershipSyncState.Failed;
      return this.agentCatalog?.isSynced(this.owner, this.registration.deviceId, target.id) ? OwnershipSyncState.Synced : OwnershipSyncState.Pending;
    }
    if (this.deps.store.get(`syncFailure:${target.id}`)) return OwnershipSyncState.Failed;
    const row = this.deps.store.sync(target.id);
    const dirty = this.deps.store.db.prepare('SELECT session_id FROM remote_dirty WHERE session_id=?').get(target.id);
    return row && row.device_id === this.registration.deviceId && !row.needs_snapshot && row.source_seq === row.ack_seq
      && !dirty && !this.deps.store.get(`import:${target.id}`) ? OwnershipSyncState.Synced : OwnershipSyncState.Pending;
  }
  async configure(changes: SettingsChanges): Promise<RemoteSettingsState> {
    this.ensureAccount();
    if (!this.owner) throw new Error('Sign in before enabling remote control');
    const settings = this.settings();
    const wasEnabled = settings.enabled;
    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(changes.name)) throw new Error('Invalid device name');
      settings.name = name;
    }
    if (changes.enabled !== undefined) settings.enabled = changes.enabled;
    if (changes.workspace && !settings.workspaces.some(w => w.path === changes.workspace!.path)) settings.workspaces.push({ workspaceId: randomUUID(), ...changes.workspace, available: true });
    // Keep IDs as tombstones: accepted commands must never be redirected to a different path.
    if (changes.removeWorkspaceId) settings.workspaces = settings.workspaces.map(w => w.workspaceId === changes.removeWorkspaceId ? { ...w, available: false } : w);
    this.deps.store.transaction(() => {
      this.deps.store.put(this.settingsKey(), settings);
      if (changes.name !== undefined) this.deps.store.put(this.nameKey(), { id: randomUUID(), name: settings.name });
      if (changes.enabled !== undefined || changes.workspace || changes.removeWorkspaceId) this.queueControl(settings);
      if (!this.targetId && (changes.enabled !== undefined || changes.name !== undefined || changes.workspace || changes.removeWorkspaceId)) {
        const key = this.pendingConfigurationKey(), previous = this.deps.store.get<PendingConfiguration>(key);
        const deferred: SettingsChanges = { ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
          ...(changes.name !== undefined ? { name: changes.name } : {}), ...(changes.workspace ? { workspace: changes.workspace } : {}),
          ...(changes.removeWorkspaceId ? { removeWorkspaceId: changes.removeWorkspaceId } : {}) };
        this.deps.store.put(key, { route: this.accountRoute,
          changes: [...(previous?.route === this.accountRoute ? previous.changes : []), deferred] });
      }
    });
    this.retryAfter = 0;
    if (changes.retry || changes.enabled === true && !wasEnabled) {
      this.suspended = false; this.backoff = 5000;
      this.error = undefined; this.errorCode = undefined; this.errorRequestKey = undefined;
      this.connectionReason = RemoteConnectionReason.Reconnecting;
      if (changes.retry) {
      this.deps.store.retryProjections();
        this.deps.store.transaction(() => {
          for (const row of this.deps.store.sessions(this.owner!)) this.deps.store.remove(`syncFailure:${row.local_id}`);
          this.deps.store.remove(this.catalogFailureKey());
        });
        this.sessionSyncFailed = false;
        this.publishedCatalogRevision = -1; this.lastAgentCatalogCheck = 0; this.lastCapabilityCheck = 0;
        this.disconnect();
      }
    }
    if (!settings.enabled) { this.deps.store.setEnabledOwner(null); this.disconnect(); }
    this.changed(); this.schedule(0);
    // A successful local save is independent of network availability. The durable queues retry in tick().
    return this.state();
  }
  async decide(requestId: string, decision: 'approve' | 'deny'): Promise<RemoteSettingsState> {
    const key = `decision:${requestId}`;
    const saved = this.deps.store.get<any>(key) || { decisionId: randomUUID(), decision };
    if (saved.decision !== decision) throw new Error('This access request already has a pending decision');
    this.deps.store.put(key, saved);
    await this.api(`/access-requests/${encodeURIComponent(requestId)}/decision`, 'POST', saved);
    this.deps.store.remove(key);
    await this.pollAccess(); this.changed();
    return this.state();
  }
  private ensureAccount(): void {
    const current = this.deps.getOwner();
    const route = this.deps.getApiBaseUrl();
    if (route === this.accountRoute && ((current === null && this.owner === null) || sameOwner(current, this.owner))) return;
    const previous = this.owner;
    this.accountGeneration++; this.importSnapshots.cancel();
    this.accountRoute = route; this.targetId = null; this.discoveredTarget = null;
    this.agentCatalog?.reset(); this.deps.input?.preparations.reset?.();
    this.connections.reset(); this.lastGoodState = null; this.lastInputPublish = 0;
    this.owner = current; this.registration = null; this.registrationPending = null;
    this.retryAfter = 0; this.suspended = false; this.accesses = []; this.sessionSyncFailed = false;
    this.agentCapabilities = []; this.declaredAgentCapabilities = []; this.lastCatalogConnection = null; this.publishedCatalogRevision = -1; this.lastCapabilityCheck = 0; this.deps.store.setAgentSummaryResolver(null);
    this.inputCapabilities = [];
    this.ownershipClaimCapability = null;
    this.connectionManagementEnabled = false; this.connectionManagementClusterReady = false;
    this.connectionManagement = false; this.connectionManagementKnown = current ? this.savedConnectionState<boolean>(':supported') === true : false; this.connectionRemoved = false; this.quotaBlocked = false; this.connectionVersion = '0'; this.connectionPolicyCheckAt = 0;
    const connection = current ? this.savedConnectionState<{ state: string; version: string }>() : null;
    if (connection) { this.connectionRemoved = connection.state === RemoteDeviceConnectionState.Removed; this.connectionVersion = connection.version; }
    this.sameAccountAccess = false; this.workspaceUnavailable = false; this.error = undefined; this.errorCode = undefined; this.errorRequestKey = undefined;
    this.connectionReason = RemoteConnectionReason.Connecting;
    this.deps.store.setEnabledOwner(null); this.disconnect();
    this.declaredDualApproval = false; this.deps.store.setApprovalProjectionSupported(false);
    this.deletionSupported = false; this.deletionAvailable = false; this.deps.store.setDeletionProjectionSupported(false);
    this.fileCapabilities = []; this.declaredQuestions = false; this.questionsSupported = false; this.deps.store.setQuestionProjectionSupported(false); this.replySupported = false; this.replies.clear(); this.projectionVersion = 1; this.files?.configure(false);
    this.retentionSupported = false; this.receiptsSupported = false; this.capabilitiesKnown = false; this.fenceCheckedAt = 0; this.retentionVerifiedAt.clear();
    this.deps.configureDualApproval?.({ enabled: false, projectionSupported: false });
    this.deps.onAccountChange(previous, current); this.changed();
  }
  private connectionStateKey(): string { return `deviceConnection:${this.remoteEnvironment()}:${this.owner?.userId}:${this.owner?.scopeKey}`; }
  private savedConnectionState<T>(suffix = ''): T | null {
    return this.deps.store.get<T>(`${this.connectionStateKey()}${suffix}`);
  }
  private syncPaused(): boolean { return this.connectionRemoved || this.quotaBlocked; }
  private observeConnection(value: Pick<RemoteDeviceConnection, 'deviceId' | 'connectionState' | 'connectionVersion'> & Partial<RemoteDeviceConnection>): void {
    if (value.deviceId !== this.registration?.deviceId || !/^[1-9]\d*$/u.test(value.connectionVersion)
      || BigInt(value.connectionVersion) < BigInt(this.connectionVersion)) return;
    if (![RemoteDeviceConnectionState.Allowed, RemoteDeviceConnectionState.Removed].includes(value.connectionState)) throw new Error('Invalid device connection state');
    const wasRemoved = this.connectionRemoved;
    if (wasRemoved && value.connectionState === RemoteDeviceConnectionState.Allowed
      && BigInt(value.connectionVersion) <= BigInt(this.connectionVersion)) return;
    this.connectionVersion = value.connectionVersion;
    this.connectionRemoved = value.connectionState === RemoteDeviceConnectionState.Removed;
    this.deps.store.put(this.connectionStateKey(), { state: value.connectionState, version: value.connectionVersion });
    if (this.connectionRemoved) {
      this.connectionReason = RemoteConnectionReason.Removed; this.files?.pause(); this.disconnect();
    } else {
      if (wasRemoved) { this.suspended = false; this.retryAfter = 0; this.error = undefined; this.errorCode = undefined; this.errorRequestKey = undefined; this.schedule(0); }
      if (!this.generation && value.admissionState === RemoteDeviceAdmissionState.QuotaBlocked) {
        this.quotaBlocked = true; this.connectionReason = RemoteConnectionReason.QuotaBlocked;
      }
    }
    this.changed();
  }
  queryConnections() { return this.connections.query(); }
  removeConnection(input: RemoteConnectionRemoveRequest) { return this.connections.remove(input); }
  resumeCurrentConnection(input: RemoteConnectionResumeRequest) { return this.connections.resume(input); }
  queryConnectionOperation(requestId: string) { return this.connections.operation(requestId); }
  private queueControl(settings: LocalSettings): void {
    const pending = this.controls();
    const value = { createSessionAvailable: settings.createSessionAvailable !== false, enabled: settings.enabled, workspaces: settings.workspaces.map(({ path: _path, ...w }) => w) };
    if (pending.length && stableJson({ createSessionAvailable: pending.at(-1)!.createSessionAvailable !== false, enabled: pending.at(-1)!.enabled, workspaces: pending.at(-1)!.workspaces }) === stableJson(value)) return;
    pending.push({ id: randomUUID(), ...value });
    this.deps.store.put(this.controlKey(), pending);
  }
  private async ensureDefaultWorkspace(): Promise<void> {
    if (!this.deps.getDefaultWorkspace) return;
    const owner = this.owner;
    const accountGeneration = this.accountGeneration;
    const directory = await this.deps.getDefaultWorkspace();
    if (accountGeneration !== this.accountGeneration || !sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())) return;
    const settings = this.settings();
    const previous = stableJson(settings.workspaces);
    const couldCreate = settings.createSessionAvailable !== false;
    const normalized = resolve(directory.path);
    let workspace = settings.workspaces.find(w => resolve(w.path) === normalized);
    if (!workspace) {
      if (settings.workspaces.length >= 50) {
        this.workspaceUnavailable = true;
        if (couldCreate) {
          settings.createSessionAvailable = false;
          this.deps.store.transaction(() => { this.deps.store.put(this.settingsKey(), settings); this.queueControl(settings); });
        }
        return;
      }
      workspace = { workspaceId: randomUUID(), name: directory.name, path: normalized, available: true };
      settings.workspaces.push(workspace);
    }
    settings.createSessionAvailable = true;
    for (const item of settings.workspaces) {
      try { item.available = statSync(item.path).isDirectory(); } catch { item.available = false; }
    }
    if (directory.available === false) workspace.available = false;
    this.workspaceUnavailable = !workspace.available;
    workspace.name = directory.name;
    settings.workspaces = [workspace, ...settings.workspaces.filter(w => w !== workspace)];
    if (!couldCreate || stableJson(settings.workspaces) !== previous) this.deps.store.transaction(() => {
      this.deps.store.put(this.settingsKey(), settings); this.queueControl(settings);
    });
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.running && delay <= 1000) { this.tickRequested = true; return; }
    const due = Date.now() + delay;
    if (this.timer && this.scheduledAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduledAt = due;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, delay);
    this.timer.unref?.();
  }
  private startDeletionSync(): void {
    const declared = this.deletionSupported || !!(this.owner && this.deps.store.get<boolean>(`deletionCapability:${this.remoteEnvironment()}:${this.owner.userId}:${this.owner.scopeKey}`));
    if (this.deletions && declared) void this.deletions.poll(declared, this.deletionAvailable)
      .catch((): void => undefined).finally(() => { if (!this.stopped) this.schedule(this.deletions!.retryDelay()); });
  }
  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let owner = this.owner;
    let accountGeneration = this.accountGeneration;
    let nextPollDelay: number | undefined;
    let pollCommands = false;
    try {
      this.ensureAccount(); owner = this.owner; accountGeneration = this.accountGeneration;
      this.startDeletionSync();
      if (this.deps.security) await this.deps.security.available();
      if (!owner || this.suspended && !this.connectionRemoved) { this.backoff = 5000; return; }
      if (Date.now() < this.retryAfter) { if (this.syncPaused()) await this.reconcilePaused(); this.backoff = this.retryAfter - Date.now(); return; }
      if (this.targetId && !this.settings().enabled && !this.controls().length && !this.deps.store.get(this.nameKey())) { this.backoff = 30000; return; }
      await this.ensureRegistration();
      if (this.settings().enabled) {
        try { await this.ensureDefaultWorkspace(); }
        catch { this.workspaceUnavailable = true; }
      }
      if (Date.now() - this.lastCapabilityCheck > 45000) await this.refreshCapabilities();
      await this.writeSettings();
      this.startDeletionSync();
      if (this.connectionManagementKnown && !this.connectionRemoved && !this.generation && Date.now() >= this.connectionPolicyCheckAt) {
        this.connectionPolicyCheckAt = Date.now() + 30000;
        await this.connections.query();
      }
      if (this.connectionRemoved) { await this.reconcilePaused(); this.backoff = 30000; return; }
      if (!sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())) return;
      if (!this.settings().enabled) { this.backoff = 30000; return; }
      if (!this.sameAccountAccess) throw new RemoteApiError(47000, 'Server upgrade required for same-account remote access');
      this.retryAfter = 0;
      this.deps.store.setEnabledOwner(this.owner);
      this.deps.store.expireApprovals();
      this.deps.store.transaction((): void => undefined);
      if (!this.socket) {
        try { await this.connect(); }
        catch (error) {
          if (error instanceof RemoteApiError && ![47022, 47011].includes(error.code)) throw error;
          this.recordConnectionFailure(error);
        }
      }
      if (this.syncPaused()) { await this.reconcilePaused(); this.backoff = Math.max(30000, this.retryAfter - Date.now()); return; }
      if (this.connectionManagementKnown && !this.generation) { this.backoff = 5000; return; }
      if (this.generation && this.agentCatalog && this.agentCapabilities.includes(RemoteCapability.AgentCatalog)
        && Date.now() >= this.agentCatalogRetryAt
        && (this.agentCatalogRevision !== this.publishedCatalogRevision || this.lastCatalogConnection !== this.generation || Date.now() - this.lastAgentCatalogCheck > CATALOG_RECHECK_MS)) {
        const revision = this.agentCatalogRevision;
        const connection = this.generation;
        const environment = this.remoteEnvironment();
        try { await this.agentCatalog.publish(owner, this.registration!.deviceId, this.generation,
          (path, method, body) => this.api(path, method, body), () => accountGeneration === this.accountGeneration && connection === this.generation && sameOwner(owner, this.owner) && sameOwner(owner, this.deps.getOwner()) && environment === this.remoteEnvironment(), this.agentLimits,
          agentId => !this.ownershipClaimBlocks().blockedAgentIds.has(agentId));
          this.publishedCatalogRevision = revision; this.lastCatalogConnection = connection; this.lastAgentCatalogCheck = Date.now();
          this.deps.store.remove(this.catalogFailureKey()); }
        catch (error) {
          if (accountGeneration !== this.accountGeneration || connection !== this.generation || !sameOwner(owner, this.deps.getOwner())) return;
          this.agentCatalogRetryAt = Date.now() + IDLE_POLL_MS;
          // Authentication failures still use the connection gate; catalog failures are independent of WS health.
          if (error instanceof RemoteApiError && [401, 40100, 403, 47000, 47013, 47023].includes(error.code)) throw error;
          const code = error instanceof RemoteApiError || error instanceof RemoteAgentError ? error.code : 47019;
          this.deps.store.put(this.catalogFailureKey(), { code });
          console.warn('[RemoteSync] Agent catalog synchronization failed', { deviceId: this.registration?.deviceId,
            connectionGeneration: connection, ...remoteSyncErrorMetadata(error) });
        }
      }
      if (Date.now() >= Math.max(this.commandPollAt, this.commandRetryAt)) {
        pollCommands = true;
        // Set the next deadline before awaiting: a notification during I/O must remain pending.
        this.commandPollAt = Date.now() + (this.hasActiveWork() ? ACTIVE_POLL_MS : COMMAND_IDLE_POLL_MS);
        const generation = this.generation;
        try {
          await this.reconcile();
        } catch (error) {
          if (accountGeneration === this.accountGeneration && generation === this.generation) this.commandRetryAt = Date.now() + IDLE_POLL_MS;
          throw error;
        }
      }
      this.startDeletionSync();
      this.startHistorySync();
      this.syncFiles();
      if (this.generation && this.inputCapabilities.includes(RemoteInputCapability.Schema) && this.deps.input) {
        if (Date.now() - this.lastInputPublish > 15000) {
          await this.deps.input.models.publish(owner, this.registration!.deviceId, this.generation,
            (pathname, method, body) => this.api(pathname, method, body), () => accountGeneration === this.accountGeneration && sameOwner(owner, this.deps.getOwner()));
          this.lastInputPublish = Date.now();
        }
        if (!this.inputWork && Date.now() >= Math.max(this.inputPollAt, this.inputRetryAt)) {
          this.inputPollAt = Date.now() + IDLE_POLL_MS;
          const generation = this.generation;
          const current = (): boolean => accountGeneration === this.accountGeneration && generation === this.generation && sameOwner(owner, this.owner);
          const work = this.prepareInputs().then(processed => {
            if (processed && current()) this.inputPollAt = 0;
          }).catch(() => {
            if (current()) this.inputRetryAt = Date.now() + IDLE_POLL_MS;
          }).finally(() => {
            if (this.inputWork === work) this.inputWork = null;
            // Only drain a known backlog/notification promptly; an empty poll must remain idle.
            if (current()) this.schedule(Math.max(0, Math.max(this.inputPollAt, this.inputRetryAt) - Date.now()));
          });
          this.inputWork = work;
        }
      }
      if (pollCommands && this.generation) {
        const generation = this.generation;
        try { if (await this.claim()) this.commandPollAt = 0; }
        catch (error) {
          if (accountGeneration === this.accountGeneration && generation === this.generation) this.commandRetryAt = Date.now() + IDLE_POLL_MS;
          throw error;
        }
      }
      this.backoff = this.hasActiveWork() ? ACTIVE_POLL_MS : COMMAND_IDLE_POLL_MS;
      this.commandPollAt = Math.min(this.commandPollAt, Date.now() + this.backoff);
      nextPollDelay = Math.min(this.backoff, Math.max(0, Math.max(this.commandPollAt, this.commandRetryAt) - Date.now()));
      if (this.generation && !this.inputWork && this.inputCapabilities.includes(RemoteInputCapability.Schema) && this.deps.input)
        nextPollDelay = Math.min(nextPollDelay, Math.max(0, Math.max(this.inputPollAt, this.inputRetryAt) - Date.now()));
    } catch (error) {
      if (!sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) return;
      console.warn('[RemoteSync] Bridge cycle deferred', { deviceId: this.registration?.deviceId ?? null,
        connectionGeneration: this.generation, ...remoteSyncErrorMetadata(error) });
      this.recordConnectionFailure(error);
      if (this.suspended) this.disconnect();
      if (error instanceof RemoteApiError && [404, 47000].includes(error.code)) {
        this.retryAfter = Date.now() + 60000; this.backoff = 60000;
        if (!this.sameAccountAccess) this.registration = null;
      } else this.backoff = Math.min(60000, this.backoff * 2);
    } finally {
      this.running = false; this.changed();
      const accountChanged = owner === null ? this.owner !== null : !sameOwner(owner, this.owner);
      const immediate = accountChanged || this.tickRequested; this.tickRequested = false;
      this.schedule(immediate ? 0 : (nextPollDelay ?? this.backoff) + Math.floor(Math.random() * 1000));
    }
  }
  private hasActiveWork(): boolean {
    return this.deps.store.entries<InboxEntry>('inbox:').some(row => this.isEntryCurrent(row.value) && ['prepared', 'executing', 'unknown'].includes(row.value.state))
      || !!this.owner && this.deps.store.sessions(this.owner).some(row => { const run = this.deps.store.run(row.local_id); return run && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status); });
  }
  private recordConnectionFailure(error: unknown): void {
    this.errorRequestKey = error !== null && typeof error === 'object' ? this.requestErrorKeys.get(error) : undefined;
    this.errorCode = error instanceof RemoteApiError ? error.code : undefined;
    this.error = error instanceof RemoteApiError ? `${error.code}: ${error.message}` : 'Remote connection is temporarily unavailable';
    if (error instanceof RemoteApiError && error.code === 47022) {
      this.quotaBlocked = true; this.connectionReason = RemoteConnectionReason.QuotaBlocked;
      this.retryAfter = Date.now() + Math.max(30000, Math.min(300000, Number(error.data?.retryAfterMs) || 30000)) + Math.floor(Math.random() * 10000);
      this.files?.pause();
    } else if (this.connectionRemoved) this.connectionReason = RemoteConnectionReason.Removed;
    else if (this.connectionReason !== RemoteConnectionReason.ServerUpgradeRequired) this.connectionReason = RemoteConnectionReason.ServerUnavailable;
    if (error instanceof RemoteApiError && [47013, 47023].includes(error.code)) {
      this.suspended = true; this.connectionReason = RemoteConnectionReason.DeviceUnavailable;
    }
  }
  private failSocket(code: number, message: string): void {
    this.recordConnectionFailure(new RemoteApiError(code, message));
    this.disconnect(); this.schedule(this.backoff);
  }
  private async api(pathname: string, method = 'GET', body?: unknown, registrationRequired = true, version = 1, encodedBody?: string): Promise<any> {
    const owner = this.owner;
    const accountGeneration = this.accountGeneration;
    const environment = this.remoteEnvironment();
    const route = this.deps.getApiBaseUrl();
    if (route !== this.accountRoute) { this.ensureAccount(); throw new Error('Remote route changed before request'); }
    const requestKey = `${version}:${method}:${pathname.split('?')[0]}`;
    if (this.syncPaused() && (pathname.startsWith('/sync/') || /\/(?:agents|models|input-preparations)(?:\/|$)/u.test(pathname)
      || pathname.includes('/reply-content/') || /\/sessions\/[^/]+\/contents(?:\/|$)/u.test(pathname) || pathname.endsWith('/commands/claim'))) throw new RemoteApiError(
      this.connectionRemoved ? CONNECTION_REMOVED_CODE : 47022, 'Connection synchronization is paused');
    if (!owner || !sameOwner(owner, this.deps.getOwner())) throw new Error('Account changed');
    const sync = remoteSyncRequestMetadata(pathname, body);
    const requestId = sync ? randomUUID() : null;
    const startedAt = Date.now();
    let stage = 'prepare', httpStatus: number | null = null, responseRequestId: string | null = null;
    const context = { ...sync, requestId, deviceId: this.registration?.deviceId ?? null };
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json',
        ...remoteSyncTargetHeaders(pathname === '/capabilities' ? null : this.registration?.syncTarget ?? this.discoveredTarget) };
      if (requestId) headers[REMOTE_SYNC_REQUEST_ID_HEADER] = requestId;
      // Capability discovery always uses v1 so an older server can negotiate safely.
      if (pathname !== '/capabilities' && this.projectionVersion > 1) headers['X-Remote-Projection-Version'] = String(this.projectionVersion);
      if (registrationRequired) {
        if (!this.registration) throw new Error('Device is not registered');
        headers['X-Remote-Device-Credential'] = `${this.registration.deviceId}.${this.deps.identity.deviceKey}`;
      }
      const encoded = encodedBody ?? (body === undefined ? undefined : stableJson(body));
      if (sync) console.debug('[RemoteSync] Request started', { ...context, requestBytes: encoded ? Buffer.byteLength(encoded) : 0 });
      stage = 'transport';
      const response = await this.deps.request(owner, `/api/remote/v${version}${pathname}`, { method, headers, body: encoded, signal: AbortSignal.timeout(20000) });
      httpStatus = response.status;
      responseRequestId = remoteSyncRequestId(response.headers.get(REMOTE_SYNC_REQUEST_ID_HEADER));
      if (accountGeneration !== this.accountGeneration || route !== this.deps.getApiBaseUrl() || environment !== this.remoteEnvironment() || !sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) throw new Error('Account changed during remote request');
      stage = 'response';
      const text = await response.text();
      if (accountGeneration !== this.accountGeneration || route !== this.deps.getApiBaseUrl() || environment !== this.remoteEnvironment() || !sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) throw new Error('Account changed during remote response');
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Remote response is too large');
      let result: any;
      try { result = JSON.parse(text); } catch { throw new RemoteApiError(response.status, 'Invalid remote response', null, response.status, responseRequestId ?? requestId); }
      if (!response.ok || result.code !== 0) throw new RemoteApiError(result.code || response.status, result.message || 'Remote request failed', result.data, response.status,
        responseRequestId ?? remoteSyncRequestId(result.data?.requestId) ?? requestId);
      if (sync) console.debug('[RemoteSync] Request succeeded', { ...context, responseRequestId, httpStatus,
        elapsedMs: Date.now() - startedAt, result: remoteSyncResultMetadata(result.data) });
      // Only the failed endpoint's successful retry proves HTTP recovery. A pong or unrelated request does not.
      if (!this.suspended && pathname !== '/connection-tickets' && this.errorRequestKey === requestKey) {
        this.error = undefined; this.errorCode = undefined; this.errorRequestKey = undefined;
        if (this.connectionReason === RemoteConnectionReason.ServerUnavailable) this.connectionReason = RemoteConnectionReason.Connecting;
      }
      return result.data;
    } catch (error) {
      if (error instanceof RemoteApiError && error.code === RemoteSyncTarget.ChangedCode && accountGeneration === this.accountGeneration) {
        this.accountRoute = '';
        this.ensureAccount();
      }
      if (accountGeneration === this.accountGeneration && environment === this.remoteEnvironment() && sameOwner(owner, this.owner) && error instanceof RemoteApiError
        && (error.code === CONNECTION_REMOVED_CODE || error.data?.reason === RemoteConnectionReasonCode.Removed)) {
        this.connectionRemoved = true; this.connectionReason = RemoteConnectionReason.Removed;
        const rejectedVersion = error.data?.connectionVersion;
        if (typeof rejectedVersion === 'string' && /^[1-9]\d*$/u.test(rejectedVersion) && BigInt(rejectedVersion) > BigInt(this.connectionVersion)) this.connectionVersion = rejectedVersion;
        this.deps.store.put(this.connectionStateKey(), { state: RemoteDeviceConnectionState.Removed, version: this.connectionVersion });
        this.files?.pause(); this.disconnect();
      }
      if (error !== null && typeof error === 'object') this.requestErrorKeys.set(error, requestKey);
      if (sync) console.debug('[RemoteSync] Request failed', { ...context, stage, responseRequestId, httpStatus,
        elapsedMs: Date.now() - startedAt, error: remoteSyncErrorMetadata(error) });
      throw error;
    }
  }
  private advertisedCapabilities(createSessionAvailable = true): string[] {
    const supported = this.declaredAgentCapabilities.includes(RemoteCapability.AgentSelection) || createSessionAvailable && this.settings().createSessionAvailable !== false ? capabilities : capabilities.filter(value => value !== RemoteCapability.CreateSession);
    return [...(this.sameAccountAccess ? [...supported, RemoteCapability.SameAccountAccess] : supported), ...this.declaredAgentCapabilities, ...this.inputCapabilities, ...this.fileCapabilities, ...(this.replySupported ? [RemoteReplyCapability] : []), ...(this.declaredQuestions ? [RemoteQuestion.Capability] : []), ...(this.retentionSupported ? [RemoteRetention.Capability] : []), ...(this.receiptsSupported ? [RemoteRetention.Receipts] : []), ...(this.declaredDualApproval ? [RemoteCapability.DualApproval] : []), ...(this.connectionManagementKnown ? [REMOTE_CONNECTION_MANAGEMENT_CAPABILITY] : []), ...(this.deletionSupported ? [RemoteDeletion.Capability] : [])];
  }
  private async ensureRegistration(): Promise<void> {
    if (this.registrationPending) return this.registrationPending;
    if (this.registration) return;
    const pending = this.register(); this.registrationPending = pending;
    try { await pending; } finally { if (this.registrationPending === pending) this.registrationPending = null; }
  }
  private async refreshCapabilities(confirmedSnapshot?: any): Promise<void> {
    const environment = this.remoteEnvironment();
    const support = confirmedSnapshot ?? await this.api('/capabilities', 'GET', undefined, false);
    if (environment !== this.remoteEnvironment()) throw new Error('Remote service environment changed');
    if (!support.enabled || !support.protocolVersions?.includes(REMOTE_PROTOCOL_VERSION)) throw new RemoteApiError(47000, 'Remote control is unavailable');
    this.sameAccountAccess = support.capabilities?.includes(RemoteCapability.SameAccountAccess) === true;
    if (!this.sameAccountAccess) {
      this.connectionReason = RemoteConnectionReason.ServerUpgradeRequired;
      // Legacy servers still receive a saved disable; never announce an unsupported capability to them.
      if (!this.controls().some(intent => !intent.enabled)) throw new RemoteApiError(47000, 'Server upgrade required for same-account remote access');
    }
    const previous = stableJson([this.declaredAgentCapabilities, this.declaredDualApproval, this.fileCapabilities, this.replySupported, this.questionsSupported, this.declaredQuestions, this.retentionSupported, this.receiptsSupported, this.connectionManagementKnown, this.deletionSupported]);
    const previousProjectionVersion = this.projectionVersion;
    const supported = Array.isArray(support.capabilities) ? support.capabilities : [];
    const target = parseRemoteSyncTarget(support.syncTarget);
    if (supported.includes(RemoteSyncTarget.Capability) && !target) throw new RemoteSyncStateError('Invalid remote data identity');
    if (this.registration?.syncTarget && stableJson(target) !== stableJson(this.registration.syncTarget)) {
      this.accountRoute = ''; this.ensureAccount();
      throw new RemoteSyncStateError('Remote data identity changed');
    }
    this.discoveredTarget = target;
    this.capabilitySnapshot = support;
    this.deletionSupported = !!this.deletions && supported.includes(RemoteDeletion.Capability);
    this.deletionAvailable = this.deletionSupported && support.sessionDeletion?.available === true;
    if (this.deletionSupported) this.deps.store.put(`deletionCapability:${environment}:${this.owner!.userId}:${this.owner!.scopeKey}`, true);
    this.connectionManagement = supported.includes(REMOTE_CONNECTION_MANAGEMENT_CAPABILITY) && support.deviceConnectionPolicy?.version === 2;
    if (support.deviceConnectionPolicy?.version === 2) { this.connectionManagementKnown = true; this.deps.store.put(`${this.connectionStateKey()}:supported`, true); }
    this.connectionManagementEnabled = support.deviceConnectionPolicy?.enabled ?? this.connectionManagement;
    this.connectionManagementClusterReady = support.deviceConnectionPolicy?.clusterReady ?? this.connectionManagement;
    this.inputCapabilities = this.deps.input ? Object.values(RemoteInputCapability).filter(value => supported.includes(value)) : [];
    this.fileCapabilities = this.files && support.projectionVersions?.includes(3) ? Object.values(RemoteFileCapability).filter(value => supported.includes(value)) : [];
    const fileSupported = this.fileCapabilities.length === Object.values(RemoteFileCapability).length;
    this.replySupported = support.projectionVersions?.includes(REMOTE_REPLY_PROJECTION_VERSION) === true && supported.includes(RemoteReplyCapability);
    this.questionsSupported = this.deps.supportsQuestions?.() === true && support.projectionVersions?.includes(RemoteQuestion.ProjectionVersion) === true && supported.includes(RemoteQuestion.Capability);
    const questionKey = this.targetKey('questionCapability');
    // Admission may close, but original accepted commands still require the protocol declaration.
    this.declaredQuestions = this.deps.store.get<boolean>(questionKey) === true || this.questionsSupported;
    if (this.declaredQuestions) this.deps.store.put(questionKey, true);
    this.retentionSupported = supported.includes(RemoteRetention.Capability) && support.syncRetention?.version === RemoteRetention.Version
      && support.syncRetention.eventIdAlgorithm === RemoteRetention.EventIdAlgorithm;
    this.receiptsSupported = supported.includes(RemoteRetention.Receipts);
    this.capabilitiesKnown = true;
    this.projectionVersion = this.questionsSupported ? RemoteQuestion.ProjectionVersion : this.replySupported ? REMOTE_REPLY_PROJECTION_VERSION : fileSupported ? 3 : this.inputCapabilities.includes(RemoteInputCapability.Schema) ? 2 : 1;
    this.files?.configure(fileSupported);
    if (this.socket && previousProjectionVersion !== this.projectionVersion) this.disconnect();

    this.agentCapabilities = this.agentCatalog && supported.includes(RemoteCapability.SessionAgent) ? [RemoteCapability.SessionAgent] : [];
    this.ownershipClaimCapability = { environment, owner: { ...this.owner! },
      enabled: this.agentCapabilities.includes(RemoteCapability.SessionAgent) && supported.includes(RemoteCapability.AgentOwnershipClaim) };
    if (this.agentCapabilities.length && supported.includes(RemoteCapability.AgentCatalog)
      && Number.isInteger(support.limits?.maxAgentCatalogItems) && Number.isInteger(support.limits?.maxAgentCatalogBytes)
      && support.limits.maxAgentCatalogItems > 0 && support.limits.maxAgentCatalogBytes > 0) {
      this.agentLimits = { items: Math.min(REMOTE_AGENT_CATALOG_ITEMS, support.limits.maxAgentCatalogItems), bytes: Math.min(REMOTE_AGENT_CATALOG_BYTES, support.limits.maxAgentCatalogBytes) };
      this.agentCapabilities.push(RemoteCapability.AgentCatalog);
      if (supported.includes(RemoteCapability.AgentSelection)) this.agentCapabilities.push(RemoteCapability.AgentSelection);
    }

    // Admission flags may turn off while accepted extended commands still need recovery.
    // Device protocol support is persistent; only new production uses the current intersection.
    const declarationKey = this.targetKey('agentCapabilities');
    const saved = this.deps.store.get<string[]>(declarationKey) || [];
    const implemented: string[] = [RemoteCapability.SessionAgent, RemoteCapability.AgentCatalog, RemoteCapability.AgentSelection];
    this.declaredAgentCapabilities = this.agentCatalog ? [...new Set([...saved, ...this.agentCapabilities])].filter(value => implemented.includes(value)).sort() : [];
    this.deps.store.put(declarationKey, this.declaredAgentCapabilities);
    const dualKey = this.targetKey('dualApprovalCapability');
    const dualEnabled = this.deps.supportsDualApproval?.() === true && supported.includes(RemoteCapability.DualApproval);
    // This is a protocol declaration, not an admission flag. Never erase in-flight extended state.
    this.declaredDualApproval = this.deps.store.get<boolean>(dualKey) === true || dualEnabled;
    if (this.declaredDualApproval) this.deps.store.put(dualKey, true);
    this.deps.store.setApprovalProjectionSupported(this.declaredDualApproval);
    this.deps.configureDualApproval?.({ enabled: dualEnabled, projectionSupported: this.declaredDualApproval });
    this.lastCapabilityCheck = Date.now();
    if (this.registration && this.settings().enabled) this.ownershipClaimBlocks();
    if (this.registration) this.applyProjectionCapabilities();
    if (this.registration && previous !== stableJson([this.declaredAgentCapabilities, this.declaredDualApproval, this.fileCapabilities, this.replySupported, this.questionsSupported, this.declaredQuestions, this.retentionSupported, this.receiptsSupported, this.connectionManagementKnown, this.deletionSupported])) this.queueControl(this.settings());
  }
  private applyProjectionCapabilities(): void {
    if (!this.capabilitiesKnown || !this.owner || !this.registration) return;
    if (!this.targetId) return;
    this.deps.store.setProjectionIdentity(this.remoteEnvironment(), this.owner, this.registration.deviceId);
    this.deps.store.setDeletionProjectionSupported(this.deletionSupported);
    this.deps.store.setReplyProjectionSupported(this.replySupported);
    this.deps.store.setQuestionProjectionSupported(this.questionsSupported);
    const fileSupported = this.fileCapabilities.length === Object.values(RemoteFileCapability).length;
    this.deps.store.setFileProjectionSupported(fileSupported);
    this.deps.store.setInputProjectionSupported(fileSupported || this.inputCapabilities.includes(RemoteInputCapability.Schema));
    this.deps.store.setAgentSummaryResolver(this.agentCapabilities.includes(RemoteCapability.SessionAgent)
      ? (sessionId, actor) => this.agentCatalog!.summary(sessionId, actor) : null);
  }
  private async register(): Promise<void> {
    const epoch = this.accountGeneration;
    await this.refreshCapabilities();
    const result: Registration = await this.api('/devices/register', 'POST', { ...this.deps.metadata, name: this.settings().name,
      installationId: this.deps.identity.installationId, deviceKey: this.deps.identity.deviceKey,
      kind: 'desktop', protocolVersion: REMOTE_PROTOCOL_VERSION, capabilities: this.advertisedCapabilities() }, false, this.connectionManagement ? 2 : 1);
    if (!sameOwner(this.owner, result)) throw new Error('Registration owner does not match the authenticated account');
    const target = parseRemoteSyncTarget(result.syncTarget);
    if (stableJson(target) !== stableJson(this.discoveredTarget)) throw new RemoteSyncStateError('Registration data identity does not match discovery');
    if (target) result.syncTarget = target;
    this.registration = result;
    try {
      await this.deps.store.pauseSyncTargetProjection();
      const current = (): boolean => epoch === this.accountGeneration && this.accountRoute === this.deps.getApiBaseUrl()
        && sameOwner(this.owner, this.deps.getOwner()) && this.registration === result;
      if (!current()) throw new Error('Account changed during target negotiation');
      const prior = this.targets.active(this.owner!);
      const rows = this.deps.store.sessions(this.owner!);
      const distinct = !!target && !!prior?.syncTarget && target.dataSpaceId !== prior.syncTarget.dataSpaceId;
      const legacyStates: RetentionState[] = [];
      if (!prior?.syncTarget) {
        for (const row of rows) {
          if (!row.device_id && !row.ack_seq && row.server_seq === '0' && row.sync_protocol_version === 1
            && !row.stream_epoch && !this.deps.store.get(`import:${row.local_id}`)) continue;
          if (row.device_id !== result.deviceId) throw new RemoteSyncStateError('Legacy device mapping requires recovery');
          await this.reconcileRegistrationImport(row);
          if (!current()) throw new Error('Account changed during target negotiation');
          const state: RetentionState = await this.api(`/sync/state?localSessionId=${encodeURIComponent(row.local_id)}`);
          legacyStates.push(state);
        }
      }
      if (!current()) throw new Error('Account changed during target negotiation');
      const activated = target ? this.targets.activate({ owner: this.owner!, deviceId: result.deviceId,
        syncTarget: target, bootstrap: distinct, legacyStates })
        : this.targets.activateLegacy({ owner: this.owner!, deviceId: result.deviceId, legacyStates });
      this.targetId = activated.targetId;
      const pendingKey = this.pendingConfigurationKey(), pending = this.deps.store.get<PendingConfiguration>(pendingKey);
      if (pending?.route === this.accountRoute) {
        // The first legacy claim already copied the original durable control queue without changing its IDs.
        if (prior || activated.kind !== RemoteSyncTargetActivationKind.Claimed) {
          for (const changes of pending.changes) {
            if (!current()) throw new Error('Account changed during target configuration');
            await this.configure(changes);
          }
        }
        this.deps.store.remove(pendingKey);
      }
      this.deps.store.setFileEnvironment(this.targetId);
      this.connections.reset(); this.deps.input?.models.resetPublication();
      this.agentCatalog?.reset(); this.deps.input?.preparations.reset?.();
      const connection = this.savedConnectionState<{ state: string; version: string }>();
      this.connectionRemoved = connection?.state === RemoteDeviceConnectionState.Removed;
      this.connectionVersion = connection?.version || '0';
      // Discovery ran before the target was bound; persist capability/cache state in its verified scope.
      await this.refreshCapabilities(this.capabilitySnapshot);
      for (const row of this.deps.store.sessions(this.owner!)) {
        if (!row.ack_seq && row.server_seq === '0' && row.sync_protocol_version === 1 && !row.stream_epoch
          && !this.deps.store.get(`import:${row.local_id}`)) continue;
        try {
          await this.reconcileRegistrationImport(row);
          await this.readSyncState(this.deps.store.sync(row.local_id)!);
          const failure = this.deps.store.get<{ reason?: string }>(`syncFailure:${row.local_id}`);
          if (failure?.reason === RemoteRetention.StateConflict) this.deps.store.remove(`syncFailure:${row.local_id}`);
        } catch (error) {
          if (!current()) throw error;
          if (!(error instanceof RemoteSyncStateError)) throw error;
          this.deps.store.put(`syncFailure:${row.local_id}`, { blocked: true, reason: RemoteRetention.StateConflict });
          this.sessionSyncFailed = true;
        }
      }
    } catch (error) {
      if (this.registration === result) this.registration = null;
      throw error;
    }
    this.applyProjectionCapabilities();
    if (this.sameAccountAccess) this.connectionReason = RemoteConnectionReason.Connecting;
    if (!this.controls().length) this.queueControl(this.settings());
    this.changed();
  }
  private async reconcileRegistrationImport(row: SyncRow): Promise<void> {
    const pending = this.deps.store.get<SavedImport>(`import:${row.local_id}`);
    if (!pending || pending.beginAttempted === false) return;
    const receipt = await this.api(`/sync/imports/${pending.importId}`);
    this.assertImportIdentity(pending, receipt);
    if (receipt.state === 'committed') {
      if (receipt.targetStreamEpoch) pending.targetStreamEpoch ||= receipt.targetStreamEpoch;
      this.completeImport(row, pending, receipt);
    }
  }
  private async writeSettings(): Promise<void> {
    const owner = this.owner;
    const pending = this.settingsQueue.catch((): void => undefined).then(async () => {
      if (!sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())) return;
      await this.performWriteSettings();
      if (sameOwner(owner, this.owner) && sameOwner(owner, this.deps.getOwner())) await this.writeName();
    });
    this.settingsQueue = pending;
    await pending;
  }
  private async performWriteSettings(): Promise<void> {
    if (!this.registration) return;
    const owner = this.owner;
    const path = `/devices/${this.registration.deviceId}/settings`;
    const key = this.controlKey();
    while (sameOwner(owner, this.owner) && sameOwner(owner, this.deps.getOwner())) {
      const next = this.controls()[0];
      if (!next) break;
      if (!this.sameAccountAccess && next.enabled) {
        if (this.controls().some(intent => !intent.enabled)) { this.deps.store.put(key, this.controls().slice(1)); continue; }
        throw new RemoteApiError(47000, 'Server upgrade required for same-account remote access');
      }
      const server = await this.api(path);
      const result = await this.api(path, 'PATCH', { expectedSettingsVersion: server.settingsVersion,
        remoteEnabled: next.enabled, protocolVersion: REMOTE_PROTOCOL_VERSION, capabilities: this.advertisedCapabilities(next.createSessionAvailable !== false), workspaces: next.workspaces });
      const latest = this.settings(); latest.settingsVersion = result.settingsVersion;
      this.deps.store.transaction(() => {
        this.deps.store.put(this.settingsKey(), latest);
        this.deps.store.put(key, this.controls().filter(intent => intent.id !== next.id));
      });
      if (!this.error) this.connectionReason = RemoteConnectionReason.Reconnecting;
      this.disconnect(); this.changed();
    }
  }
  private async writeName(): Promise<void> {
    if (!this.registration) return;
    const key = this.nameKey();
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = this.deps.store.get<{ id: string; name: string }>(key);
      if (!pending) return;
      try {
        const metadata = await this.api(`/devices/${this.registration.deviceId}/metadata`, 'PATCH', {
          name: pending.name, expectedMetadataVersion: this.registration.metadataVersion,
        });
        this.registration.metadataVersion = metadata.metadataVersion;
        if (this.deps.store.get<{ id: string }>(key)?.id === pending.id) this.deps.store.remove(key);
        this.changed();
      } catch (error) {
        if (!(error instanceof RemoteApiError) || error.code !== 47020 || !error.data?.currentMetadataVersion || attempt === 2) throw error;
        this.registration.metadataVersion = String(error.data.currentMetadataVersion);
      }
    }
  }
  private async connect(): Promise<void> {
    const attempt = ++this.connectionAttempt;
    const owner = this.owner;
    let ticket: any;
    try { ticket = await this.api('/connection-tickets', 'POST', { protocolVersion: REMOTE_PROTOCOL_VERSION,
      ...(this.projectionVersion > 1 ? { projectionVersion: this.projectionVersion } : {}) }); }
    catch (error) { if (attempt !== this.connectionAttempt) return; throw error; }
    if (attempt !== this.connectionAttempt || this.connectionRemoved || this.stopped || !sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner()) || !this.settings().enabled) return;
    const url = new URL(ticket.wsUrl);
    const apiBase = new URL(this.deps.getApiBaseUrl());
    if (url.protocol !== 'wss:' || url.host !== apiBase.host || !url.pathname.startsWith('/api/remote/v1/')) throw new Error('Remote ticket URL origin is not trusted');
    const socket = new WebSocket(url.toString());
    this.handshake = setTimeout(() => { if (this.socket === socket && !this.generation) this.failSocket(SocketFailureCode.Transport, 'Remote WebSocket handshake timed out'); }, 15000);
    this.handshake.unref?.();
    this.socket = socket; this.changed();
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      if (!sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) { this.accountChanged(); return; }
      const data = String(event.data);
      if (Buffer.byteLength(data) > 65536) { this.failSocket(SocketFailureCode.PayloadTooLarge, 'Remote WebSocket frame is too large'); return; }
      try {
        const frame = JSON.parse(data);
        if (frame.type === 'hello') {
          if (frame.protocolVersion !== REMOTE_PROTOCOL_VERSION || !/^[1-9]\d*$/u.test(String(frame.connectionGeneration))) throw new Error('Invalid remote handshake');
          if (this.projectionVersion > 1 && frame.projectionVersion !== this.projectionVersion) {
            const negotiated = [1, 2, 3, REMOTE_REPLY_PROJECTION_VERSION, RemoteQuestion.ProjectionVersion].includes(frame.projectionVersion) ? frame.projectionVersion : 1;
            this.projectionVersion = Math.min(this.projectionVersion, negotiated);
            if (this.projectionVersion < RemoteQuestion.ProjectionVersion) {
              this.questionsSupported = false; this.deps.store.setQuestionProjectionSupported(false);
            }
            if (this.projectionVersion < REMOTE_REPLY_PROJECTION_VERSION) {
              this.replySupported = false; this.replies.clear(); this.deps.store.setReplyProjectionSupported(false);
            }
            if (this.projectionVersion < 3) { this.files?.configure(false); this.deps.store.setFileProjectionSupported(false); }
          }
          if (this.handshake) clearTimeout(this.handshake); this.handshake = null;
          this.quotaBlocked = false; this.retryAfter = 0;
          this.generation = String(frame.connectionGeneration); this.lastPong = Date.now();
          this.commandPollAt = 0; this.commandRetryAt = 0; this.inputPollAt = 0; this.inputRetryAt = 0;
          this.lastInputPublish = 0; this.agentCatalogRetryAt = 0;
          this.heartbeatTimeout = Math.min(90000, Math.max(20000, (Number(frame.heartbeatTimeoutSeconds) || 75) * 1000));
          this.error = undefined; this.errorCode = undefined; this.errorRequestKey = undefined;
          this.connectionReason = RemoteConnectionReason.Connecting;
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPong >= this.heartbeatTimeout) { this.failSocket(SocketFailureCode.HeartbeatTimeout, 'Remote WebSocket heartbeat timed out'); return; }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', id: randomUUID() }));
          }, Math.max(10000, Math.min(30000, (Number(frame.heartbeatIntervalSeconds) || 25) * 1000)));
          this.heartbeat.unref?.(); this.changed(); this.schedule(0);
        } else if (frame.type === 'pong' && this.generation) {
          const wasConnected = this.state().connected;
          this.lastPong = Date.now();
          if (!wasConnected && this.state().connected) this.changed();
        }
        else if (frame.type === 'reconnect.required' || frame.type === 'access.changed') {
          if (!this.error) this.connectionReason = RemoteConnectionReason.Reconnecting;
          this.disconnect(); this.schedule(0);
        }
        else if (frame.type === 'device.connection.changed' && this.connectionManagement) {
          // An event is invalidation only. Fetch the authoritative version before changing state.
          void this.connections.query().catch((): void => undefined);
        }
        else if (frame.type === RemoteDeletion.Available || frame.type === RemoteDeletion.Changed) { this.deletions?.wake(); this.startDeletionSync(); }
        else if (frame.type === 'commands.available' || frame.type === 'access.requested') { this.commandPollAt = 0; this.schedule(0); }
        else if (frame.type === 'input.preparations.available') { this.inputPollAt = 0; this.inputRetryAt = 0; this.schedule(0); }
        else if (frame.type === 'input.preparation.updated') { this.inputPollAt = 0; this.schedule(0); }
      } catch { this.failSocket(SocketFailureCode.Protocol, 'Invalid remote WebSocket message'); }
    });
    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      const restarting = this.generation !== null && [1000, 1001, 1012].includes(event.code);
      if (!restarting) this.recordConnectionFailure(new RemoteApiError(event.code, `Remote connection closed (${event.code})`));
      else if (!this.error) this.connectionReason = RemoteConnectionReason.Reconnecting;
      if ([4403, 4409, 4410].includes(event.code) && (this.connectionManagement || this.connectionManagementKnown)) void this.connections.query().catch((): void => undefined);
      if ([4403, 4409, 4410].includes(event.code)) { this.suspended = true; this.error = `Remote connection closed (${event.code})`; this.errorCode = event.code; this.connectionReason = RemoteConnectionReason.DeviceUnavailable; }
      this.disconnect();
      this.changed(); this.schedule(this.backoff);
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.failSocket(SocketFailureCode.Transport, 'Remote WebSocket connection failed');
    });
  }
  private disconnect(): void {
    this.connectionAttempt++;
    this.commandPollAt = 0; this.commandRetryAt = 0; this.inputPollAt = 0; this.inputRetryAt = 0;
    this.agentCatalogRetryAt = 0; this.lastInputPublish = 0;
    this.deps.input?.models.resetPublication?.();
    const socket = this.socket; this.socket = null; this.generation = null; this.lastPong = 0;
    if (this.handshake) clearTimeout(this.handshake); this.handshake = null;
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    if (socket) socket.close();
    this.changed();
  }
  private transport(): Record<string, string> {
    return this.generation ? { mode: 'online', connectionGeneration: this.generation } : { mode: 'recovery' };
  }
  private async pollAccess(): Promise<void> {
    const items: RemoteSettingsState['accessRequests'] = [];
    let cursor: string | null = null;
    do {
      const result = await this.api(`/devices/${this.registration!.deviceId}/access-requests?status=pending&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      items.push(...(result.items || [])); cursor = result.nextCursor || null;
    } while (cursor);
    this.accesses = items;
  }
  private logSyncSkipped(row: SyncRow, reason: string, retryAt: number | null = null): void {
    const signature = `${reason}:${retryAt}`;
    if (this.syncSkipReasons.get(row.local_id) === signature) return;
    this.syncSkipReasons.set(row.local_id, signature);
    console.debug('[RemoteSync] Session synchronization deferred', { localSessionId: row.local_id, sessionId: row.session_id,
      deviceId: row.device_id, reason, retryAt, sourceSeq: row.source_seq, ackSourceSeq: row.ack_seq,
      serverSeq: row.server_seq, needsSnapshot: Boolean(row.needs_snapshot) });
  }
  /** History HTTP/import uploads cannot occupy the command claim/reconcile lane. */
  private startHistorySync(): void {
    if (this.historyWork || Date.now() < this.historyRetryAt || !this.syncContext()()) return;
    const current = this.syncContext();
    const work = this.syncSessions().catch(error => {
      if (!current()) return;
      this.sessionSyncFailed = true;
      this.historyRetryAt = Date.now() + IDLE_POLL_MS;
      console.warn('[RemoteSync] History lane deferred', remoteSyncErrorMetadata(error));
      if (this.isGlobalError(error)) {
        this.recordConnectionFailure(error);
        if (this.suspended || error instanceof RemoteApiError && [401, 40100, 403, 47000].includes(error.code)) this.disconnect();
      }
    }).finally(() => {
      if (this.historyWork === work) this.historyWork = null;
      this.changed();
      if (current() && this.owner && this.deps.store.db.prepare(`SELECT 1 FROM remote_dirty d JOIN cowork_session_ownership o ON o.session_id=d.session_id
        LEFT JOIN remote_projection_failures f ON f.session_id=d.session_id
        WHERE o.owner_user_id=? AND o.owner_scope_key=? AND (f.session_id IS NULL OR f.retry_at<=?) LIMIT 1`).get(this.owner.userId, this.owner.scopeKey, Date.now()))
        this.schedule(Math.max(ACTIVE_POLL_MS, this.historyRetryAt - Date.now()));
    });
    this.historyWork = work;
  }
  private recordSuccessfulSync(): void {
    if (this.owner) this.deps.store.put(`lastSuccessfulSync:${this.owner.userId}:${this.owner.scopeKey}`, new Date().toISOString());
  }
  private async syncSessions(): Promise<void> {
    if (!this.owner || !this.registration) return;
    const owner = this.owner, deviceId = this.registration.deviceId, accountGeneration = this.accountGeneration;
    const environment = this.remoteEnvironment();
    const current = this.syncContext();
    await this.deps.store.flushProjections();
    if (!current()) return;
    const rows = this.deps.store.sessions(owner);
    const currentIds = new Set(rows.map(row => row.local_id));
    for (const id of this.syncSkipReasons.keys()) if (!currentIds.has(id)) this.syncSkipReasons.delete(id);
    for (const row of rows) {
      if (this.deps.store.isSyncClosed(row.local_id)) continue;
      if (accountGeneration !== this.accountGeneration || !sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())
        || deviceId !== this.registration?.deviceId || environment !== this.remoteEnvironment()) return;
      if (this.deps.store.projectionPublishing(row.local_id)) { this.logSyncSkipped(row, 'projection_publishing'); continue; }
      if (this.ownershipSyncBlocked(row.local_id)) { this.logSyncSkipped(row, 'ownership_admission_pending'); continue; }
      if (this.deps.store.db.prepare('SELECT 1 FROM remote_projection_failures WHERE session_id=?').get(row.local_id)) { this.logSyncSkipped(row, 'projection_failed'); continue; }
      const failure = this.deps.store.get<any>(`syncFailure:${row.local_id}`);
      // Older builds kept failure markers after a successful snapshot ACK.
      if (failure && !failure.blocked && row.device_id === deviceId && !row.needs_snapshot && row.source_seq === row.ack_seq
        && !this.deps.store.get(`import:${row.local_id}`)
        && !this.deps.store.db.prepare('SELECT session_id FROM remote_dirty WHERE session_id=?').get(row.local_id)
        && !this.deps.store.pending(row.local_id).length) {
        this.deps.store.remove(`syncFailure:${row.local_id}`);
        this.syncSkipReasons.delete(row.local_id);
        console.debug('[RemoteSync] Stale failure marker cleared', { localSessionId: row.local_id, sessionId: row.session_id, ackSourceSeq: row.ack_seq, serverSeq: row.server_seq });
        continue;
      }
      if (failure?.blocked) { this.logSyncSkipped(row, 'sync_state_blocked'); continue; }
      if (failure?.reason === 'REPLY_CONTENT_QUOTA_EXCEEDED') { this.logSyncSkipped(row, 'reply_quota_exceeded'); continue; }
      if (failure?.retryAt > Date.now()) { this.logSyncSkipped(row, 'retry_backoff', failure.retryAt); continue; }
      try {
      if (!this.generation && !row.device_id) { this.logSyncSkipped(row, 'awaiting_connection'); continue; }
      if (row.device_id && row.device_id !== this.registration.deviceId) { this.logSyncSkipped(row, 'device_mismatch'); continue; }
      if (row.sync_environment && !this.targets.matchesEnvironment(environment, row.sync_environment)) throw new RemoteSyncStateError('Session has no verified binding to the active service');
      this.syncSkipReasons.delete(row.local_id);
      if (!row.device_id) this.deps.store.bindRemote(row.local_id, row.session_id, this.registration.deviceId);
      if (row.sync_protocol_version === RemoteRetention.Version && !this.retentionSupported
        && Date.now() - (this.retentionVerifiedAt.get(row.local_id) || 0) >= IDLE_POLL_MS) {
        await this.readSyncState(row);
        if (!current()) return;
        this.retentionVerifiedAt.set(row.local_id, Date.now());
      }
      const savedImport = this.deps.store.get<SavedImport>(`import:${row.local_id}`);
      if (row.needs_snapshot || savedImport || this.retentionSupported && row.sync_protocol_version < RemoteRetention.Version) { await this.importSession(this.deps.store.sync(row.local_id)!, savedImport); continue; }
      const events = this.deps.store.pending(row.local_id);
      if (!events.length) continue;
      await this.uploadReplyContents(row.local_id, row.session_id, events);
      if (!current()) return;
      const batchId = payloadHash(events);
      const result = await this.api('/sync/batches', 'POST', { batchId, deviceId: this.registration.deviceId,
        ...this.transport(), ...(row.sync_protocol_version === RemoteRetention.Version ? { syncProtocolVersion: RemoteRetention.Version, streamEpoch: row.stream_epoch } : {}), owner: this.owner, sessionId: row.session_id, localSessionId: row.local_id, events });
      if (!current()) return;
      if (result.batchId !== batchId || result.deviceId !== this.registration.deviceId || result.sessionId !== row.session_id) throw new Error('Remote batch ACK identity mismatch');
      if (retentionSequence(result.committedSourceSeq) < retentionSequence(events.at(-1)!.sourceSeq)) throw new Error('Remote batch ACK did not cover the submitted events');
      this.deps.store.transaction(() => {
        if (row.sync_protocol_version === RemoteRetention.Version) this.deps.store.applyRetentionAck(row.local_id, result);
        this.deps.store.acknowledge(row.local_id, result.deviceId, result.sessionId, result.committedSourceSeq, result.committedSeq);
      });
      this.deps.store.remove(`syncFailure:${row.local_id}`);
      this.recordSuccessfulSync();
      console.debug('[RemoteSync] Batch acknowledged locally', { localSessionId: row.local_id, ...remoteSyncResultMetadata(result),
        sourceSeq: this.deps.store.sync(row.local_id)?.source_seq ?? null, previousAckSourceSeq: row.ack_seq });
      } catch (error) {
        if (!current()) return;
        if (accountGeneration !== this.accountGeneration || !sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())
          || deviceId !== this.registration?.deviceId || environment !== this.remoteEnvironment()) return;
        const diagnostic = remoteSyncErrorMetadata(error);
        diagnostic.code ??= 47019;
        const remotelyDeleted = error instanceof RemoteApiError && error.code === 47010 && error.httpStatus === 410 && error.data?.reason === 'SESSION_DELETED';
        // Keep the error trace useful without recording tokens, conversation content or response bodies.
        console.warn('[RemoteSync] Session synchronization failed', { localSessionId: row.local_id, sessionId: row.session_id,
          deviceId, sourceSeq: row.source_seq, ackSourceSeq: row.ack_seq, serverSeq: row.server_seq,
          importId: this.deps.store.get<SavedImport>(`import:${row.local_id}`)?.importId ?? null, retryDelayMs: this.isGlobalError(error) || remotelyDeleted ? null : 30000,
          phase: row.needs_snapshot || this.deps.store.get(`import:${row.local_id}`) ? 'snapshot' : 'batch', ...diagnostic });
        if (this.isGlobalError(error)) throw error;
        // A remote tombstone cannot accept another import. Preserve local history and the original receipts without inventing an ACK.
        if (remotelyDeleted) {
          this.deps.store.put(`syncFailure:${row.local_id}`, { ...diagnostic, blocked: true });
          this.sessionSyncFailed = true; continue;
        }
        if (error instanceof RemoteApiError && error.code === 47025 && error.data?.currentImport) {
          await this.recoverImportConflict(row, error.data.currentImport, current);
        }
        if (error instanceof RemoteApiError && (error.code === RemoteRetention.ResyncCode
          || error.code === RemoteRetention.ProtocolCode && error.data?.reasonDetail === 'SYNC_RETENTION_REQUIRED')) {
          try { await this.recoverSyncState(row, current); } catch (recoveryError) {
            if (!(recoveryError instanceof RemoteSyncStateError)) throw recoveryError;
            this.deps.store.put(`syncFailure:${row.local_id}`, { ...diagnostic, blocked: true, reason: RemoteRetention.StateConflict });
            this.sessionSyncFailed = true; continue;
          }
        }
        if (error instanceof RemoteApiError && error.code === 47006 && error.message === RemoteSyncConflict.RunMapping
          && !row.needs_snapshot && !this.deps.store.get(`import:${row.local_id}`)) {
          this.deps.store.requireRunMappingSnapshot(row.local_id);
          console.debug('[RemoteSync] Run mapping recovery snapshot scheduled', { localSessionId: row.local_id, sessionId: row.session_id,
            controlVersion: this.deps.store.controlVersion(row.local_id), ackSourceSeq: row.ack_seq,
            sourceSeq: this.deps.store.sync(row.local_id)?.source_seq ?? null });
        }
        this.deps.store.put(`syncFailure:${row.local_id}`, { ...diagnostic, ...(error instanceof RemoteSyncStateError || error instanceof RemoteImportSnapshotError && ['REMOTE_IMPORT_BUDGET', 'REMOTE_IMPORT_RECORD_LIMIT'].includes(error.message) ? { blocked: true, reason: RemoteRetention.StateConflict } : {}), retryAt: Date.now() + 30000 });
        this.sessionSyncFailed = true;
      }
    }
    await this.ensureRetentionFence();
    if (!current()) return;
    this.sessionSyncFailed = this.deps.store.sessions(owner).some(row => !!this.deps.store.get(`syncFailure:${row.local_id}`));
  }
  /** One logical publication must not cross identity, environment or projection changes between HTTP calls. */
  private syncContext(): () => boolean {
    const owner = this.owner, deviceId = this.registration?.deviceId, generation = this.accountGeneration;
    const route = this.deps.getApiBaseUrl();
    const environment = this.remoteEnvironment(), projection = this.projectionVersion, replyProjection = this.replySupported;
    return () => !this.deps.store.needsSecurityRecovery() && !this.stopped && generation === this.accountGeneration && sameOwner(owner, this.owner)
      && sameOwner(owner, this.deps.getOwner()) && route === this.deps.getApiBaseUrl() && deviceId === this.registration?.deviceId
      && environment === this.remoteEnvironment() && projection === this.projectionVersion && replyProjection === this.replySupported && this.settings().enabled && !this.syncPaused()
      && (!this.connectionManagementKnown || this.generation !== null);
  }
  getSyncTargetId(): string | null { return this.targetId; }
  private remoteEnvironment(): string { return this.targetId ?? this.deps.getEnvironment?.() ?? 'unresolved'; }
  private canAdmitOwnershipClaim(): boolean {
    const capability = this.ownershipClaimCapability;
    return this.settings().enabled && capability?.enabled === true && capability.environment === this.remoteEnvironment() && sameOwner(capability.owner, this.owner);
  }
  private ownershipClaimBlocks(allowAdmission = true): OwnershipClaimBlocks {
    if (!this.owner || !this.registration || !sameOwner(this.owner, this.deps.getOwner())) throw new Error('Account changed');
    const environment = this.remoteEnvironment();
    return this.ownershipAssociations.prepareRemoteAdmission({ owner: this.owner, environment, deviceId: this.registration.deviceId },
      allowAdmission && this.canAdmitOwnershipClaim());
  }
  private ownershipSyncBlocked(sessionId: string, blocked = this.ownershipClaimBlocks()): boolean {
    if (blocked.blockedSessionIds.has(sessionId)) return true;
    if (!blocked.blockedAgentIds.size) return false;
    const session = this.deps.store.db.prepare('SELECT agent_id FROM cowork_sessions WHERE id=?').get(sessionId) as { agent_id: string | null } | undefined;
    return Boolean(session?.agent_id && blocked.blockedAgentIds.has(session.agent_id));
  }
  private async uploadReplyContents(localId: string, sessionId: string, records: ProjectionRecord[]): Promise<void> {
    if (!this.replySupported) return;
    const owner = this.owner, deviceId = this.registration?.deviceId, environment = this.remoteEnvironment();
    const accountGeneration = this.accountGeneration;
    if (!owner || !deviceId) throw new Error('Reply synchronization identity unavailable');
    await this.replies.upload({ sessionId, deviceId,
      scope: JSON.stringify([environment, owner.userId, owner.scopeKey, deviceId]),
      uploads: this.deps.store.replyContentUploads(localId, records), transport: () => this.transport(),
      current: () => !this.stopped && this.replySupported && accountGeneration === this.accountGeneration && deviceId === this.registration?.deviceId
        && sameOwner(owner, this.owner) && sameOwner(owner, this.deps.getOwner()) && environment === this.remoteEnvironment()
        && this.settings().enabled,
      api: (pathname, method, body) => this.api(pathname, method, body),
    });
  }
  private importProtocol(saved: SavedImport): Record<string, unknown> {
    if (saved.syncProtocolVersion !== RemoteRetention.Version) return {};
    if (!saved.targetStreamEpoch) throw new RemoteSyncStateError('Pending import epoch has not been persisted');
    return { syncProtocolVersion: RemoteRetention.Version, streamEpoch: saved.targetStreamEpoch };
  }
  private completeImport(row: SyncRow, saved: SavedImport, result: any): void {
    if (result.state !== 'committed' || result.sessionId !== saved.sessionId || result.importId && result.importId !== saved.importId
      || result.manifestHash && result.manifestHash !== saved.manifest.manifestHash || result.committedSourceSeq !== saved.baseSourceSeq) throw new RemoteSyncStateError('Remote import receipt identity mismatch');
    this.deps.store.transaction(() => {
      if (saved.syncProtocolVersion === RemoteRetention.Version) {
        const epoch = result.targetStreamEpoch || result.streamEpoch;
        if (result.state !== 'committed' || result.sessionId !== saved.sessionId || result.importId !== saved.importId
          || result.manifestHash !== saved.manifest.manifestHash || result.syncProtocolVersion !== RemoteRetention.Version
          || epoch !== saved.targetStreamEpoch || result.streamEpoch !== epoch
          || result.committedSourceSeq !== saved.baseSourceSeq) throw new RemoteSyncStateError('Remote import receipt identity mismatch');
        this.deps.store.applyRetentionAck(row.local_id, result, true);
      }
      this.deps.store.acknowledge(row.local_id, this.registration!.deviceId, saved.sessionId,
        result.committedSourceSeq, result.committedSeq, true, saved.snapshotEpoch);
      this.deps.store.remove(`import:${row.local_id}`);
      this.deps.store.remove(`syncFailure:${row.local_id}`);
      this.deps.store.unfreezeMigration(row.local_id);
      this.recordSuccessfulSync();
    });
    if (saved.fileSet) void this.importSnapshots.release(saved.fileSet).catch((): void => undefined);
  }
  private discardImport(row: SyncRow): void {
    const fileSet = this.deps.store.get<SavedImport>(`import:${row.local_id}`)?.fileSet;
    this.deps.store.transaction(() => {
      this.deps.store.remove(`import:${row.local_id}`);
      this.deps.store.requireSnapshot(row.local_id);
      this.deps.store.unfreezeMigration(row.local_id);
    });
    if (fileSet) void this.importSnapshots.release(fileSet).catch((): void => undefined);
  }
  private async recoverImportConflict(row: SyncRow, remote: any, current: () => boolean): Promise<void> {
    const pending = this.deps.store.get<SavedImport>(`import:${row.local_id}`);
    if (!pending?.beginConfirmed || remote.importId !== pending.importId || !current()) return;
    if (remote.state === 'committed') { this.completeImport(row, pending, remote); return; }
    if (remote.state !== 'uploading') {
      if (['aborted', 'expired'].includes(remote.state)) this.discardImport(row);
      return;
    }
    // A changed server baseline invalidates the immutable package, not its local history.
    // Only a confirmed abort permits rebuilding; uncertain/committed outcomes retain the original receipt.
    const aborted = await this.api(`/sync/imports/${pending.importId}/abort`, 'POST', {
      ...this.transport(), ...this.importProtocol(pending), expectedStateVersion: remote.stateVersion, reason: 'baseline_changed',
    });
    if (!current()) return;
    if (aborted.state === 'committed') this.completeImport(row, pending, aborted);
    else if (['aborted', 'expired'].includes(aborted.state)) this.discardImport(row);
  }
  private async readSyncState(row: SyncRow): Promise<RetentionState | null> {
    try {
      const state: RetentionState = await this.api(`/sync/state?localSessionId=${encodeURIComponent(row.local_id)}`);
      if (state.deleted) throw new RemoteSyncStateError('Remote session is deleted');
      if (state.deviceId !== this.registration!.deviceId || state.sessionId !== row.session_id || state.localSessionId !== row.local_id
        || retentionSequence(state.lastSourceSeq) > BigInt(this.deps.store.sync(row.local_id)!.source_seq)
        || retentionSequence(state.lastSourceSeq) < BigInt(row.ack_seq)
        || retentionSequence(state.lastSeq) < retentionSequence(row.server_seq)
        || (row.stream_epoch && row.stream_epoch !== state.streamEpoch)) throw new RemoteSyncStateError('Remote sync state conflicts with durable local history');
      if (row.sync_protocol_version === RemoteRetention.Version && state.syncProtocolVersion !== RemoteRetention.Version) throw new RemoteSyncStateError('Server cannot restore the active synchronization protocol');
      return state;
    } catch (error) {
      // Only a never-published session may be created after a verified missing mapping.
      if (error instanceof RemoteApiError && error.httpStatus === 404 && error.code === RemoteRetention.StateMissingCode && row.ack_seq === 0
        && row.server_seq === '0' && row.sync_protocol_version === 1 && !row.stream_epoch && !this.deps.store.get(`import:${row.local_id}`)) return null;
      if (error instanceof RemoteApiError && (error.httpStatus === 404 || row.sync_protocol_version === RemoteRetention.Version && error.httpStatus === 426)) throw new RemoteSyncStateError('Server no longer supports this active synchronization protocol');
      throw error;
    }
  }
  private async recoverSyncState(row: SyncRow, current: () => boolean): Promise<void> {
    // An in-flight import is the recovery authority; never manufacture an ACK from GET state.
    const pending = this.deps.store.get<SavedImport>(`import:${row.local_id}`);
    if (pending) {
      const status = await this.api(`/sync/imports/${pending.importId}`);
      if (!current()) return;
      if (status.state === 'committed') {
        if (status.targetStreamEpoch) pending.targetStreamEpoch ||= status.targetStreamEpoch;
        this.completeImport(row, pending, status); return;
      }
      throw new RemoteSyncStateError('Pending import must be reconciled before changing the synchronization stream');
    }
    const state = await this.readSyncState(row);
    if (!current()) return;
    if (!state || state.activeImport || state.syncProtocolVersion !== row.sync_protocol_version || state.streamEpoch !== row.stream_epoch) throw new RemoteSyncStateError('Remote stream recovery needs its original import receipt');
    this.deps.store.requireSnapshot(row.local_id);
  }
  private async importSession(row: SyncRow, saved: SavedImport | null): Promise<void> {
    if (this.ownershipSyncBlocked(row.local_id)) return;
    const key = `import:${row.local_id}`;
    const current = this.syncContext();
    const assertCurrent = (): void => { if (!current()) throw new Error('Reply synchronization context changed'); };
    assertCurrent();
    if (saved && (saved.owner && !sameOwner(saved.owner, this.owner) || saved.environment && !this.targets.matchesEnvironment(this.remoteEnvironment(), saved.environment)
      || saved.deviceId && saved.deviceId !== this.registration!.deviceId)) throw new RemoteSyncStateError('Saved import belongs to a different synchronization identity');
    const importHasReplies = saved?.replyProjection ?? (saved?.projectionVersion === REMOTE_REPLY_PROJECTION_VERSION
      || saved?.parts.some(part => part.payload?.records.some((record: ProjectionRecord) => record.payload.message?.projectionVersion === REMOTE_REPLY_PROJECTION_VERSION)));
    // Outer v5 may contain either legacy messages or v4 reply blocks. Never infer the inner
    // format solely from the envelope. Legacy v5 manifests without this fact need one safe rebuild.
    const unknownReplyProjection = saved?.replyProjection === undefined && (saved?.projectionVersion || 0) >= RemoteQuestion.ProjectionVersion;
    const projectionChanged = Boolean(saved && (saved.projectionVersion !== undefined && saved.projectionVersion !== this.projectionVersion
      || unknownReplyProjection || Boolean(importHasReplies) !== this.replySupported));
    const deleted = this.deps.store.db.prepare('SELECT id FROM cowork_sessions WHERE id=?').get(row.local_id) === undefined;
    const missingParts = saved?.fileSet ? !await this.importSnapshots.exists(saved.fileSet, saved.parts) : false;
    assertCurrent();
    if (saved && (missingParts || projectionChanged || deleted && !saved.manifest.recordCounts['session.deleted'])) {
      if (saved.beginAttempted === false) { this.discardImport(row); return; }
      {
        const old = await this.api(`/sync/imports/${saved.importId}`);
        assertCurrent();
        this.assertImportIdentity(saved, old);
        if (old.state === 'committed') {
          if (old.targetStreamEpoch) saved.targetStreamEpoch ||= old.targetStreamEpoch;
          this.completeImport(row, saved, old);
          this.deps.store.requireSnapshot(row.local_id);
          return;
        }
        if (old.state === 'uploading') {
          if (old.targetStreamEpoch) saved.targetStreamEpoch ||= old.targetStreamEpoch;
          this.deps.store.put(key, saved);
          const aborted = await this.api(`/sync/imports/${saved.importId}/abort`, 'POST', { ...this.transport(), ...this.importProtocol(saved),
            expectedStateVersion: old.stateVersion, reason: missingParts ? 'parts_missing' : deleted ? 'session_deleted' : 'projection_changed' });
          assertCurrent();
          this.assertImportIdentity(saved, aborted);
          if (aborted.state === 'committed') { this.completeImport(row, saved, aborted); this.deps.store.requireSnapshot(row.local_id); return; }
          if (!['aborted', 'expired'].includes(aborted.state)) throw new RemoteSyncStateError('Import abortion is not confirmed');
        } else if (!['aborted', 'expired'].includes(old.state)) throw new RemoteSyncStateError('Unknown remote import state');
      }
      assertCurrent();
      this.discardImport(row); return;
    }
    if (!saved) {
      const useV2 = this.retentionSupported || row.sync_protocol_version === RemoteRetention.Version;
      const state = useV2 ? await this.readSyncState(row) : null;
      assertCurrent();
      if (state?.activeImport) throw new RemoteSyncStateError('Remote active import is missing from local durable state');
      if (state && state.syncProtocolVersion !== row.sync_protocol_version) throw new RemoteSyncStateError('Remote protocol has no matching local activation receipt');
      const migration = useV2 && row.sync_protocol_version < RemoteRetention.Version;
      const importId = randomUUID();
      let parts: SavedImport['parts'], manifest: SavedImport['manifest'], baseSourceSeq: string, snapshotEpoch: number, fileSet: string | undefined;
      // Only legacy in-memory fixtures use the synchronous projector. Production never loads a whole snapshot into main.
      if (this.deps.store.db.name === ':memory:') {
        const snapshot = this.deps.store.snapshot(row.local_id);
        const groups: ProjectionRecord[][] = [[]];
        for (const record of snapshot.records) {
          const group = groups[groups.length - 1];
          if (group.length && (group.length >= 1000 || Buffer.byteLength(stableJson({ records: [...group, record] })) > 600 * 1024)) groups.push([record]);
          else group.push(record);
        }
        parts = groups.map((records, partNo) => ({ partNo, payload: { records }, payloadHash: payloadHash({ records }), byteSize: Buffer.byteLength(stableJson({ records })) }));
        const recordCounts: Record<string, number> = {};
        for (const record of snapshot.records) recordCounts[record.eventType] = (recordCounts[record.eventType] || 0) + 1;
        manifest = { partCount: parts.length, recordCounts, manifestHash: payloadHash(parts.map(({ partNo, payloadHash: hash, byteSize }) => ({ partNo, payloadHash: hash, byteSize }))) };
        baseSourceSeq = snapshot.baseSourceSeq; snapshotEpoch = snapshot.snapshotEpoch;
      } else {
        const identity = this.importSnapshots.identity(row.local_id, this.owner!, this.registration!.deviceId, this.remoteEnvironment());
        const packaged = await this.importSnapshots.create(importId, identity, current);
        try {
          assertCurrent();
          if (!this.importSnapshots.matches(identity)) throw new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED');
        } catch (error) { await this.importSnapshots.release(packaged.fileSet); throw error; }
        parts = packaged.parts; manifest = packaged.manifest; fileSet = packaged.fileSet;
        baseSourceSeq = identity.sourceSeq; snapshotEpoch = identity.snapshotEpoch;
      }
      const prepared: SavedImport = { reason: migration ? 'protocol_upgrade' : this.deps.store.get<string>(`snapshotReason:${row.local_id}`) || 'initial_sync', projectionVersion: this.projectionVersion, replyProjection: this.replySupported, importId, sessionId: row.session_id,
        baseSourceSeq, snapshotEpoch, beginAttempted: false,
        expectedSourceSeq: state?.lastSourceSeq || String(row.ack_seq), expectedServerSeq: state?.lastSeq || row.server_seq, parts, ...(fileSet ? { fileSet } : {}),
        owner: { ...this.owner! }, environment: this.remoteEnvironment(), deviceId: this.registration!.deviceId,
        ...(useV2 ? { syncProtocolVersion: RemoteRetention.Version, expectedStreamEpoch: row.stream_epoch, migration } : {}), manifest };
      saved = this.deps.store.transaction(() => {
        this.deps.store.put(key, prepared);
        if (migration) this.deps.store.freezeMigration(row.local_id);
        return prepared;
      });
    }
    let begun: any;
    saved.beginAttempted = true; this.deps.store.put(key, saved);
    try {
      begun = await this.api('/sync/imports', 'POST', { importId: saved.importId, deviceId: this.registration!.deviceId,
        owner: this.owner, localSessionId: row.local_id, sessionId: saved.sessionId, baseSourceSeq: saved.baseSourceSeq,
        expectedSourceSeq: saved.expectedSourceSeq, expectedServerSeq: saved.expectedServerSeq, manifest: saved.manifest,
        ...(saved.syncProtocolVersion === RemoteRetention.Version ? { syncProtocolVersion: RemoteRetention.Version, expectedStreamEpoch: saved.expectedStreamEpoch } : {}), ...this.transport() });
    } catch (error) {
      assertCurrent();
      if (error instanceof RemoteApiError && error.code === 47025 && !saved.beginConfirmed
        && !error.data?.currentImport && !error.data?.activeImportId && typeof error.data?.currentSourceSeq === 'string' && /^\d+$/.test(error.data.currentSourceSeq)
        && typeof error.data?.currentServerSeq === 'string' && /^\d+$/.test(error.data.currentServerSeq)) {
        const source = retentionSequence(error.data.currentSourceSeq), server = retentionSequence(error.data.currentServerSeq);
        if (source >= BigInt(saved.expectedSourceSeq) && source <= BigInt(saved.baseSourceSeq)
          && source <= BigInt(this.deps.store.sync(row.local_id)!.source_seq) && server >= BigInt(saved.expectedServerSeq)) {
          // Rebase only a proven unallocated request. No durable source ACK is advanced.
          saved.expectedSourceSeq = source.toString(); saved.expectedServerSeq = server.toString();
          this.deps.store.put(key, saved); return;
        }
      }
      throw error;
    }
    assertCurrent();
    if (begun.sessionId !== saved.sessionId) throw new RemoteSyncStateError('Import changed the fixed remote session mapping');
    if (saved.syncProtocolVersion === RemoteRetention.Version) {
      if (begun.syncProtocolVersion !== RemoteRetention.Version || begun.importId !== saved.importId
        || begun.manifestHash !== saved.manifest.manifestHash || !begun.targetStreamEpoch
        || saved.targetStreamEpoch && saved.targetStreamEpoch !== begun.targetStreamEpoch
        || saved.expectedStreamEpoch && saved.expectedStreamEpoch !== begun.targetStreamEpoch) throw new RemoteSyncStateError('Import changed its reserved synchronization epoch');
      saved.targetStreamEpoch = begun.targetStreamEpoch;
    }
    saved.beginConfirmed = true; this.deps.store.put(key, saved);
    if (begun.state === 'aborted' || begun.state === 'expired') { this.discardImport(row); return; }
    let result = begun;
    if (begun.state !== 'committed') {
      if (begun.partsExpired) throw new RemoteSyncStateError('Uploading import lost its durable parts');
      for (const part of saved.parts) {
        if (this.ownershipSyncBlocked(row.local_id)) return;
        try {
          const encodedPayload = saved.fileSet ? await this.importSnapshots.read(saved.fileSet, part, current) : stableJson(part.payload);
          assertCurrent();
          const payload = saved.fileSet ? JSON.parse(encodedPayload) as { records: ProjectionRecord[] } : part.payload!;
          await this.uploadReplyContents(row.local_id, saved.sessionId, payload.records);
          assertCurrent();
          const metadata: Record<string, unknown> = { ...this.transport(), ...this.importProtocol(saved), payloadHash: part.payloadHash };
          // Canonical payload was encoded/hash-checked in the worker; do not traverse it again to encode the HTTP envelope.
          const envelope = `{${Object.keys({ ...metadata, payload: null }).sort().map(name => `${JSON.stringify(name)}:${name === 'payload' ? encodedPayload : stableJson(metadata[name])}`).join(',')}}`;
          await this.api(`/sync/imports/${saved.importId}/parts/${part.partNo}`, 'PUT', { ...metadata, payload }, true, 1, envelope);
        } catch (error) {
          if (error instanceof RemoteImportSnapshotError && error.message === 'REMOTE_IMPORT_PART_UNAVAILABLE') {
            await this.abortUnavailableImport(row, saved, current); return;
          }
          if (!(error instanceof RemoteApiError) || error.code !== 47025 || error.data?.reasonDetail !== 'IMPORT_PARTS_EXPIRED') throw error;
          const status = await this.api(`/sync/imports/${saved.importId}`);
          assertCurrent();
          if (status.state === 'committed') { this.completeImport(row, saved, status); return; }
          if (['aborted', 'expired'].includes(status.state)) { this.discardImport(row); return; }
          throw new RemoteSyncStateError('Import parts expired without a terminal receipt');
        }
        assertCurrent();
      }
      if (this.ownershipSyncBlocked(row.local_id)) return;
      result = await this.api(`/sync/imports/${saved.importId}/commit`, 'POST', { ...this.transport(), ...this.importProtocol(saved),
        expectedStateVersion: begun.stateVersion, manifestHash: saved.manifest.manifestHash });
    }
    assertCurrent();
    this.completeImport(row, saved, result);
    console.debug('[RemoteSync] Snapshot acknowledged locally', { localSessionId: row.local_id, importId: saved.importId, ...remoteSyncResultMetadata(result),
      sourceSeq: this.deps.store.sync(row.local_id)?.source_seq ?? null, needsSnapshot: Boolean(this.deps.store.sync(row.local_id)?.needs_snapshot) });
  }
  private assertImportIdentity(saved: SavedImport, receipt: any): void {
    if (receipt.importId && receipt.importId !== saved.importId || receipt.sessionId && receipt.sessionId !== saved.sessionId
      || receipt.manifestHash && receipt.manifestHash !== saved.manifest.manifestHash
      || saved.syncProtocolVersion === RemoteRetention.Version && (receipt.importId !== saved.importId || receipt.sessionId !== saved.sessionId
        || receipt.manifestHash !== saved.manifest.manifestHash || receipt.syncProtocolVersion !== RemoteRetention.Version
        || saved.targetStreamEpoch && receipt.targetStreamEpoch !== saved.targetStreamEpoch)) throw new RemoteSyncStateError('Import receipt identity mismatch');
  }
  private async abortUnavailableImport(row: SyncRow, saved: SavedImport, current: () => boolean): Promise<void> {
    const status = await this.api(`/sync/imports/${saved.importId}`);
    if (!current()) return;
    this.assertImportIdentity(saved, status);
    if (status.state === 'committed') { this.completeImport(row, saved, status); return; }
    if (['aborted', 'expired'].includes(status.state)) { this.discardImport(row); return; }
    if (status.state !== 'uploading' || status.importId !== saved.importId || status.sessionId !== saved.sessionId
      || status.manifestHash !== saved.manifest.manifestHash) throw new RemoteSyncStateError('Import loss has no matching terminal receipt');
    const aborted = await this.api(`/sync/imports/${saved.importId}/abort`, 'POST', { ...this.transport(), ...this.importProtocol(saved), expectedStateVersion: status.stateVersion, reason: 'parts_missing' });
    if (!current()) return;
    this.assertImportIdentity(saved, aborted);
    if (aborted.state === 'committed') this.completeImport(row, saved, aborted);
    else if (['aborted', 'expired'].includes(aborted.state)) this.discardImport(row);
    else throw new RemoteSyncStateError('Import abortion is not confirmed');
  }
  private async ensureRetentionFence(): Promise<void> {
    if (!this.owner || !this.registration || !this.retentionSupported || Date.now() - this.fenceCheckedAt < IDLE_POLL_MS) return;
    const rows = this.deps.store.sessions(this.owner);
    if (rows.some(row => row.sync_protocol_version !== RemoteRetention.Version || row.migration_frozen || this.deps.store.get(`import:${row.local_id}`))) return;
    const current = this.syncContext();
    const path = `/devices/${this.registration.deviceId}/sync-retention/fence`;
    const key = `retentionFence:${JSON.stringify([this.remoteEnvironment(), this.owner.userId, this.owner.scopeKey, this.registration.deviceId])}`;
    this.fenceCheckedAt = Date.now();
    try {
      const state = await this.api(path);
      if (!current()) return;
      if (state.minSyncProtocolVersion >= RemoteRetention.Version) { this.deps.store.remove(key); return; }
      // The server must also verify sessions unavailable in this local database.
      if (state.blockers?.length) return;
      const request = this.deps.store.get<any>(key) || { requestId: randomUUID(), expectedFenceVersion: state.syncProtocolFenceVersion, minSyncProtocolVersion: RemoteRetention.Version };
      this.deps.store.put(key, request);
      const result = await this.api(path, 'POST', { ...request, ...this.transport() });
      if (!current()) return;
      if (result.deviceId !== this.registration.deviceId || result.minSyncProtocolVersion !== RemoteRetention.Version) throw new RemoteSyncStateError('Invalid device protocol fence receipt');
      this.deps.store.remove(key);
    } catch (error) {
      if (!(error instanceof RemoteApiError) || ![409, 426].includes(error.httpStatus)) throw error;
      // Keep stable requestId across generation changes; blocked devices continue using per-session v2.
    }
  }
  private isGlobalError(error: unknown): boolean {
    if (error instanceof RemoteSyncStateError || error instanceof RemoteImportSnapshotError) return false;
    return !(error instanceof RemoteApiError) || [401, 403, 47000, 47013, 47023].includes(error.code) || error.code >= 500 && error.code < 600;
  }
  private async reportCommandError(entry: InboxEntry, error: unknown): Promise<void> {
    if (this.isGlobalError(error)) throw error;
    const current = (error as RemoteApiError).data?.currentCommand;
    if (current && BigInt(current.statusVersion) >= BigInt(entry.command.statusVersion)) {
      entry.command = { ...entry.command, ...current };
      if (['applied', 'rejected', 'expired'].includes(current.status)) entry.state = current.status === 'applied' ? 'applied' : 'rejected';
      this.deps.store.put(this.inboxKey(entry), entry);
    }
    this.deps.store.put(`commandFailure:${entry.command.commandId}`, { code: (error as RemoteApiError).code });
  }
  private async prepareInputs(): Promise<boolean> {
    const input = this.deps.input;
    const owner = this.owner;
    const deviceId = this.registration?.deviceId;
    const generation = this.generation;
    const epoch = this.accountGeneration;
    const route = this.deps.getApiBaseUrl(), targetId = this.targetId;
    const targetHeaders = remoteSyncTargetHeaders(this.registration?.syncTarget ?? null);
    if (!input || !owner || !deviceId || !generation) return false;
    const current = (): boolean => epoch === this.accountGeneration && this.generation === generation
      && route === this.deps.getApiBaseUrl() && targetId === this.targetId
      && sameOwner(owner, this.owner) && sameOwner(owner, this.deps.getOwner()) && this.settings().enabled && !this.stopped;
    const response = await this.api(`/devices/${deviceId}/input-preparations/claim`, 'POST', { connectionGeneration: generation, limit: 1 });
    const items = Array.isArray(response) ? response : response.items || [];
    for (const raw of items) {
      if (!current()) return false;
      let claim: RemotePreparationClaim = { ...raw };
      let renewal: Promise<void> | null = null;
      let leaseFailed = false;
      let readySent = false;
      const proof = (): Record<string, unknown> => ({ connectionGeneration: generation, claimId: claim.claimId, claimToken: claim.claimToken,
        expectedStatusVersion: claim.statusVersion, ...(claim.grantVersion ? { grantVersion: claim.grantVersion } : {}) });
      const timer = setInterval(() => {
        if (renewal || !current() || leaseFailed) return;
        renewal = this.api(`/input-preparations/${claim.preparationId}/renew`, 'POST', proof())
          .then(value => { claim = { ...claim, ...value }; })
          .catch(() => { leaseFailed = true; })
          .finally(() => { renewal = null; });
      }, 10000);
      const permitted = (): boolean => current() && !leaseFailed && Date.now() < Date.parse(claim.claimUntil);
      try {
        const prepared = await input.preparations.prepare(owner, deviceId, claim, async assetId => {
          if (!permitted()) throw new Error('Input preparation context changed');
          const result = await this.deps.request(owner,
          `/api/remote/v1/input-assets/${encodeURIComponent(assetId)}/content?preparationId=${encodeURIComponent(claim.preparationId)}`, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { ...targetHeaders,
              'X-Remote-Device-Credential': `${deviceId}.${this.deps.identity.deviceKey}`,
              'X-Remote-Input-Claim-Id': claim.claimId, 'X-Remote-Input-Claim-Token': claim.claimToken,
              'X-Remote-Connection-Generation': generation,
            },
          });
          if (!permitted()) throw new Error('Input preparation context changed');
          return result;
        }, permitted);
        clearInterval(timer); if (renewal) await renewal;
        if (!permitted()) return false;
        readySent = true;
        const receipt = await this.api(`/input-preparations/${claim.preparationId}/result`, 'POST', { ...proof(), status: RemoteInputStatus.Ready,
          resolvedInput: prepared.resolvedInput, inputDigest: prepared.inputDigest });
        if (current() && receipt.readyExpiresAt) input.preparations.confirmReady(prepared.preparationId, owner, deviceId, receipt.readyExpiresAt);
      } catch (error) {
        clearInterval(timer); if (renewal) await renewal;
        if (readySent) throw error;
        if (!permitted()) return false;
        const allowed = new Set<string>([RemoteInputReason.ModelUnavailable, RemoteInputReason.ModelChanged, RemoteInputReason.AgentUnavailable, RemoteInputReason.Workspace, RemoteInputReason.Version]);
        const reason = error instanceof RemoteInputError && allowed.has(error.reason) ? error.reason : 'PREPARATION_FAILED';
        await this.api(`/input-preparations/${claim.preparationId}/result`, 'POST', { ...proof(), status: RemoteInputStatus.Failed, reason });
      } finally { clearInterval(timer); }
    }
    return items.length > 0;
  }
  private commandWorkspace(command: RemoteCommand): string | null {
    if (command.request?.inputSchemaVersion === 2) {
      if (!this.deps.input) throw new RemoteInputError(RemoteInputReason.Invalid);
      const prepared = this.deps.input.preparations.read(command.request.payload?.inputPreparationId, this.owner!, this.registration!.deviceId);
      if (command.request.payload.inputDigest !== prepared.inputDigest || payloadHash(command.request.payload.resolvedInput) !== prepared.inputDigest) throw new RemoteInputError(RemoteInputReason.Stale);
      this.deps.input.preparations.validate(prepared, this.owner!, this.registration!.deviceId, true);
      return command.type === 'create_session' ? prepared.cwd : null;
    }
    if (command.type !== 'create_session') return null;
    const payload = command.request?.payload;
    const explicit = payload?.agentId !== undefined || payload?.expectedAgentVersion !== undefined;
    if (explicit) {
      if (!this.agentCatalog || typeof payload.agentId !== 'string' || !/^[1-9]\d*$/u.test(payload.expectedAgentVersion)
        || typeof payload.workspaceId !== 'string') throw new RemoteAgentError(47019, 'COMMAND_INVALID', 'INVALID_AGENT_TARGET');
      // Already accepted extended commands remain recoverable when admission flags are disabled.
      return this.agentCatalog.resolve(this.owner!, this.registration!.deviceId, payload.agentId, payload.expectedAgentVersion, payload.workspaceId);
    }
    const settings = this.settings();
    if (settings.createSessionAvailable === false) throw new Error('Workspace unavailable');
    const workspace = payload?.workspaceId ? settings.workspaces.find(w => w.workspaceId === payload.workspaceId) : settings.workspaces[0];
    if (!workspace?.available) throw new Error('Workspace unavailable');
    return workspace.path;
  }
  private isEntryCurrent(entry: InboxEntry): boolean {
    return !!entry.owner && sameOwner(entry.owner, this.owner) && (entry.targetId === this.targetId || !entry.targetId && !this.targetId);
  }
  private inboxKey(entry: InboxEntry): string {
    const legacyKey = `inbox:${entry.command.commandId}`;
    const legacy = this.deps.store.get<InboxEntry>(legacyKey);
    return !entry.targetId || legacy?.targetId === entry.targetId ? legacyKey : `inbox:${entry.targetId}:${entry.command.commandId}`;
  }
  private readInbox(commandId: string): InboxEntry | null {
    const current = this.targetId ? this.deps.store.get<InboxEntry>(`inbox:${this.targetId}:${commandId}`) : null;
    const entry = current ?? this.deps.store.get<InboxEntry>(`inbox:${commandId}`);
    return entry && this.isEntryCurrent(entry) ? entry : null;
  }
  private async claim(): Promise<boolean> {
    const generation = this.generation;
    if (!generation || this.syncPaused()) return false;
    const result = await this.api(`/devices/${this.registration!.deviceId}/commands/claim`, 'POST', { connectionGeneration: generation, limit: 10 });
    const items = Array.isArray(result) ? result : result.items || [];
    for (const envelope of items) {
      const command: RemoteCommand = { ...envelope.command, ...envelope };
      delete (command as any).command;
      const existing = this.readInbox(command.commandId);
      if (this.syncPaused() || generation !== this.generation) break;
      if (existing) continue; // Only reconcile may decide whether an existing command can execute.
      let entry: InboxEntry;
      try {
        const request = command.request;
        if (!request || request.commandId !== command.commandId || request.type !== command.type || payloadHash(request) !== command.requestHash) throw new Error('Invalid claimed command');
        const text = request.inputSchemaVersion === 2 ? request.payload?.resolvedInput?.text : request.payload?.text;
        if (['create_session', 'send_message'].includes(command.type) && (typeof text !== 'string' || (!text.trim() && !(request.inputSchemaVersion === 2 && request.payload?.resolvedInput?.attachments?.length)) || Buffer.byteLength(text) > REMOTE_TEXT_BYTES)) throw new Error('Invalid remote text');
        const workspace = this.commandWorkspace(command);
        entry = this.deps.runSessionTransaction(() => {
          const prepared = this.deps.prepare(command, this.owner!, workspace);
          this.deps.store.bindRemote(prepared.localSessionId, prepared.remoteSessionId, this.registration!.deviceId);
          const value: InboxEntry = { ...(this.targetId ? { targetId: this.targetId } : {}), command, owner: this.owner!, ...prepared, state: 'prepared', result: null };
          this.deps.store.put(this.inboxKey(value), value);
          return value;
        });
      } catch (error) {
        entry = { ...(this.targetId ? { targetId: this.targetId } : {}), command, owner: this.owner!, localSessionId: null, remoteSessionId: command.sessionId || null,
          runId: command.runId || null, state: 'rejected', result: error instanceof RemoteAgentError ? { ...remoteError(error.code, error.reason, error.message), reasonDetail: error.reasonDetail } : remoteError(47019, 'COMMAND_INVALID', error instanceof Error ? error.message : 'Invalid command') };
        this.deps.store.put(this.inboxKey(entry), entry);
      }
      try { await this.applyEntry(entry, generation); } catch (error) { await this.reportCommandError(entry, error); }
    }
    return items.length >= 10;
  }
  private async ack(entry: InboxEntry, status: string): Promise<any> {
    if (!this.isEntryCurrent(entry)) throw new Error('Command belongs to another synchronization target');
    return this.api(`/commands/${entry.command.commandId}/ack`, 'POST', { ...this.transport(),
      claimId: entry.command.claimId, claimToken: entry.command.claimToken, expectedStatusVersion: entry.command.statusVersion,
      status, sessionId: entry.remoteSessionId, runId: entry.runId,
      result: status === 'applied' ? entry.result : null, error: status === 'rejected' ? entry.result : null });
  }
  private async applyEntry(entry: InboxEntry, generation: string): Promise<void> {
    if (!this.isEntryCurrent(entry)) return;
    const accountGeneration = this.accountGeneration;
    const route = this.deps.getApiBaseUrl();
    if (entry.state === 'rejected') { const result = await this.ack(entry, 'rejected'); entry.command = { ...entry.command, ...result }; this.deps.store.put(this.inboxKey(entry), entry); return; }
    if (this.syncPaused() || generation !== this.generation) return;
    const receipt = await this.ack(entry, 'received');
    entry.command = { ...entry.command, ...receipt };
    if (receipt.status !== 'received') {
      entry.state = receipt.status === 'applied' ? 'applied' : ['rejected', 'expired'].includes(receipt.status) ? 'rejected' : 'unknown';
      entry.result = receipt.result || receipt.error || null;
      this.deps.store.put(this.inboxKey(entry), entry); return;
    }
    this.deps.store.put(this.inboxKey(entry), entry);
    if (this.syncPaused() || accountGeneration !== this.accountGeneration || this.generation !== generation || !sameOwner(entry.owner, this.deps.getOwner())
      || Date.now() + 1000 >= Date.parse(entry.command.claimUntil || '') || Date.now() >= Date.parse(entry.command.expiresAt)) return;
    // COMMIT before invoking any runner. A crash from this point is unknown, never auto-replayed.
    const commitExecuting = (): void => { entry.state = 'executing'; this.deps.store.put(this.inboxKey(entry), entry); };
    if (this.deps.security) await this.deps.security.commit(entry.command.commandId, {
      owner: entry.owner, commandId: entry.command.commandId, requestHash: entry.command.requestHash,
      sessionId: entry.localSessionId, runId: entry.runId, phase: 'executing',
    }, commitExecuting);
    else commitExecuting();
    // Disk finalization may outlive a claim, switch, disable or remove. Never execute on the old permit.
    if (this.syncPaused() || accountGeneration !== this.accountGeneration || this.generation !== generation || !sameOwner(entry.owner, this.deps.getOwner())
      || !this.settings().enabled || Date.now() + 250 >= Date.parse(entry.command.claimUntil || '') || Date.now() >= Date.parse(entry.command.expiresAt)) return;
    try { entry.result = await this.deps.execute(entry, () => accountGeneration === this.accountGeneration && this.generation === generation
      && route === this.deps.getApiBaseUrl() && this.isEntryCurrent(entry)
      && sameOwner(entry.owner, this.deps.getOwner()) && this.settings().enabled && !this.syncPaused()
      && Date.now() + 250 < Date.parse(entry.command.claimUntil || '') && Date.now() < Date.parse(entry.command.expiresAt)); entry.state = 'applied'; }
    catch (error) {
      entry.state = error instanceof RemoteAgentError || error instanceof RemoteInputError ? 'rejected' : 'unknown';
      entry.result = error instanceof RemoteInputError ? remoteError(47019, error.reason, error.reason)
        : error instanceof RemoteAgentError ? { ...remoteError(error.code, error.reason, error.message), reasonDetail: error.reasonDetail } : null;
      if (error instanceof RemoteApprovalError) this.mergeApprovalOutcome(entry, error.outcome);
      if (error instanceof RemoteQuestionError) this.mergeQuestionOutcome(entry, error.outcome);
      if (['create_session', 'send_message'].includes(entry.command.type) && entry.state === 'rejected' && entry.localSessionId && entry.runId
        && this.deps.store.get<boolean>(`runPublished:${entry.runId}`) === false) this.deps.store.updateRun(entry.localSessionId, 'failed');
    }
    this.deps.store.put(this.inboxKey(entry), entry);
    if (accountGeneration !== this.accountGeneration || !this.isEntryCurrent(entry)) return;
    if (entry.state === 'applied' || entry.state === 'rejected') { const result = await this.ack(entry, entry.state); entry.command = { ...entry.command, ...result }; this.deps.store.put(this.inboxKey(entry), entry); }
  }
  private mergeApprovalOutcome(entry: InboxEntry, outcome: ApprovalDecisionOutcome): void {
    if (outcome.kind === 'confirmed') {
      entry.state = 'applied'; entry.result = { outcome: 'approval_applied' };
    } else if (outcome.kind === 'known_not_applied') {
      entry.state = 'rejected'; entry.result = approvalCommandError(outcome.reason);
    } else if (!['applied', 'rejected'].includes(entry.state)) {
      entry.state = 'unknown'; entry.result = null;
    }
  }
  private mergeQuestionOutcome(entry: InboxEntry, outcome: QuestionDecisionOutcome): void {
    if (outcome.kind === 'confirmed' && outcome.status === (entry.command.request.payload.action === 'answer' ? 'answered' : 'cancelled')) {
      entry.state = 'applied'; entry.result = { outcome: 'question_applied' };
    } else if (outcome.kind === 'known_not_applied') {
      const detail = outcome.reason || 'QUESTION_CHANGED';
      const code = /EXPIRED/u.test(detail) ? 47018 : /UNAVAILABLE|UNSUPPORTED|LOCAL_ONLY/u.test(detail) ? 47017 : /INVALID/u.test(detail) ? 47019 : 47024;
      const reason = code === 47018 ? 'COMMAND_EXPIRED' : code === 47017 ? 'CAPABILITY_UNSUPPORTED' : code === 47019 ? 'INVALID_REQUEST' : 'COMMAND_STATE_CONFLICT';
      entry.state = 'rejected'; entry.result = { ...remoteError(code, reason, 'Question is no longer available for this submission'), reasonDetail: detail };
    } else if (!['applied', 'rejected'].includes(entry.state)) {
      entry.state = 'unknown'; entry.result = null;
    }
  }
  private async reconcilePaused(): Promise<void> {
    if (!this.registration || !this.owner) return;
    const epoch = this.accountGeneration, targetId = this.targetId, route = this.deps.getApiBaseUrl();
    const current = (): boolean => epoch === this.accountGeneration && targetId === this.targetId && route === this.deps.getApiBaseUrl();
    const rows = this.deps.store.entries<InboxEntry>('inbox:', this.receiptCursor, 20);
    this.receiptCursor = rows.length === 20 ? rows.at(-1)!.key : undefined;
    const selected = rows.filter(row => this.isEntryCurrent(row.value)
      && row.value.command.claimId && !['applied', 'rejected', 'expired'].includes(row.value.command.status));
    for (const { key, value: entry } of selected) {
      if (!current() || !this.isEntryCurrent(entry) || !sameOwner(entry.owner, this.deps.getOwner()) || !this.syncPaused()) return;
      try {
        if (entry.command.type === RemoteQuestion.Command && this.deps.reconcileQuestion && !['applied', 'rejected'].includes(entry.state)) {
          const outcome = await this.deps.reconcileQuestion(entry);
          if (!current() || !this.isEntryCurrent(entry) || !sameOwner(entry.owner, this.deps.getOwner()) || !this.syncPaused()) return;
          if (outcome) { this.mergeQuestionOutcome(entry, outcome); this.deps.store.put(key, entry); }
        }
        const result = await this.api(`/commands/${entry.command.commandId}/reconcile`, 'POST', { mode: 'recovery',
          expectedStatusVersion: entry.command.statusVersion, claimId: entry.command.claimId,
          ...(entry.command.claimToken ? { claimToken: entry.command.claimToken } : {}), sessionId: entry.remoteSessionId, runId: entry.runId,
          observedExecution: entry.state === 'applied' ? 'applied' : entry.state === 'rejected' ? 'not_applied' : 'unknown',
          result: entry.state === 'applied' ? entry.result : null, error: entry.state === 'rejected' ? entry.result : null,
          requestExecutionPermit: false });
        entry.command = { ...entry.command, ...result.command };
        if (['applied', 'rejected', 'expired'].includes(entry.command.status)) {
          entry.state = entry.command.status === 'applied' ? 'applied' : 'rejected';
          entry.result = result.command.result || result.command.error || entry.result;
        }
        this.deps.store.put(key, entry);
      } catch (error) {
        if (!current()) return;
        const command = error instanceof RemoteApiError && error.code === 47024 ? error.data?.currentCommand : null;
        if (command?.commandId === entry.command.commandId && command.sessionId === entry.remoteSessionId && command.runId === entry.runId
          && typeof command.statusVersion === 'string' && /^[1-9]\d*$/u.test(command.statusVersion)) {
          entry.command = { ...entry.command, ...command };
          this.deps.store.put(key, entry);
          continue;
        }
        if (!(error instanceof RemoteApiError) || ![47006, 47008, 47009].includes(error.code)) throw error;
      }
    }
  }
  private async reconcile(): Promise<void> {
    const epoch = this.accountGeneration, targetId = this.targetId, route = this.deps.getApiBaseUrl();
    const current = (): boolean => epoch === this.accountGeneration && targetId === this.targetId && route === this.deps.getApiBaseUrl();
    await this.deps.store.waitRunRecovery();
    await this.deps.store.verifyExecutionDatabaseHealth();
    if (!current()) return;
    let cursor: string | null = null;
    do {
      const result = await this.api(`/devices/${this.registration!.deviceId}/commands?state=unresolved&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const envelope of result.items || []) {
        if (!current() || this.syncPaused()) return;
        const command: RemoteCommand = { ...envelope.command, ...envelope };
        delete (command as any).command;
        if (command.detailState === RemoteRetention.Compacted) {
          if (!['applied', 'rejected', 'expired'].includes(command.status)) throw new Error('A nonterminal command cannot be compacted');
          const retained = this.readInbox(command.commandId);
          if (retained && sameOwner(retained.owner, this.owner)) {
            retained.command = { ...retained.command, ...command };
            retained.state = command.status === 'applied' ? 'applied' : 'rejected';
            retained.result = envelope.result || envelope.error || retained.result;
            this.deps.store.put(this.inboxKey(retained), retained);
          }
          continue;
        }
        let entry = this.readInbox(command.commandId);
        if (entry && !this.isEntryCurrent(entry)) continue;
        if (!entry && !['approval_response', RemoteQuestion.Command].includes(command.type) && envelope.currentClaimId && this.deps.store.hasCompleteExecutionHistory()
          && payloadHash(command.request) === command.requestHash
          && !this.deps.store.entries<any>('run:').some(row => row.value.runId === command.runId)) {
          try {
            const workspace = this.commandWorkspace(command);
            entry = this.deps.runSessionTransaction(() => {
              const prepared = this.deps.prepare(command, this.owner!, workspace);
              this.deps.store.bindRemote(prepared.localSessionId, prepared.remoteSessionId, this.registration!.deviceId);
              const value: InboxEntry = { ...(this.targetId ? { targetId: this.targetId } : {}), owner: this.owner!, command: { ...command, claimId: envelope.currentClaimId }, ...prepared, state: 'prepared', result: null };
              this.deps.store.put(this.inboxKey(value), value); return value;
            });
          } catch (error) {
            if (error instanceof RemoteAgentError) {
              // Complete local history and no matching run prove this lost claim never started.
              // Persist not-started evidence without inventing the lost claim token. A fresh
              // permit is needed to ACK local rejection if the server still considers it valid.
              entry = { ...(this.targetId ? { targetId: this.targetId } : {}), owner: this.owner!, command: { ...command, claimId: envelope.currentClaimId }, localSessionId: null,
                remoteSessionId: command.sessionId || null, runId: command.runId || null, state: 'prepared', result: null,
                preparationError: { ...remoteError(error.code, error.reason, error.message), reasonDetail: error.reasonDetail } };
              this.deps.store.put(this.inboxKey(entry), entry);
            }
          }
        }
        if (!entry) {
          if (command.status !== 'accepted') await this.api(`/commands/${command.commandId}/reconcile`, 'POST', {
            ...this.transport(), expectedStatusVersion: command.statusVersion, sessionId: command.sessionId || null,
            runId: command.runId || null, observedExecution: 'unknown', result: null, error: null, requestExecutionPermit: false,
          });
          continue;
        }
        try {
        if (entry.command.type === 'approval_response' && this.deps.reconcileApproval) {
          const outcome = await this.deps.reconcileApproval(entry);
          if (!current()) return;
          if (outcome) { this.mergeApprovalOutcome(entry, outcome); this.deps.store.put(this.inboxKey(entry), entry); }
        }
        if (entry.command.type === RemoteQuestion.Command && this.deps.reconcileQuestion) {
          const outcome = await this.deps.reconcileQuestion(entry);
          if (!current()) return;
          if (outcome) { this.mergeQuestionOutcome(entry, outcome); this.deps.store.put(this.inboxKey(entry), entry); }
        }
        const observedExecution = entry.state === 'applied' ? 'applied' : entry.state === 'rejected' ? 'not_applied'
          : !['approval_response', RemoteQuestion.Command].includes(entry.command.type) && entry.state === 'prepared' && this.deps.store.hasCompleteExecutionHistory()
            && (!entry.runId || this.deps.store.get<boolean>(`runPublished:${entry.runId}`) !== true) ? 'not_started' : 'unknown';
        const reconciled = await this.api(`/commands/${command.commandId}/reconcile`, 'POST', { ...this.transport(),
          expectedStatusVersion: command.statusVersion, claimId: entry.command.claimId, ...(entry.command.claimToken ? { claimToken: entry.command.claimToken } : {}),
          sessionId: entry.remoteSessionId, runId: entry.runId, observedExecution, result: entry.state === 'applied' ? entry.result : null,
          error: entry.state === 'rejected' ? entry.result : null,
          localEvidence: observedExecution === 'not_started' ? { databaseHealthy: this.deps.store.hasCompleteExecutionHistory(), historyComplete: this.deps.store.hasCompleteExecutionHistory(), inboxPersisted: true, executionNeverStarted: true } : null, requestExecutionPermit: observedExecution === 'not_started' && !!this.generation });
        entry.command = { ...entry.command, ...reconciled.command };
        if (['applied', 'rejected', 'expired'].includes(entry.command.status)) {
          entry.state = entry.command.status === 'applied' ? 'applied' : 'rejected';
          entry.result = reconciled.command.result || reconciled.command.error || entry.result;
          if (['create_session', 'send_message'].includes(entry.command.type) && entry.state === 'rejected' && entry.localSessionId && entry.runId
            && this.deps.store.get<boolean>(`runPublished:${entry.runId}`) === false) this.deps.store.updateRun(entry.localSessionId, 'failed');
        }
        if (reconciled.executionPermit) entry.command = { ...entry.command, ...reconciled.executionPermit };
        this.deps.store.put(this.inboxKey(entry), entry);
        if (!['approval_response', RemoteQuestion.Command].includes(entry.command.type) && reconciled.executionPermit && this.generation && !['applied', 'rejected', 'expired'].includes(entry.command.status)) {
          if (entry.preparationError) { entry.state = 'rejected'; entry.result = entry.preparationError; this.deps.store.put(this.inboxKey(entry), entry); }
          await this.applyEntry(entry, this.generation);
        }
        } catch (error) { await this.reportCommandError(entry, error); }
      }
      cursor = result.nextCursor || null;
    } while (cursor);
  }
}
