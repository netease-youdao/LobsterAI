import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { resolve } from 'path';

import { AgentId, AgentOwnerKind } from '../../shared/agent/constants';
import type { ApprovalDecisionOutcome, ApprovalState } from '../../shared/cowork/approval';
import { parseModelThinkingLevel } from '../../shared/providers/modelThinking';
import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteInputOperationPhase, RemoteInputReason } from '../../shared/remote/input';
import { type QuestionDecisionOutcome, RemoteQuestion } from '../../shared/remote/questions';
import type { CoworkStore } from '../coworkStore';
import { t } from '../i18n';
import type { CoworkRuntime, PermissionRequest } from '../libs/agentEngine/types';
import { type OwnershipOperationGate, ownershipOperationGate } from '../ownershipOperationGate';
import { payloadHash, sameOwner } from './canonical';
import type { InputPreparationService, LocalPreparedInput } from './inputPreparationService';
import { RemoteAgentError, remoteAgentFailure } from './remoteAgentCatalog';
import { RemoteApprovalError } from './remoteApproval';
import type { InboxEntry, RemoteCommand } from './remoteBridge';
import { remoteDiagnostics } from './remoteDiagnostics';
import { RemoteInputError, type RemoteModelCatalog } from './remoteModelCatalog';
import { RemoteQuestionError } from './remoteQuestionService';

interface ExecutionContext { owner: RemoteOwner | null; preparedSessionId?: string; runId?: string; commandId?: string; stillPermitted?: () => boolean; assertAgentBinding?: () => void }
const context = new AsyncLocalStorage<ExecutionContext>();
const inputPreparationProcessId = randomUUID();
export const currentRemoteExecution = (): ExecutionContext | undefined => context.getStore();
export const assertRemoteExecutionPermit = (): void => {
  const active = context.getStore();
  if (active?.stillPermitted && !active.stillPermitted()) throw new Error('Remote execution permit expired or was revoked');
  active?.assertAgentBinding?.();
};
/** Call in the same synchronous dispatch section immediately before the first engine send. */
export const markRemoteExecutionDispatched = (): void => {
  assertRemoteExecutionPermit();
  const active = context.getStore();
  if (active) { active.stillPermitted = undefined; active.assertAgentBinding = undefined; }
};
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
interface InputFence {
  schemaVersion?: number;
  preparedProcessId?: string;
  operationId: string;
  phase: string;
  target?: { model?: string | null; thinkingLevel?: string | null };
  gatewayBootId?: string;
  gatewayProcessPid?: number;
  remoteRunId?: string;
  syncTargetId?: string;
}

const inputOperationKey = (operationId: string, targetId?: string): string => `inputOperation:${targetId ? `${targetId}:` : ''}${operationId}`;


/** All local/mobile submissions pass this account fence and per-session control lane. */
export class SessionCommandService {
  private readonly submitting = new Set<string>();
  private readonly configurationLane = new Map<string, string>();
  private readonly recovering = new Map<string, Promise<boolean>>();

  /** A bounded local-Gateway reconciliation, never an HTTP/WS remote-control prerequisite. */
  reconcileSession(sessionId: string): Promise<boolean> {
    const existing = this.recovering.get(sessionId);
    if (existing) return existing;
    const operation = this.reconcileSessionOnce(sessionId).finally(() => {
      if (this.recovering.get(sessionId) === operation) this.recovering.delete(sessionId);
    });
    this.recovering.set(sessionId, operation);
    return operation;
  }

  private async reconcileSessionOnce(sessionId: string): Promise<boolean> {
    const actor = this.getOwner();
    const generation = this.ownershipOptions.getGeneration?.();
    this.store.remote.assertActor(sessionId, actor);
    const fence = this.store.remote.get<InputFence>(`inputFence:${sessionId}`);
    const run = this.store.remote.run(sessionId);
    if (fence && !this.submitting.has(sessionId) && !this.configurationLane.has(sessionId) && this.clearPreparedInput(sessionId, fence.operationId)) {
      return !run || terminal.has(run.status);
    }
    if (!fence && run?.status !== 'reconciling') return !run || terminal.has(run.status);
    if (!this.runtime.querySessionRecovery || this.submitting.has(sessionId) || this.configurationLane.has(sessionId)) return false;
    const lane = randomUUID(); this.configurationLane.set(sessionId, lane);
    const mapping = this.store.remote.get<{ runId: string; remoteRunId: string }>(`gatewayRun:${sessionId}`);
    const gatewayRunId = mapping?.remoteRunId === run?.runId ? mapping?.runId : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let changed = false;
    try {
      const snapshot = await Promise.race([
        this.runtime.querySessionRecovery(sessionId, gatewayRunId, fence?.gatewayProcessPid).catch((): null => null),
        new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 4500); }),
      ]);
      if (!snapshot || generation !== this.ownershipOptions.getGeneration?.()
        || (actor ? !sameOwner(actor, this.getOwner()) : this.getOwner() !== null)) return false;
      this.store.remote.assertActor(sessionId, actor);
      if (payloadHash(this.store.remote.run(sessionId)) !== payloadHash(run)
        || payloadHash(this.store.remote.get(`gatewayRun:${sessionId}`)) !== payloadHash(mapping)
        || this.store.remote.get<InputFence>(`inputFence:${sessionId}`)?.operationId !== fence?.operationId) return false;
      const locallyActive = this.runtime.isSessionActive?.(sessionId) === true;
      if (fence && !locallyActive && snapshot.hasActiveRun === false && snapshot.configuration) {
        const config = snapshot.configuration;
        const oldWriterStopped = Boolean(fence.gatewayProcessPid && snapshot.previousWriterStopped === true);
        if (oldWriterStopped) {
          this.store.remote.transaction(() => {
            this.store.updateSession(sessionId, { modelOverride: config.modelOverride,
              thinkingLevel: parseModelThinkingLevel(config.thinkingLevel) || '' }, { touchUpdatedAt: false });
            this.store.remote.inputVersion(sessionId); this.recordCurrentInputModel(sessionId);
            this.store.remote.put(inputOperationKey(fence.operationId, fence.syncTargetId), { phase: 'reconciled', afterVersion: this.store.remote.inputVersion(sessionId) });
            this.store.remote.remove(`inputFence:${sessionId}`);
            changed = true;
            // This durable marker precedes dispatch and is removed before any engine send.
            if (!mapping && run?.status === 'reconciling' && fence.remoteRunId === run.runId
              && this.store.remote.get(`runCommand:${sessionId}`) === fence.operationId) this.store.remote.updateRun(sessionId, 'interrupted');
          });
        }
      }
      if (run?.status === 'reconciling' && gatewayRunId && snapshot.runId === gatewayRunId) {
        if (snapshot.status === 'running') {
          if (this.runtime.restoreSessionObservation?.(sessionId, run.runId, snapshot)) this.store.remote.updateRun(sessionId, 'running');
        } else if (!locallyActive && snapshot.hasActiveRun === false && terminal.has(snapshot.status)) {
          this.store.remote.transaction(() => {
            this.store.remote.updateRun(sessionId, snapshot.status as 'succeeded' | 'failed' | 'cancelled');
            this.store.updateSession(sessionId, { status: snapshot.status === 'succeeded' ? 'completed' : snapshot.status === 'failed' ? 'error' : 'idle' }, { touchUpdatedAt: false });
            changed = true;
          });
        }
      }
      if (changed) {
        try { this.ownershipOptions.onRecovered?.(sessionId); } catch { /* UI notification cannot undo confirmed local state. */ }
      }
      const current = this.store.remote.run(sessionId);
      return !this.store.remote.get(`inputFence:${sessionId}`) && (!current || terminal.has(current.status));
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.configurationLane.get(sessionId) === lane) this.configurationLane.delete(sessionId);
    }
  }

  /** Only a new-format fence written before the real dispatch boundary proves no RPC was sent. */
  private clearPreparedInput(sessionId: string, operationId: string, expected?: { syncTargetId: string | undefined }): boolean {
    const fence = this.store.remote.get<InputFence>(`inputFence:${sessionId}`);
    if (fence?.operationId !== operationId || fence.schemaVersion !== 2
      || expected && fence.syncTargetId !== expected.syncTargetId
      || fence.phase !== RemoteInputOperationPhase.Prepared || fence.gatewayProcessPid
      || fence.preparedProcessId !== inputPreparationProcessId) return false;
    this.store.remote.transaction(() => {
      this.store.remote.put(inputOperationKey(operationId, fence.syncTargetId), { phase: RemoteInputOperationPhase.KnownNotApplied });
      this.store.remote.remove(`inputFence:${sessionId}`);
    });
    remoteDiagnostics.record('fence.released');
    return true;
  }

  private input: { preparations: InputPreparationService; models: RemoteModelCatalog; getDeviceId(): string | undefined; getTargetId?(): string | null } | null = null;
  configureInput(input: NonNullable<SessionCommandService['input']>): void { this.input = input; }
  recordCurrentInputModel(sessionId: string): Record<string, unknown> | null {
    const actor = this.getOwner(); const deviceId = this.input?.getDeviceId();
    if (!actor || !deviceId || !sameOwner(this.store.remote.owner(sessionId), actor)) return null;
    try {
      const session = this.store.getSession(sessionId, 0);
      if (!session) return null;
      const runtimeRef = session.modelOverride || this.store.getAgent(session.agentId)?.model || '';
      const item = this.input!.models.resolveRuntime(actor, deviceId, runtimeRef).item;
      const summary = { modelRef: item.modelRef, version: item.version, source: item.source, displayName: item.displayName,
        providerLabel: item.providerLabel, thinkingLevel: session.thinkingLevel || null };
      this.store.remote.inputVersion(sessionId); this.store.remote.put(`inputModel:${sessionId}`, summary); return summary;
    } catch { return null; }
  }
  private preparedInput(command: RemoteCommand, owner: RemoteOwner): LocalPreparedInput | null {
    if (command.request.inputSchemaVersion !== 2) return null;
    if (!this.input) throw new RemoteInputError(RemoteInputReason.Invalid);
    const prepared = this.input.preparations.read(command.request.payload.inputPreparationId, owner, this.input.getDeviceId() || '');
    if (prepared.inputDigest !== command.request.payload.inputDigest || payloadHash(command.request.payload.resolvedInput) !== prepared.inputDigest) throw new RemoteInputError(RemoteInputReason.Stale);
    return prepared;
  }
  private inputModel(prepared: LocalPreparedInput): Record<string, unknown> {
    const item = this.input!.models.resolve(prepared.owner, prepared.deviceId, prepared.resolvedInput.model.modelRef, prepared.resolvedInput.model.version).item;
    return { modelRef: item.modelRef, version: item.version, source: item.source, displayName: item.displayName, providerLabel: item.providerLabel,
      thinkingLevel: prepared.resolvedInput.options.thinkingLevel || null };
  }
  async patchConfiguration(sessionId: string, patch: Parameters<CoworkRuntime['patchSession']>[1]): Promise<any> {
    const actor = this.getOwner();
    const generation = this.ownershipOptions.getGeneration?.();
    this.store.remote.assertActor(sessionId, actor);
    await this.reconcileSession(sessionId);
    if (generation !== this.ownershipOptions.getGeneration?.() || (actor ? !sameOwner(actor, this.getOwner()) : this.getOwner() !== null)) throw new RemoteInputError(RemoteInputReason.Account);
    this.store.remote.assertActor(sessionId, actor);
    const run = this.store.remote.run(sessionId);
    if (this.submitting.has(sessionId) || this.configurationLane.has(sessionId)) throw new RemoteInputError(RemoteInputReason.Busy);
    if (this.store.remote.get(`inputFence:${sessionId}`) || run?.status === 'reconciling') {
      const error = new RemoteInputError(RemoteInputReason.Busy); error.message = t('remoteSessionRecoveryRequired'); throw error;
    }
    if (run && !terminal.has(run.status)) throw new RemoteInputError(RemoteInputReason.Busy);
    const token = randomUUID(); this.configurationLane.set(sessionId, token);
    const check = (): void => {
      if (generation !== this.ownershipOptions.getGeneration?.() || (actor ? !sameOwner(actor, this.getOwner()) : this.getOwner() !== null)) throw new RemoteInputError(RemoteInputReason.Account);
      this.store.remote.assertActor(sessionId, actor);
    };
    try {
      check(); this.store.remote.inputVersion(sessionId);
      this.store.remote.put(`inputFence:${sessionId}`, { schemaVersion: 2, preparedProcessId: inputPreparationProcessId, operationId: token, phase: RemoteInputOperationPhase.Prepared, target: patch, gatewayBootId: '', gatewayProcessPid: null });
      const result = await this.runtime.patchSession(sessionId, patch);
      check();
      this.store.updateSession(sessionId, {
        ...(patch.model !== undefined ? { modelOverride: result && typeof result.modelOverride === 'string' ? result.modelOverride : patch.model ?? '' } : {}),
        ...(patch.thinkingLevel !== undefined ? { thinkingLevel: parseModelThinkingLevel(patch.thinkingLevel) || '' } : {}),
      }, { touchUpdatedAt: false });
      this.store.remote.inputVersion(sessionId); this.recordCurrentInputModel(sessionId); this.store.remote.remove(`inputFence:${sessionId}`);
      return result;
    } catch (error) {
      // Never infer rejection from a timeout. A dispatched/legacy fence retains the recovery barrier.
      if (generation === this.ownershipOptions.getGeneration?.() && (actor ? sameOwner(actor, this.getOwner()) : this.getOwner() === null)) {
        this.store.remote.assertActor(sessionId, actor);
        this.clearPreparedInput(sessionId, token);
      }
      throw error;
    } finally { this.configurationLane.delete(sessionId); }
  }
  private startHandler: ((options: any) => Promise<any>) | null = null;
  private continueHandler: ((options: any) => Promise<any>) | null = null;
  constructor(private readonly store: CoworkStore, private readonly runtime: CoworkRuntime, private readonly getOwner: () => RemoteOwner | null,
    private readonly ownershipOptions: { gate?: OwnershipOperationGate; getGeneration?: () => number | string; onRecovered?: (sessionId: string) => void } = {}) {
    runtime.on('sessionStatus', (id, status) => {
      if (status !== 'running' || !store.remote.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(id)) return;
      // Anonymous tasks also need per-run approval identity; ownership still controls upload.
      const run = store.remote.run(id);
      if (!run || terminal.has(run.status)) store.remote.beginRun(id);
      store.remote.refreshApprovalRunState(id, true);
    });
    runtime.on('complete', id => store.remote.updateRun(id, 'succeeded'));
    runtime.on('error', (id, error) => store.remote.updateRun(id, /disconnect|gateway|connection|socket/i.test(error) ? 'reconciling' : 'failed', t('remoteExecutionFailed')));
    // The legacy stop event means local cleanup, not proven gateway termination.
    runtime.on('sessionStopped', id => store.remote.updateRun(id, 'reconciling'));
    runtime.on('runTermination', (id, gatewayRunId, status) => {
      const mapping = store.remote.get<{ runId: string; remoteRunId: string }>(`gatewayRun:${id}`);
      if (mapping?.runId === gatewayRunId && mapping.remoteRunId === store.remote.run(id)?.runId) store.remote.updateRun(id, status);
    });
    store.remote.setApprovalLifecycle({
      expire: now => runtime.expirePermissions?.(now),
      close: (sessionId, runId) => runtime.closeSessionPermissions?.(sessionId, runId, 'cancelled'),
    });
    runtime.on('permissionRequest', (id, request) => this.permission(id, request));
    runtime.on('permissionState', (id, state) => this.permissionState(id, state));
    // A legacy ID-only event proves neither the winning decision nor that the engine resumed.
    runtime.on('permissionResolved', (id, requestId) => {
      const state = runtime.getPermissionState?.(requestId);
      if (state) this.permissionState(id, state);
      else store.remote.updateLocalApprovalBlocker(id, requestId, null, false);
    });
    // The runtime may have reconstructed dispatching -> unknown before these listeners existed.
    for (const pending of runtime.listPendingPermissions?.() || []) this.permission(pending.sessionId, pending.request);
  }
  configure(start: (options: any) => Promise<any>, resume: (options: any) => Promise<any>): void { this.startHandler = start; this.continueHandler = resume; }
  async submit(options: any, create: boolean, handler: (options: any) => Promise<any>): Promise<any> {
    const inherited = currentRemoteExecution();
    const actor = inherited ? inherited.owner : this.getOwner();
    const generation = this.ownershipOptions.getGeneration?.();
    const id = create ? inherited?.preparedSessionId : options.sessionId;
    if (id) {
      this.store.remote.assertNoDeletionEffect(id);
      this.store.remote.assertActor(id, actor);
      if (!inherited) {
        if (this.submitting.has(id) || this.configurationLane.has(id)) return { success: false, error: 'REMOTE_SESSION_BUSY' };
        await this.reconcileSession(id);
        if (generation !== this.ownershipOptions.getGeneration?.() || (actor ? !sameOwner(actor, this.getOwner()) : this.getOwner() !== null)) throw new RemoteInputError(RemoteInputReason.Account);
        this.store.remote.assertActor(id, actor);
        if (this.store.remote.get(`inputFence:${id}`) || this.store.remote.run(id)?.status === 'reconciling') {
          return { success: false, error: t('remoteSessionRecoveryRequired'), recoveryRequired: true };
        }
      }
      if (this.submitting.has(id) || this.configurationLane.has(id) && this.configurationLane.get(id) !== inherited?.commandId || this.store.remote.get(`inputFence:${id}`)) return { success: false, error: 'REMOTE_SESSION_BUSY' };
      const run = this.store.remote.run(id);
      if (run && !terminal.has(run.status) && run.runId !== inherited?.runId) return { success: false, error: 'REMOTE_SESSION_BUSY' };
    }
    const agentId = create ? (options.agentId || AgentId.Main) : this.store.getSession(options.sessionId, 0)?.agentId;
    if (!agentId) throw remoteAgentFailure('NOT_SELECTABLE');
    const targetIds = (this.store.getAgent(agentId)?.subagentAllowAgentIds || [])
      .filter(target => this.store.agentOwnership.canView(target, actor));
    const agentIds = [...new Set([agentId, ...targetIds])];
    const release = (this.ownershipOptions.gate || ownershipOperationGate).beginOperation({ agentIds, sessionIds: id ? [id] : [] });
    if (!release) return { success: false, error: 'REMOTE_SESSION_BUSY' };
    if (id) this.submitting.add(id);
    try {
      this.store.assertAgentAccess(agentId, actor);
      if (!this.store.getAgent(agentId)?.enabled) throw remoteAgentFailure('DISABLED');
      const versions = new Map(agentIds.map(target => [target, this.store.agentOwnership.get(target)?.version]));
      const inheritedBinding = inherited?.assertAgentBinding;
      return await context.run({ ...inherited, owner: actor, assertAgentBinding: () => {
        inheritedBinding?.();
        if (generation !== this.ownershipOptions.getGeneration?.()
          || (actor === null ? this.getOwner() !== null : !sameOwner(actor, this.getOwner()))) throw new Error('Account changed');
        for (const target of agentIds) {
          this.store.assertAgentAccess(target, actor);
          if (this.store.agentOwnership.get(target)?.version !== versions.get(target)) throw remoteAgentFailure('VERSION_CHANGED');
        }
        if (id) this.store.remote.assertActor(id, actor);
        if (!this.store.getAgent(agentId)?.enabled) throw remoteAgentFailure('DISABLED');
      } }, async () => {
        if (actor && !sameOwner(actor, this.getOwner())) throw new Error('Account changed');
        return handler(options);
      });
    } finally { if (id) this.submitting.delete(id); release(); }
  }
  private validateAgent(agentId: string, owner: RemoteOwner, expectedVersion?: string, selectable = false): void {
    const identity = this.store.agentOwnership.get(agentId);
    if (!identity || identity.deletedAt !== null) throw remoteAgentFailure('DELETED');
    try { this.store.assertAgentAccess(agentId, owner); } catch { throw remoteAgentFailure('NOT_SELECTABLE'); }
    if (selectable && identity.ownerKind === AgentOwnerKind.Anonymous) throw remoteAgentFailure('NOT_SELECTABLE');
    if (!this.store.getAgent(agentId)?.enabled) throw remoteAgentFailure('DISABLED');
    if (expectedVersion !== undefined && identity.version !== expectedVersion) throw new RemoteAgentError(47029, 'AGENT_VERSION_CONFLICT', 'VERSION_CHANGED');
  }
  private validateDirectory(path: string): void {
    try { if (!statSync(path).isDirectory()) throw remoteAgentFailure('WORKSPACE_UNAVAILABLE'); }
    catch { throw remoteAgentFailure('WORKSPACE_UNAVAILABLE'); }
  }
  prepare(command: RemoteCommand, owner: RemoteOwner, workspace: string | null): { localSessionId: string; remoteSessionId: string; runId: string | null } {
    const request = command.request;
    const preparedInput = this.preparedInput(command, owner);
    const payload = preparedInput ? preparedInput.resolvedInput : request.payload;
    if (preparedInput) this.input!.preparations.validate(preparedInput, owner, preparedInput.deviceId, true);
    let localId: string;
    if (command.type === 'create_session') {
      if (!workspace) throw new Error('Workspace unavailable');
      const explicit = payload.agentId !== undefined || payload.expectedAgentVersion !== undefined;
      if (explicit && (typeof payload.agentId !== 'string' || typeof payload.expectedAgentVersion !== 'string'
        || !/^[1-9]\d*$/u.test(payload.expectedAgentVersion))) throw new RemoteAgentError(47019, 'COMMAND_INVALID', 'INVALID_AGENT_TARGET');
      const agentId = explicit ? payload.agentId : AgentId.Main;
      this.validateAgent(agentId, owner, explicit && !preparedInput ? payload.expectedAgentVersion : undefined, explicit);
      if (explicit) this.validateDirectory(workspace);
      const config = this.store.getConfig();
      const session = this.store.createSession((payload.text.trim() || payload.attachments?.[0]?.fileName || t('coworkDefaultSessionTitle')).slice(0, 100), workspace, config.systemPrompt, 'local', [], agentId, preparedInput?.runtimeRef || '', { owner, ownershipSource: 'remote_command', ...(preparedInput ? { thinkingLevel: parseModelThinkingLevel(preparedInput.resolvedInput.options.thinkingLevel) || '' } : {}) });
      localId = session.id;
      this.store.remote.put(`agentExecution:${command.commandId}`, { agentId, version: explicit ? payload.expectedAgentVersion : null,
        workspaceId: payload.workspaceId || null, cwd: resolve(workspace) });
      this.store.remote.put(`origin:${localId}`, 'mobile');
      this.store.remote.put(`workspace:${localId}`, payload.workspaceId || null);
      if (!command.sessionId) throw new Error('Server session mapping is required');
      const remoteId = command.sessionId;
      this.store.remote.bindRemote(localId, remoteId, '');
    } else {
      localId = this.store.remote.localSessionId(request.sessionId || command.sessionId) || '';
      if (!localId) throw new Error('Session unavailable');
      this.store.remote.assertActor(localId, owner);
      if (!sameOwner(this.store.remote.owner(localId), owner)) throw remoteAgentFailure('NOT_SELECTABLE');
      if (command.type === 'send_message') {
        const session = this.store.getSession(localId, 0);
        if (!session) throw remoteAgentFailure('DELETED');
        this.validateAgent(session.agentId || AgentId.Main, owner);
        this.validateDirectory(session.cwd);
      }
    }
    if (this.submitting.has(localId) || this.configurationLane.has(localId) || this.store.remote.get(`inputFence:${localId}`)) throw new Error('REMOTE_SESSION_BUSY');
    if (command.type === 'send_message' && request.expectedControlVersion !== this.store.remote.controlVersion(localId)) throw new Error('REMOTE_CONTROL_CONFLICT');
    if (preparedInput) {
      if (command.type === 'send_message' && request.expectedInputVersion !== this.store.remote.inputVersion(localId)) throw new RemoteInputError(RemoteInputReason.Version);
      this.input!.preparations.bind(preparedInput, command.commandId);
    }
    let runId = this.store.remote.run(localId)?.runId || null;
    if (['create_session', 'send_message'].includes(command.type)) {
      if (!command.runId) throw new Error('Server run mapping is required');
      runId = this.store.remote.beginRun(localId, command.runId, command.commandId).runId;
    }
    if (['cancel_run', 'approval_response', RemoteQuestion.Command].includes(command.type) && payload.runId !== runId) throw new Error('Run changed');
    return { localSessionId: localId, remoteSessionId: this.store.remote.sync(localId)!.session_id, runId };
  }
  async execute(entry: InboxEntry, stillPermitted: () => boolean = () => false): Promise<any> {
    if (!entry.localSessionId || !sameOwner(entry.owner, this.getOwner())) throw new Error('Account changed');
    this.store.remote.assertActor(entry.localSessionId, entry.owner);
    const localId = entry.localSessionId;
    const request = entry.command.request;
    const preparedInput = this.preparedInput(entry.command, entry.owner);
    const payload = preparedInput ? preparedInput.resolvedInput : request.payload;
    const session = this.store.getSession(localId, 0);
    const startsRun = ['create_session', 'send_message'].includes(entry.command.type);
    const binding = this.store.remote.get<{ agentId: string; version: string | null; cwd: string; workspaceId: string | null }>(`agentExecution:${entry.command.commandId}`);
    const explicit = entry.command.type === 'create_session' && payload.agentId !== undefined;
    const fixedAgentId = session?.agentId || AgentId.Main;
    const fixedCwd = session?.cwd;
    const assertBinding = (): void => {
      if (!startsRun) return;
      if (preparedInput) this.input!.preparations.validate(preparedInput, entry.owner, preparedInput.deviceId, true);
      if (!session || !sameOwner(this.store.remote.owner(localId), entry.owner)) throw remoteAgentFailure('NOT_SELECTABLE');
      const current = this.store.getSession(localId, 0);
      if (!current || (current.agentId || AgentId.Main) !== fixedAgentId || current.cwd !== fixedCwd) throw remoteAgentFailure('BINDING_MISMATCH');
      if (entry.command.type === 'create_session') {
        const requested = payload.agentId || AgentId.Main;
        if (requested !== fixedAgentId || explicit && (!binding || binding.agentId !== requested
          || binding.version !== payload.expectedAgentVersion || binding.workspaceId !== payload.workspaceId || binding.cwd !== resolve(current.cwd))) throw remoteAgentFailure('BINDING_MISMATCH');
      }
      this.validateAgent(fixedAgentId, entry.owner, explicit && !preparedInput ? payload.expectedAgentVersion : undefined, explicit);
      if (explicit || entry.command.type === 'send_message') this.validateDirectory(current.cwd);
    };
    let bindingFailure: RemoteAgentError | undefined;
    const assertAgentBinding = (): void => {
      try { assertBinding(); } catch (error) { if (error instanceof RemoteAgentError) bindingFailure = error; throw error; }
    };
    const release = (this.ownershipOptions.gate || ownershipOperationGate).beginOperation({ agentIds: [fixedAgentId], sessionIds: [localId] });
    if (!release) throw new Error('REMOTE_SESSION_BUSY');
    try {
    const result = await context.run({ owner: entry.owner, preparedSessionId: localId, runId: entry.runId || undefined, commandId: entry.command.commandId, stillPermitted, assertAgentBinding }, async () => {
      assertRemoteExecutionPermit();
      if (preparedInput) {
        if (this.configurationLane.has(localId) || this.submitting.has(localId) || this.store.remote.get(`inputFence:${localId}`)) throw new RemoteInputError(RemoteInputReason.Busy);
        const syncTargetId = entry.targetId ?? preparedInput.targetId ?? this.input!.getTargetId?.() ?? undefined;
        const sameInputTarget = (): boolean => this.input!.getDeviceId() === preparedInput.deviceId
          && (!this.input!.getTargetId || (this.input!.getTargetId() ?? undefined) === syncTargetId);
        if (!sameInputTarget()) throw new RemoteInputError(RemoteInputReason.Stale);
        this.configurationLane.set(localId, entry.command.commandId);
        try {
          const options = await this.input!.preparations.executionOptions(preparedInput, assertRemoteExecutionPermit);
          assertRemoteExecutionPermit();
          if (!sameInputTarget()) throw new RemoteInputError(RemoteInputReason.Stale);
          const inputModel = this.inputModel(preparedInput);
          const beforeVersion = this.store.remote.inputVersion(localId);
          if (entry.command.type === 'send_message' && request.expectedInputVersion !== beforeVersion) throw new RemoteInputError(RemoteInputReason.Version);
          if (entry.command.type === 'send_message') {
            this.store.remote.put(`inputFence:${localId}`, { schemaVersion: 2, preparedProcessId: inputPreparationProcessId, operationId: entry.command.commandId, phase: RemoteInputOperationPhase.Prepared, beforeVersion, remoteRunId: entry.runId,
              ...(syncTargetId ? { syncTargetId } : {}),
              target: { model: options.modelOverride, thinkingLevel: options.thinkingLevel || null }, gatewayBootId: '', gatewayProcessPid: null });
            await this.runtime.patchSession(localId, { model: options.modelOverride, thinkingLevel: options.thinkingLevel || null });
            // A confirmed patch remains a fact even if the send permit expires during the await.
            if (!sameOwner(entry.owner, this.getOwner())) throw new Error('Account changed during model application');
            this.store.updateSession(localId, { modelOverride: options.modelOverride, thinkingLevel: parseModelThinkingLevel(options.thinkingLevel) || '' }, { touchUpdatedAt: false });
          }
          const afterVersion = this.store.remote.inputVersion(localId);
          this.store.remote.transaction(() => {
            if (entry.command.type === 'send_message') {
              const fence = this.store.remote.get<InputFence>(`inputFence:${localId}`);
              if (fence?.operationId !== entry.command.commandId || fence.syncTargetId !== syncTargetId) throw new RemoteInputError(RemoteInputReason.Busy);
              this.store.remote.remove(`inputFence:${localId}`);
            }
            this.store.remote.put(inputOperationKey(entry.command.commandId, syncTargetId), { phase: 'model_applied', beforeVersion, afterVersion });
            // The gateway patch is a local fact; its old service references are not the new target's projection.
            if (sameInputTarget()) {
              this.store.remote.put(`inputModel:${localId}`, inputModel);
              this.store.remote.put(`inputRun:${entry.runId}`, { input: preparedInput.resolvedInput, inputModel });
            }
            this.store.remote.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(localId);
          });
          if (!sameInputTarget() || !stillPermitted()) throw new RemoteInputError(RemoteInputReason.Expired);
          assertRemoteExecutionPermit();
          const submitted = entry.command.type === 'create_session'
            ? await this.startHandler!({ ...options, cwd: fixedCwd, agentId: fixedAgentId })
            : await this.continueHandler!({ ...options, sessionId: localId });
          if (!submitted?.success) throw new RemoteInputError(RemoteInputReason.Invalid);
          return submitted;
        } catch (error) {
          if (sameOwner(entry.owner, this.getOwner())) {
            this.store.remote.assertActor(localId, entry.owner);
            this.clearPreparedInput(localId, entry.command.commandId, { syncTargetId });
          }
          throw error;
        } finally { this.configurationLane.delete(localId); }
      }
      if (entry.command.type === 'create_session') return this.startHandler!({ prompt: payload.text, cwd: fixedCwd, agentId: fixedAgentId });
      if (entry.command.type === 'send_message') return this.continueHandler!({ prompt: payload.text, sessionId: localId });
      if (entry.command.type === 'cancel_run') {
        const currentRun = this.store.remote.run(localId);
        if (!currentRun || currentRun.runId !== entry.runId) return { success: true, alreadyTerminal: true };
        if (terminal.has(currentRun.status)) return { success: true, alreadyTerminal: true };
        if (!this.runtime.cancelSessionConfirmed) throw new Error('Cancellation unavailable');
        assertRemoteExecutionPermit();
        this.store.remote.updateRun(localId, 'cancelling');
        const confirmed = await this.runtime.cancelSessionConfirmed(localId);
        if (this.store.remote.run(localId)?.runId === entry.runId) this.store.remote.updateRun(localId, confirmed ? 'cancelled' : 'reconciling');
        return { success: true };
      }
      if (entry.command.type === RemoteQuestion.Command) {
        const state = this.runtime.getQuestionState?.(payload.questionId);
        if (!['answer', 'cancel'].includes(payload.action) || !state || state.sessionId !== localId
          || state.runId !== entry.runId || !this.runtime.respondToQuestionConfirmed) {
          throw new RemoteQuestionError({ kind: 'known_not_applied', reason: 'QUESTION_STALE' });
        }
        const outcome = await this.runtime.respondToQuestionConfirmed(payload.questionId, payload.action === 'answer'
          ? { behavior: 'allow', updatedInput: { answers: payload.answers } } : { behavior: 'deny', message: 'Cancelled from mobile' }, {
          submissionId: entry.command.commandId, source: 'mobile', expectedVersion: payload.questionVersion,
          operationDigest: payload.operationDigest, onDispatch: markRemoteExecutionDispatched,
          beforeDispatch: () => {
            assertRemoteExecutionPermit();
            this.store.remote.assertActor(localId, entry.owner);
            if (!sameOwner(this.getOwner(), entry.owner) || !sameOwner(this.store.remote.owner(localId), entry.owner)
              || this.store.remote.run(localId)?.runId !== entry.runId) throw new Error('Question owner or run changed');
            const current = this.store.getSession(localId, 0);
            if (!current || current.agentId !== session?.agentId || current.cwd !== session?.cwd) throw new Error('Question binding changed');
            this.store.assertAgentAccess(current.agentId || AgentId.Main, entry.owner);
          },
        });
        if (!outcome || outcome.kind !== 'confirmed') throw new RemoteQuestionError(outcome || { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' });
        if (outcome.status !== (payload.action === 'answer' ? 'answered' : 'cancelled')) throw new RemoteQuestionError({ kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' });
        return { success: true };
      }
      if (entry.command.type === 'approval_response') {
        const payload = request.payload;
        const state = this.runtime.getPermissionState?.(payload.approvalId);
        // The runtime owns CAS, versions and dispatch evidence. Do not mutate the original command
        // to match its incremented reservation version or infer a decision from an attempted click.
        if (!state || state.sessionId !== localId || state.runId !== entry.runId || !this.runtime.respondToPermissionConfirmed) {
          throw new RemoteApprovalError({ kind: 'known_not_applied', reason: 'APPROVAL_STALE' });
        }
        const outcome = await this.runtime.respondToPermissionConfirmed(payload.approvalId, payload.decision === 'approve'
          ? { behavior: 'allow', updatedInput: {} } : { behavior: 'deny', message: 'Denied from mobile' }, {
          submissionId: entry.command.commandId, source: 'mobile', expectedVersion: payload.approvalVersion,
          operationDigest: payload.operationDigest, onDispatch: markRemoteExecutionDispatched,
          beforeDispatch: () => {
            assertRemoteExecutionPermit();
            this.store.remote.assertActor(localId, entry.owner);
            if (!sameOwner(this.getOwner(), entry.owner) || !sameOwner(this.store.remote.owner(localId), entry.owner)
              || this.store.remote.run(localId)?.runId !== entry.runId) throw new Error('Approval owner or run changed');
            const current = this.store.getSession(localId, 0);
            if (!current || current.agentId !== session?.agentId || current.cwd !== session?.cwd) throw new Error('Approval binding changed');
            this.store.assertAgentAccess(current.agentId || AgentId.Main, entry.owner);
          },
        });
        if (!outcome || outcome.kind !== 'confirmed') throw new RemoteApprovalError(outcome || { kind: 'unknown', reason: 'RESULT_UNKNOWN' });
        return { success: true };
      }
      throw new Error('Unsupported command');
    });
    if (!result?.success) throw bindingFailure || new Error(result?.error || 'Task submission failed');
    return { outcome: ['create_session', 'send_message'].includes(entry.command.type) ? 'started'
      : entry.command.type === 'cancel_run' ? (result.alreadyTerminal ? 'already_terminal' : 'cancel_requested')
      : entry.command.type === RemoteQuestion.Command ? 'question_applied' : 'approval_applied' };
    } finally { release(); }
  }
  private permission(sessionId: string, request: PermissionRequest): void {
    if (this.runtime.getQuestionState?.(request.requestId)?.sessionId === sessionId) {
      this.store.remote.updateLocalApprovalBlocker(sessionId, request.requestId, null, false);
      return; // The question authority owns its projection and waiting state.
    }
    const state = request.approval || this.runtime.getPermissionState?.(request.requestId);
    if (state) this.permissionState(sessionId, state);
    else {
      // Unknown request kinds (including question forms) remain local; arbitrary toolInput
      // remoteSafe/publicSummary values are never an authorization adapter.
      this.store.remote.updateLocalApprovalBlocker(sessionId, request.requestId, this.store.remote.run(sessionId)?.runId || null, true);
    }
  }
  private permissionState(sessionId: string, state: ApprovalState): void {
    if (state.sessionId !== sessionId || !state.runId) return;
    if (!state.expiresAt || !Number.isFinite(Date.parse(state.expiresAt))) {
      this.store.remote.updateLocalApprovalBlocker(sessionId, state.requestId, state.runId, state.status === 'pending');
      return; // The v1 DTO requires a real deadline; never invent one for an unverified request.
    }
    this.store.remote.updateApproval(sessionId, {
      approvalId: state.requestId, runId: state.runId, approvalVersion: state.approvalVersion,
      title: state.title, summary: state.summary, operationDigest: state.operationDigest,
      remoteAllowed: state.remoteAllowed, requiresLocalAction: state.requiresLocalAction,
      expiresAt: state.expiresAt, status: state.status, resolvedAt: state.resolvedAt, resolution: state.resolution,
    });
  }
  async reconcileApproval(entry: InboxEntry): Promise<ApprovalDecisionOutcome | null> {
    if (entry.command.type !== 'approval_response' || !entry.localSessionId) return null;
    // Receipt proof belongs to this exact original request/claim. A running task proves
    // nothing about whether one of its approvals has already been sent to the Gateway.
    const persisted = this.store.remote.get<InboxEntry>(`inbox:${entry.command.commandId}`);
    const canProveNeverDispatched = Boolean(persisted && entry.command.claimId && entry.command.claimToken
      && payloadHash(entry.command.request) === entry.command.requestHash
      && persisted.command.requestHash === entry.command.requestHash
      && persisted.command.claimId === entry.command.claimId && persisted.command.claimToken === entry.command.claimToken
      && persisted.localSessionId === entry.localSessionId && persisted.runId === entry.runId
      && sameOwner(persisted.owner, entry.owner) && this.store.remote.hasCompleteExecutionHistory());
    const outcome = await this.runtime.reconcileApprovalSubmission?.(entry.command.commandId, { canProveNeverDispatched })
      || this.runtime.getApprovalSubmission?.(entry.command.commandId) || null;
    if (!outcome && canProveNeverDispatched && persisted?.state === 'prepared') {
      // This inbox has never crossed the durable executing marker, so no local reservation
      // or Gateway send was possible. Close the original command instead of renewing its permit.
      return { kind: 'known_not_applied', reason: 'NEVER_DISPATCHED' };
    }
    return outcome;
  }
  async reconcileQuestion(entry: InboxEntry): Promise<QuestionDecisionOutcome | null> {
    if (entry.command.type !== RemoteQuestion.Command || !entry.localSessionId) return null;
    const outcome = await this.runtime.reconcileQuestionSubmission?.(entry.command.commandId) || null;
    if (outcome) return outcome;
    const persisted = this.store.remote.get<InboxEntry>(`inbox:${entry.command.commandId}`);
    // Only this exact durable prepared inbox proves that the authority was never invoked.
    // An executing marker, lost claim token, or missing history must remain unknown.
    if (persisted?.state === 'prepared' && entry.command.claimId && entry.command.claimToken
      && payloadHash(entry.command.request) === entry.command.requestHash
      && persisted.command.requestHash === entry.command.requestHash
      && persisted.command.claimId === entry.command.claimId && persisted.command.claimToken === entry.command.claimToken
      && persisted.localSessionId === entry.localSessionId && persisted.runId === entry.runId
      && sameOwner(persisted.owner, entry.owner) && this.store.remote.hasCompleteExecutionHistory()) {
      return { kind: 'known_not_applied', reason: 'NEVER_DISPATCHED' };
    }
    return null;
  }
  accountChanged(previous: RemoteOwner | null, current: RemoteOwner | null): void {
    if (!previous || sameOwner(previous, current)) return;
    // OpenClaw model credentials are global. Fence old runs before syncing the new account's credentials.
    for (const row of this.store.remote.sessions(previous)) {
      const run = this.store.remote.run(row.local_id);
      if (run && !terminal.has(run.status)) {
        this.runtime.stopSession(row.local_id);
        this.store.remote.updateRun(row.local_id, 'reconciling');
      }
    }
  }
}
