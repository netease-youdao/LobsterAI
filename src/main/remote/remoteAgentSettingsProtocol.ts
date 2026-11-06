import { randomUUID } from 'crypto';

import { RemoteAgentSettings, type RemoteAgentSettingsAccessState, RemoteAgentSettingsAction, type RemoteAgentSettingsAuthorization, type RemoteAgentSettingsBinding, type RemoteAgentSettingsCandidate, type RemoteAgentSettingsRevoke,RemoteAgentSettingsSection, RemoteAgentSettingsStatus } from '../../shared/remote/agentSettings';
import type { AgentSettingsService } from '../libs/agentSettings/service';
import { type AgentSettingsAction, type AgentSettingsContext, type AgentSettingsPersistence, AgentSettingsPhase, type AgentSettingsReceipt, type AgentSettingsSnapshot,AgentSettingsSource } from '../libs/agentSettings/types';
import { payloadHash, sameOwner, stableJson } from './canonical';
import { type LocalSettingsBinding, type PendingSettingsAccess, RemoteAgentSettingsAccess, type RemoteAgentSettingsConnection, settingsIdentity } from './remoteAgentSettingsAccess';

export interface RemoteAgentSettingsDependencies {
  service: Pick<AgentSettingsService, 'read' | 'prepare' | 'apply' | 'recover'>;
  store: AgentSettingsPersistence;
  available(): boolean;
  refreshAvailability?(): Promise<boolean>;
  conversationReady(): boolean;
  listAgents(): Array<{ agentId: string; name: string }>;
}
interface ProtocolDependencies extends RemoteAgentSettingsDependencies {
  connection(): RemoteAgentSettingsConnection | null;
  request(path: string, method: string, body?: unknown): Promise<unknown>;
}
interface OperationRequest {
  schemaVersion: number; operationId: string; type: 'read' | 'update'; section: RemoteAgentSettingsSection;
  bindingId: string; bindingVersion: string; accountEpoch: string; issuedAt: string; expiresAt: string;
  expectedRevision?: string; value?: unknown;
}
export interface SettingsConversationAccess {
  context: AgentSettingsContext; binding: LocalSettingsBinding; connectionGeneration: string; connection: RemoteAgentSettingsConnection;
}
export interface SettingsConversationProposal {
  operationId: string; commandId: string; runId: string; toolCallId: string; section: RemoteAgentSettingsSection;
  expectedRevision: string; proposedDigest: string; changeKind: string; approvalId: string;
}
interface ClaimResponse {
  operation: { operationId: string; source: string; type: string; agentId: string; deviceId: string; section: RemoteAgentSettingsSection; bindingId: string; bindingVersion: string; accountEpoch: string };
  request: OperationRequest; requestHash: string; claimId: string; claimToken: string; leaseExpiresAt: string; expiresAt: string;
}
interface Permit { permitId: string; permitToken: string; startBefore: string; operationId: string }
const Phase = { Registering: 'registering', Recovery: 'receipt_only', Claimed: 'claimed', Prepared: 'prepared', PermitRequested: 'permit_requested', Permitted: 'permitted', Reading: 'reading', Succeeded: 'succeeded', Applied: 'applied', Rejected: 'rejected', Unknown: 'unknown', Settled: 'settled' } as const;
type Phase = typeof Phase[keyof typeof Phase];
interface Journal {
  operationId: string; identity: string; context: AgentSettingsContext; connection: RemoteAgentSettingsConnection;
  section: RemoteAgentSettingsSection; type: 'read' | 'update' | 'conversation_update'; phase: Phase;
  request: OperationRequest | null; requestHash: string; claimId: string; claimToken: string; leaseExpiresAt: string; expiresAt: string;
  permitLocalStartBefore?: number; recoveryToken?: string; recoveryPermitIssued?: boolean; prepareBody?: Record<string, unknown>; revision?: string; proposalHash?: string; lastOutcome?: string; permit?: Permit; receipt?: AgentSettingsReceipt; result?: AgentSettingsSnapshot;
  receiptId: string; settleReceiptId: string; error?: { reason: string }; updatedAt: number;
}
const INDEX_KEY = 'remote-agent-settings-operations-v1';
const journalKey = (id: string): string => `remote-agent-settings-operation:${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/iu;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export function agentSettingsErrorReason(error: unknown): string {
  const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const data = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {};
  // RemoteApiError carries the business reason in data; never persist free-form server messages.
  for (const value of [data.reason, raw.reason, error instanceof Error ? error.message : undefined]) {
    if (typeof value === 'string' && /^[A-Z][A-Z_]{1,79}$/u.test(value)) return value;
  }
  return 'SETTINGS_UNAVAILABLE';
}
const encode = encodeURIComponent;
const textSection = (section: RemoteAgentSettingsSection): boolean => ![RemoteAgentSettingsSection.Model, RemoteAgentSettingsSection.Collaboration].includes(section as typeof RemoteAgentSettingsSection.Model);
/** HTTP operations and local authorization remain separate from the legacy session command queue. */
export class RemoteAgentSettingsProtocol {
  readonly access: RemoteAgentSettingsAccess;
  private supported = false;
  private working: Promise<void> | null = null;
  private pollAfter = 0;
  private poisoned = false;
  private accessBusy = false;
  private availabilityWork: Promise<boolean> | null = null;
  private readonly inFlight = new Set<string>();
  private recoveryCursor: string | null = null;
  constructor(private readonly deps: ProtocolDependencies) { this.access = new RemoteAgentSettingsAccess(deps.store); }
  configure(serverSupported: boolean): void { this.supported = serverSupported; }
  async refreshAvailability(): Promise<boolean> {
    if (!this.deps.refreshAvailability) return this.deps.available();
    if (this.availabilityWork) return this.availabilityWork;
    const work = this.deps.refreshAvailability().catch(() => false).finally(() => { if (this.availabilityWork === work) this.availabilityWork = null; });
    this.availabilityWork = work; return work;
  }
  available(): boolean { return this.supported && !this.poisoned && this.deps.available(); }
  fence(): void { this.pollAfter = 0; this.access.fence(); }
  private connection(active = true): RemoteAgentSettingsConnection {
    const connection = this.deps.connection();
    if (!connection || active && (!this.available() || !connection.active || !connection.connectionGeneration)) throw new Error('SETTINGS_UNAVAILABLE');
    this.access.activate(connection); this.access.current(connection, active); return connection;
  }
  assertRecoveryAccess(context: AgentSettingsContext): void {
    const current = this.deps.connection();
    if (!current || !sameOwner(context.owner, current.owner) || context.dataSpaceId !== current.dataSpaceId
      || context.dataGeneration !== current.dataGeneration || context.deviceId !== current.deviceId) throw new Error('SETTINGS_ACCESS_STALE');
  }
  assertAccess(context: AgentSettingsContext, section: RemoteAgentSettingsSection, action: AgentSettingsAction): void {
    if (action === RemoteAgentSettingsAction.ConversationUpdate && !this.deps.conversationReady()) throw new Error('SETTINGS_UNAVAILABLE');
    this.access.assertAccess(this.connection(), context, section, action);
  }
  private context(connection: RemoteAgentSettingsConnection, binding: LocalSettingsBinding, source: 'app' | 'conversation'): AgentSettingsContext {
    return { owner: { ...connection.owner }, dataSpaceId: connection.dataSpaceId, dataGeneration: connection.dataGeneration,
      deviceId: connection.deviceId, agentId: binding.agentId, accountEpoch: binding.accountEpoch,
      bindingId: binding.bindingId, bindingVersion: binding.bindingVersion, source };
  }
  private assertConnection(expected: RemoteAgentSettingsConnection, active = true): RemoteAgentSettingsConnection {
    const current = this.connection(active);
    if (settingsIdentity(expected) !== settingsIdentity(current) || active && current.connectionGeneration !== expected.connectionGeneration) throw new Error('SETTINGS_ACCESS_STALE');
    return current;
  }
  async state(): Promise<RemoteAgentSettingsAccessState> {
    await this.refreshAvailability();
    const current = this.deps.connection();
    const base: RemoteAgentSettingsAccessState = { supported: this.available() && !!current?.active, conversationReady: this.deps.conversationReady(),
      accountEpoch: this.access.epoch(), owner: current?.owner ?? null, candidates: [], agents: [], bindings: [] };
    if (!current) return base;
    this.access.activate(current); base.accountEpoch = this.access.epoch();
    base.bindings = this.access.bindings(current).map(({ identity: _identity, connection: _connection, ...binding }) => binding);
    if (!base.supported) return base;
    let data: { items: RemoteAgentSettingsCandidate[] };
    try { data = await this.deps.request(`/devices/${encode(current.deviceId)}/agent-settings-access-candidates`, 'GET') as typeof data; }
    catch { this.assertConnection(current, false); return { ...base, supported: false }; }
    this.assertConnection(current);
    if (!Array.isArray(data?.items) || data.items.length > 200) throw new Error('SETTINGS_INVALID_RESPONSE');
    base.candidates = data.items.filter(item => item && SAFE_ID.test(item.mobileDeviceId) && SAFE_ID.test(item.grantId)
      && /^[1-9]\d{0,18}$/u.test(item.grantVersion) && typeof item.name === 'string' && item.name.length <= 200);
    base.agents = this.deps.listAgents(); return base;
  }
  async authorize(input: RemoteAgentSettingsAuthorization): Promise<RemoteAgentSettingsAccessState> {
    if (this.accessBusy) throw new Error('SETTINGS_OPERATION_PENDING');
    this.accessBusy = true;
    try {
      const connection = this.connection();
      if (!this.deps.listAgents().some(agent => agent.agentId === input.agentId)) throw new Error('AGENT_UNAVAILABLE');
      const pending = this.access.authorize(connection, input, this.deps.conversationReady());
      await this.publishAccess(pending); return await this.state();
    } finally { this.accessBusy = false; }
  }
  async revoke(input: RemoteAgentSettingsRevoke): Promise<RemoteAgentSettingsAccessState> {
    if (this.accessBusy) throw new Error('SETTINGS_OPERATION_PENDING');
    this.accessBusy = true;
    try {
      const connection = this.connection(false);
      if (input.expectedAccountEpoch !== this.access.epoch()) throw new Error('SETTINGS_ACCESS_STALE');
      const pending = this.access.revoke(connection, input.bindingId, input.bindingVersion);
      // The durable local fence takes effect even when publication must wait for reconnection.
      if (connection.active && connection.connectionGeneration) {
        try { await this.publishAccess(pending); } catch { /* Retain the revoke intent. */ }
      }
      return await this.state();
    } finally { this.accessBusy = false; }
  }
  private async reconcileAccess(current: RemoteAgentSettingsConnection): Promise<void> {
    if (this.accessBusy) throw new Error('SETTINGS_OPERATION_PENDING');
    this.accessBusy = true;
    try {
      for (const pending of this.access.pending(current)) {
        if (pending.kind === 'authorize' && pending.connection.connectionGeneration !== current.connectionGeneration) {
          // An uncertain old grant is not silently renewed on a new connection.
          this.access.discardPending(pending.requestId); continue;
        }
        await this.publishAccess(pending);
      }
      const result = await this.deps.request(`/devices/${encode(current.deviceId)}/agent-settings-access`, 'GET') as { items: RemoteAgentSettingsBinding[] };
      this.assertConnection(current);
      if (!Array.isArray(result?.items) || result.items.length > 1000) throw new Error('SETTINGS_INVALID_RESPONSE');
      this.access.reconcile(current, result.items);
      for (const pending of this.access.pending(current)) await this.publishAccess(pending);
    } finally { this.accessBusy = false; }
  }
  private async publishAccess(pending: PendingSettingsAccess): Promise<void> {
    const current = this.connection();
    if (settingsIdentity(current) !== pending.identity) throw new Error('SETTINGS_ACCESS_STALE');
    const common = { requestId: pending.requestId, connectionGeneration: pending.connection.connectionGeneration, accountEpoch: pending.accountEpoch };
    if (pending.kind === 'authorize') {
      // Replaying an explicit decision uses the original immutable request; never rebind it to a new connection.
      const input = pending.input!;
      const value = await this.deps.request(`/devices/${encode(current.deviceId)}/agents/${encode(input.agentId)}/settings-access`, 'POST',
        { ...common, mobileDeviceId: input.mobileDeviceId, grantId: input.grantId, grantVersion: input.grantVersion, sections: input.sections }) as RemoteAgentSettingsBinding;
      this.assertConnection(pending.connection);
      if (!value || value.status !== RemoteAgentSettingsStatus.Active || value.agentId !== input.agentId
        || value.mobileDeviceId !== input.mobileDeviceId || value.grantId !== input.grantId || value.grantVersion !== input.grantVersion
        || value.accountEpoch !== pending.accountEpoch || typeof value.bindingId !== 'string' || !SAFE_ID.test(value.bindingId)
        || typeof value.bindingVersion !== 'string' || !/^[1-9]\d{0,18}$/u.test(value.bindingVersion)
        || stableJson(value.sections ?? null) !== stableJson(input.sections)) {
        // A repeat request may return an already revoked binding. It cannot revive local authority.
        this.access.discardPending(pending.requestId); throw new Error('SETTINGS_ACCESS_STALE');
      }
      this.access.confirm(pending, value);
    } else {
      await this.deps.request(`/agent-settings-access/${encode(pending.bindingId!)}/revoke`, 'POST',
        { ...common, connectionGeneration: current.connectionGeneration, expectedBindingVersion: pending.bindingVersion });
      this.assertConnection(current); this.access.confirm(pending, { bindingId: pending.bindingId!, bindingVersion: pending.bindingVersion! });
    }
  }
  async accessForConversation(input: { agentId: string; commandId: string; runId: string }): Promise<SettingsConversationAccess> {
    const connection = this.connection();
    if (!this.deps.conversationReady() || !Object.values(input).every(value => SAFE_ID.test(value))) throw new Error('CONVERSATION_SOURCE_INVALID');
    const value = await this.deps.request(`/devices/${encode(connection.deviceId)}/agents/${encode(input.agentId)}/conversation-settings-access?commandId=${encode(input.commandId)}&runId=${encode(input.runId)}`, 'GET') as RemoteAgentSettingsBinding & { commandId: string; runId: string };
    this.assertConnection(connection);
    if (value.commandId !== input.commandId || value.runId !== input.runId || value.agentId !== input.agentId) throw new Error('CONVERSATION_SOURCE_INVALID');
    const binding = this.access.resolve(connection, value.bindingId, value.bindingVersion, value.accountEpoch, input.agentId);
    if (!this.access.matches(binding, value)) throw new Error('SETTINGS_ACCESS_STALE');
    return { context: { ...this.context(connection, binding, AgentSettingsSource.Conversation), commandId: input.commandId, runId: input.runId },
      binding, connectionGeneration: connection.connectionGeneration!, connection };
  }
  async prepareConversation(access: SettingsConversationAccess, proposal: SettingsConversationProposal): Promise<{ operationId: string }> {
    this.assertConnection(access.connection); this.assertAccess(access.context, proposal.section, RemoteAgentSettingsAction.ConversationUpdate);
    if (!UUID.test(proposal.operationId) || !textSection(proposal.section) || proposal.commandId !== access.context.commandId
      || proposal.runId !== access.context.runId || !SAFE_ID.test(proposal.toolCallId) || !DIGEST.test(proposal.proposedDigest)
      || typeof proposal.approvalId !== 'string' || !SAFE_ID.test(proposal.approvalId)) throw new Error('CONVERSATION_SOURCE_INVALID');
    let journal = this.load(proposal.operationId);
    if (journal) {
      if (journal.context.commandId !== proposal.commandId || journal.context.runId !== proposal.runId || journal.context.toolCallId !== proposal.toolCallId
        || journal.section !== proposal.section || journal.proposalHash !== payloadHash(proposal)) throw new Error('SETTINGS_OPERATION_ID_CONFLICT');
    } else {
      const body = { ...proposal, connectionGeneration: access.connectionGeneration, bindingId: access.binding.bindingId,
        bindingVersion: access.binding.bindingVersion, accountEpoch: access.context.accountEpoch };
      journal = { operationId: proposal.operationId, identity: settingsIdentity(access.connection), context: { ...access.context, toolCallId: proposal.toolCallId },
        connection: access.connection, section: proposal.section, type: 'conversation_update', phase: Phase.Registering, request: null,
        prepareBody: body, proposalHash: payloadHash(proposal), requestHash: payloadHash({ deviceId: access.connection.deviceId,
          agentId: access.context.agentId, body, target: { version: 1, dataSpaceId: access.context.dataSpaceId, dataGeneration: access.context.dataGeneration } }),
        claimId: '', claimToken: '', leaseExpiresAt: '', expiresAt: '', receiptId: randomUUID(), settleReceiptId: randomUUID(), updatedAt: Date.now() };
      // Persist source/intent and the immutable prepare request before its first HTTP submission.
      this.save(journal);
    }
    this.inFlight.add(proposal.operationId);
    // The host owns this in-process intent until complete(), including bounded approval-fact retries.
    if (journal.phase === Phase.Registering) await this.registerConversation(journal);
    if (journal.phase === Phase.Recovery || journal.phase === Phase.Settled) throw new Error('SETTINGS_OPERATION_PENDING');
    return { operationId: proposal.operationId };
  }
  private async registerConversation(journal: Journal): Promise<void> {
    this.assertRecoveryAccess(journal.context);
    if (!journal.prepareBody) throw new Error('LOCAL_CLEANUP_REQUIRED');
    // Retrying the exact old generation can recover the original claim, never a new permit.
    const value = await this.deps.request(`/devices/${encode(journal.context.deviceId)}/agents/${encode(journal.context.agentId)}/conversation-changes`,
      'POST', journal.prepareBody) as Omit<ClaimResponse, 'operation' | 'request'> & {
        recoveryMode?: string; recoveryToken?: string; permitIssued?: boolean; status?: string;
      };
    if (value.requestHash !== journal.requestHash) throw new Error('SETTINGS_OPERATION_ID_CONFLICT');
    if (value.recoveryMode === Phase.Recovery) {
      if (['applied', 'succeeded', 'rejected', 'expired'].includes(value.status ?? '')) {
        // Remote terminal evidence closes registration recovery; it never proves a local write happened.
        try { await this.deps.service.recover(journal.context, journal.operationId); } catch { /* Preserve the domain's unknown evidence. */ }
        journal.phase = Phase.Settled; this.save(journal); return;
      }
      if (!SAFE_ID.test(value.claimId) || typeof value.recoveryToken !== 'string' || value.recoveryToken.length < 16
        || value.recoveryToken.length > 4096 || typeof value.permitIssued !== 'boolean') throw new Error('SETTINGS_INVALID_RESPONSE');
      journal.claimId = value.claimId; journal.recoveryToken = value.recoveryToken;
      journal.recoveryPermitIssued = value.permitIssued; journal.phase = Phase.Recovery; this.save(journal); return;
    }
    this.validateCredentials(value);
    journal.claimId = value.claimId; journal.claimToken = value.claimToken; journal.leaseExpiresAt = value.leaseExpiresAt;
    journal.expiresAt = value.expiresAt; journal.phase = Phase.Prepared; this.save(journal);
  }
  private index(): string[] {
    const ids = this.deps.store.get<string[]>(INDEX_KEY) ?? [];
    if (!Array.isArray(ids) || ids.some(id => !UUID.test(id)) || ids.length > 10000) throw new Error('LOCAL_CLEANUP_REQUIRED');
    return ids;
  }
  private load(operationId: string): Journal | null { return this.deps.store.get<Journal>(journalKey(operationId)); }
  private save(journal: Journal): void {
    journal.updatedAt = Date.now();
    try {
      this.deps.store.set(journalKey(journal.operationId), journal);
      const ids = this.index(); if (!ids.includes(journal.operationId)) { ids.push(journal.operationId); this.deps.store.set(INDEX_KEY, ids); }
    } catch (error) { this.poisoned = true; throw error; }
  }
  private validateCredentials(value: Omit<ClaimResponse, 'operation' | 'request'>): void {
    if (!value || !DIGEST.test(value.requestHash) || !SAFE_ID.test(value.claimId) || typeof value.claimToken !== 'string'
      || value.claimToken.length < 16 || value.claimToken.length > 512 || !Number.isFinite(Date.parse(value.leaseExpiresAt)) || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('SETTINGS_INVALID_RESPONSE');
  }
  private accept(value: ClaimResponse, connection: RemoteAgentSettingsConnection): Journal {
    this.validateCredentials(value);
    const request = value.request, operation = value.operation;
    if (!request || !operation || !UUID.test(request.operationId) || request.schemaVersion !== RemoteAgentSettings.SchemaVersion
      || !['read', 'update'].includes(request.type) || operation.source !== AgentSettingsSource.App || operation.deviceId !== connection.deviceId
      || operation.type !== request.type || operation.operationId !== request.operationId || operation.section !== request.section
      || operation.bindingId !== request.bindingId || operation.bindingVersion !== request.bindingVersion || operation.accountEpoch !== request.accountEpoch
      || !Object.values(RemoteAgentSettingsSection).includes(request.section) || request.type === 'update' && textSection(request.section)
      || request.type === 'update' && (typeof request.expectedRevision !== 'string' || request.value === undefined)
      || request.type === 'read' && (request.value !== undefined || request.expectedRevision !== undefined)
      || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) > Date.parse(value.expiresAt)
      || Object.keys(request).some(key => !['schemaVersion', 'operationId', 'type', 'section', 'bindingId', 'bindingVersion', 'accountEpoch', 'issuedAt', 'expiresAt', 'expectedRevision', 'value'].includes(key))) throw new Error('SETTINGS_INVALID_RESPONSE');
    if (payloadHash({ deviceId: connection.deviceId, agentId: operation.agentId, body: request,
      target: { version: 1, dataSpaceId: connection.dataSpaceId, dataGeneration: connection.dataGeneration } }) !== value.requestHash) throw new Error('SETTINGS_INVALID_RESPONSE');
    const binding = this.access.resolve(connection, request.bindingId, request.bindingVersion, request.accountEpoch, operation.agentId);
    const context = this.context(connection, binding, AgentSettingsSource.App);
    this.assertAccess(context, request.section, request.type === 'read' ? RemoteAgentSettingsAction.Read : RemoteAgentSettingsAction.DirectUpdate);
    return { operationId: request.operationId, identity: settingsIdentity(connection), context, connection, section: request.section, type: request.type,
      phase: Phase.Claimed, request, requestHash: value.requestHash, claimId: value.claimId, claimToken: value.claimToken,
      leaseExpiresAt: value.leaseExpiresAt, expiresAt: value.expiresAt, receiptId: randomUUID(), settleReceiptId: randomUUID(), updatedAt: Date.now() };
  }
  async acquirePermit(operationId: string): Promise<{ permitId: string; startBefore: number }> {
    const journal = this.load(operationId);
    if (!journal || journal.recoveryToken || ![Phase.Prepared, Phase.PermitRequested].includes(journal.phase as typeof Phase.Prepared)) throw new Error('SETTINGS_OPERATION_PENDING');
    this.assertConnection(journal.connection);
    this.assertAccess(journal.context, journal.section, journal.type === 'read' ? RemoteAgentSettingsAction.Read
      : journal.type === 'update' ? RemoteAgentSettingsAction.DirectUpdate : RemoteAgentSettingsAction.ConversationUpdate);
    if (Date.now() >= Math.min(Date.parse(journal.expiresAt), Date.parse(journal.leaseExpiresAt))) throw new Error('SETTINGS_OPERATION_EXPIRED');
    journal.permitLocalStartBefore ??= Date.now() + 5000;
    journal.phase = Phase.PermitRequested; this.save(journal);
    const permit = await this.deps.request(`/agent-settings-operations/${encode(operationId)}/permit`, 'POST', {
      connectionGeneration: journal.connection.connectionGeneration, claimId: journal.claimId, claimToken: journal.claimToken, requestHash: journal.requestHash,
      bindingId: journal.context.bindingId, bindingVersion: journal.context.bindingVersion, accountEpoch: journal.context.accountEpoch,
    }) as Permit;
    if (!permit || permit.operationId !== operationId || !SAFE_ID.test(permit.permitId) || typeof permit.permitToken !== 'string'
      || permit.permitToken.length < 16 || permit.permitToken.length > 512 || !Number.isFinite(Date.parse(permit.startBefore))) throw new Error('SETTINGS_INVALID_RESPONSE');
    journal.permit = permit; journal.phase = Phase.Permitted; this.save(journal);
    this.assertConnection(journal.connection);
    this.assertAccess(journal.context, journal.section, journal.type === 'read' ? RemoteAgentSettingsAction.Read
      : journal.type === 'update' ? RemoteAgentSettingsAction.DirectUpdate : RemoteAgentSettingsAction.ConversationUpdate);
    // A slow/incorrect wall clock must never turn a five-second permit into a longer write window.
    const startBefore = Math.min(Date.parse(permit.startBefore), journal.permitLocalStartBefore);
    if (Date.now() >= startBefore) throw new Error('SETTINGS_OPERATION_EXPIRED');
    return { permitId: permit.permitId, startBefore };
  }
  async complete(operationId: string, receipt: AgentSettingsReceipt): Promise<void> {
    this.inFlight.delete(operationId);
    const journal = this.load(operationId);
    if (!journal || receipt.operationId !== operationId || receipt.section !== journal.section) throw new Error('SETTINGS_OPERATION_ID_CONFLICT');
    if (journal.phase === Phase.Settled) return;
    journal.receipt = receipt;
    if (journal.phase === Phase.Registering) { this.save(journal); await this.recover(journal); return; }
    journal.phase = receipt.status === AgentSettingsPhase.Applied ? Phase.Applied : receipt.status === AgentSettingsPhase.Rejected ? Phase.Rejected : Phase.Unknown;
    journal.request = null; this.save(journal); await this.report(journal);
  }
  private async execute(journal: Journal): Promise<void> {
    try {
      if (journal.type === 'read') {
        journal.phase = Phase.Prepared; this.save(journal); const permit = await this.acquirePermit(journal.operationId);
        journal = this.load(journal.operationId)!; journal.phase = Phase.Reading; this.save(journal);
        this.assertConnection(journal.connection);
        if (Date.now() >= permit.startBefore) throw new Error('SETTINGS_OPERATION_EXPIRED');
        const result = await this.deps.service.read(journal.context, journal.section);
        this.assertConnection(journal.connection); this.assertAccess(journal.context, journal.section, RemoteAgentSettingsAction.Read);
        journal.result = result; journal.revision = result.revision; journal.phase = Phase.Succeeded; journal.request = null; this.save(journal); await this.report(journal);
      } else {
        const request = journal.request!;
        await this.deps.service.prepare(journal.context, { operationId: journal.operationId, section: journal.section,
          expectedRevision: request.expectedRevision!, value: request.value });
        journal.phase = Phase.Prepared; this.save(journal);
        const receipt = await this.deps.service.apply(journal.context, journal.operationId, () => this.acquirePermit(journal.operationId));
        await this.complete(journal.operationId, receipt);
      }
    } catch (error) {
      const latest = this.load(journal.operationId); if (!latest || latest.phase === Phase.Settled) return;
      latest.error = { reason: agentSettingsErrorReason(error) }; this.save(latest);
      await this.recover(latest);
    }
  }
  private async recover(journal: Journal): Promise<void> {
    if (journal.phase === Phase.Registering) await this.registerConversation(journal);
    if (journal.phase === Phase.Settled) return;
    if (journal.recoveryToken && journal.recoveryPermitIssued && !journal.permit) { journal.phase = Phase.Unknown; this.save(journal); await this.report(journal, true); return; }
    if ([Phase.Applied, Phase.Rejected, Phase.Succeeded].includes(journal.phase as typeof Phase.Applied)) {
      journal.revision ??= journal.result?.revision; delete journal.result; this.save(journal);
      await this.report(journal, true); return;
    }
    if (journal.type === 'read') {
      // A missing read receipt never authorizes another read; discard any body after reconnection.
      journal.phase = journal.phase === Phase.Reading ? Phase.Unknown : Phase.Rejected;
    } else if (journal.phase === Phase.Claimed) {
      // This durable phase precedes every possible permit. Release any domain-only prepared intent too.
      try { await this.deps.service.recover(journal.context, journal.operationId); } catch { /* No permit was requested. */ }
      journal.phase = Phase.Rejected;
    } else {
      try {
        const receipt = await this.deps.service.recover(journal.context, journal.operationId);
        journal.receipt = receipt;
        journal.phase = receipt.status === AgentSettingsPhase.Applied ? Phase.Applied : receipt.status === AgentSettingsPhase.Rejected ? Phase.Rejected : Phase.Unknown;
      } catch { journal.phase = Phase.Unknown; }
    }
    journal.request = null; delete journal.result; this.save(journal); await this.report(journal, true);
  }
  private async report(journal: Journal, recovery = false): Promise<void> {
    const current = this.connection(false);
    if (settingsIdentity(current) !== journal.identity) return;
    const credentials = { claimId: journal.claimId, ...(journal.recoveryToken ? { recoveryToken: journal.recoveryToken } : { claimToken: journal.claimToken }), requestHash: journal.requestHash,
      ...(journal.permit ? { permitId: journal.permit.permitId, permitToken: journal.permit.permitToken } : {}) };
    let active = false;
    try { this.assertConnection(journal.connection); this.assertAccess(journal.context, journal.section, RemoteAgentSettingsAction.Read); active = true; } catch { /* historical receipts use settle */ }
    const readResult = journal.result && (textSection(journal.section) ? journal.result : { revision: journal.result.revision, value: journal.result.value });
    const result = journal.phase === Phase.Succeeded ? readResult : journal.phase === Phase.Applied
      ? { revision: journal.receipt?.revision, effect: 'future_safe_boundary' } : null;
    if (!recovery && active && !journal.recoveryToken && journal.permit && journal.phase !== Phase.Unknown && result) {
      await this.deps.request(`/agent-settings-operations/${encode(journal.operationId)}/result`, 'POST', { ...credentials,
        connectionGeneration: journal.connection.connectionGeneration, receiptId: journal.receiptId,
        status: journal.phase === Phase.Succeeded ? 'succeeded' : 'applied', result, error: null });
    } else {
      const outcome = journal.phase === Phase.Applied ? 'applied' : journal.phase === Phase.Succeeded ? 'succeeded' : journal.phase === Phase.Rejected ? 'not_applied' : 'unknown';
      if (journal.lastOutcome !== outcome) { journal.settleReceiptId = randomUUID(); journal.lastOutcome = outcome; this.save(journal); }
      await this.deps.request(`/agent-settings-operations/${encode(journal.operationId)}/settle`, 'POST', { ...credentials,
        receiptId: journal.settleReceiptId, outcome, ...(['applied', 'succeeded'].includes(outcome) ? { revision: journal.receipt?.revision ?? journal.revision } : {}),
        error: outcome === 'unknown' ? journal.error ?? { reason: 'LOCAL_CLEANUP_REQUIRED' } : outcome === 'not_applied' ? journal.error ?? null : null });
    }
    // Unknown is unresolved, and must not be erased or automatically replayed.
    if (journal.phase !== Phase.Unknown) journal.phase = Phase.Settled;
    journal.request = null; delete journal.result; this.save(journal);
  }
  tick(): void {
    if (this.working || this.accessBusy || Date.now() < this.pollAfter || !this.deps.connection()) return;
    this.pollAfter = Date.now() + 5000;
    const work = this.poll().catch(() => { this.pollAfter = Date.now() + 15000; }).finally(() => { if (this.working === work) this.working = null; });
    this.working = work;
  }
  private async poll(): Promise<void> {
    await this.refreshAvailability();
    const current = this.connection(false);
    // Always reconcile local evidence before new work, including when remote access is disabled.
    for (const id of this.index()) {
      const journal = this.load(id);
      if (!journal) throw new Error('LOCAL_CLEANUP_REQUIRED');
      if (journal.identity !== settingsIdentity(current) || journal.phase === Phase.Settled || this.inFlight.has(id)) continue;
      await this.recover(journal);
    }
    if (!this.available() || !current.active || !current.connectionGeneration) return;
    // Server recovery pages are metadata only. Missing local secrets can never become new permission.
    const recovery = await this.deps.request(`/devices/${encode(current.deviceId)}/agent-settings-operations?unresolved=true&limit=20${this.recoveryCursor ? `&cursor=${encode(this.recoveryCursor)}` : ''}`, 'GET') as { items: Array<{ operationId: string; recoveryMode?: string }>; nextCursor?: string | null };
    this.assertConnection(current);
    if (!Array.isArray(recovery?.items) || recovery.items.length > 20) throw new Error('SETTINGS_INVALID_RESPONSE');
    this.recoveryCursor = typeof recovery.nextCursor === 'string' ? recovery.nextCursor : null;
    if (recovery.items.some(item => item.recoveryMode === 'receipt_only' && !this.load(item.operationId))) throw new Error('LOCAL_CLEANUP_REQUIRED');
    await this.reconcileAccess(current);
    const response = await this.deps.request(`/devices/${encode(current.deviceId)}/agent-settings-operations/claim`, 'POST',
      { connectionGeneration: current.connectionGeneration, limit: 5 }) as { items: ClaimResponse[] };
    this.assertConnection(current);
    if (!response || !Array.isArray(response.items) || response.items.length > 5 || Buffer.byteLength(stableJson(response)) > RemoteAgentSettings.MaxBatchBytes) throw new Error('SETTINGS_INVALID_RESPONSE');
    for (const item of response.items) {
      this.assertConnection(current);
      const journal = this.accept(item, current), existing = this.load(journal.operationId);
      if (existing) { if (existing.requestHash !== journal.requestHash) throw new Error('SETTINGS_OPERATION_ID_CONFLICT'); await this.recover(existing); continue; }
      this.save(journal); await this.execute(journal);
    }
  }
}
