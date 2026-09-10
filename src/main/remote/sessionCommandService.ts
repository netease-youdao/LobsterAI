import { AsyncLocalStorage } from 'async_hooks';
import { statSync } from 'fs';
import { resolve } from 'path';

import { AgentId, AgentOwnerKind } from '../../shared/agent/constants';
import type { RemoteOwner } from '../../shared/remote/constants';
import type { CoworkStore } from '../coworkStore';
import { t } from '../i18n';
import type { CoworkRuntime, PermissionRequest } from '../libs/agentEngine/types';
import { payloadHash,sameOwner } from './canonical';
import { RemoteAgentError, remoteAgentFailure } from './remoteAgentCatalog';
import type { InboxEntry, RemoteCommand } from './remoteBridge';

interface ExecutionContext { owner: RemoteOwner | null; preparedSessionId?: string; runId?: string; commandId?: string; stillPermitted?: () => boolean; assertAgentBinding?: () => void }
const context = new AsyncLocalStorage<ExecutionContext>();
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

/** All local/mobile submissions pass this account fence and per-session control lane. */
export class SessionCommandService {
  private readonly submitting = new Set<string>();
  private startHandler: ((options: any) => Promise<any>) | null = null;
  private continueHandler: ((options: any) => Promise<any>) | null = null;
  constructor(private readonly store: CoworkStore, private readonly runtime: CoworkRuntime, private readonly getOwner: () => RemoteOwner | null) {
    runtime.on('sessionStatus', (id, status) => {
      if (status !== 'running' || !store.remote.owner(id)) return;
      const run = store.remote.run(id);
      if (!run || terminal.has(run.status)) store.remote.beginRun(id);
      store.remote.updateRun(id, 'running');
    });
    runtime.on('complete', id => store.remote.updateRun(id, 'succeeded'));
    runtime.on('error', (id, error) => store.remote.updateRun(id, /disconnect|gateway|connection|socket/i.test(error) ? 'reconciling' : 'failed', t('remoteExecutionFailed')));
    // The legacy stop event means local cleanup, not proven gateway termination.
    runtime.on('sessionStopped', id => store.remote.updateRun(id, 'reconciling'));
    runtime.on('runTermination', (id, gatewayRunId, status) => {
      const mapping = store.remote.get<{ runId: string; remoteRunId: string }>(`gatewayRun:${id}`);
      if (mapping?.runId === gatewayRunId && mapping.remoteRunId === store.remote.run(id)?.runId) store.remote.updateRun(id, status);
    });
    runtime.on('permissionRequest', (id, request) => this.permission(id, request));
    runtime.on('permissionResolved', (id, requestId) => {
      const key = `approval:${id}:${requestId}`;
      const approval = store.remote.get<any>(key);
      if (!approval) return;
      store.remote.transaction(() => {
        // Resolution alone cannot prove which decision won (another desktop may have answered).
        if (approval.status === 'pending') {
          store.remote.put(key, { ...approval, approvalVersion: String(BigInt(approval.approvalVersion) + 1n), status: approval.pendingDecision || 'superseded', resolvedAt: new Date().toISOString() });
        }
        if (approval.runId === store.remote.run(id)?.runId) store.remote.updateRun(id, 'running');
      });
    });
  }
  configure(start: (options: any) => Promise<any>, resume: (options: any) => Promise<any>): void { this.startHandler = start; this.continueHandler = resume; }
  async submit(options: any, create: boolean, handler: (options: any) => Promise<any>): Promise<any> {
    const inherited = currentRemoteExecution();
    const actor = inherited?.owner || this.getOwner();
    const id = create ? inherited?.preparedSessionId : options.sessionId;
    if (id) {
      this.store.remote.assertActor(id, actor);
      if (this.submitting.has(id)) return { success: false, error: 'REMOTE_SESSION_BUSY' };
      const run = this.store.remote.run(id);
      if (run && !terminal.has(run.status) && run.runId !== inherited?.runId) return { success: false, error: 'REMOTE_SESSION_BUSY' };
      this.submitting.add(id);
    }
    try {
      const agentId = create ? (options.agentId || AgentId.Main) : this.store.getSession(options.sessionId, 0)?.agentId;
      if (!agentId) throw remoteAgentFailure('NOT_SELECTABLE');
      this.store.assertAgentAccess(agentId, actor);
      if (!this.store.getAgent(agentId)?.enabled) throw remoteAgentFailure('DISABLED');
      return await context.run(inherited || { owner: actor, assertAgentBinding: () => {
        if (actor === null ? this.getOwner() !== null : !sameOwner(actor, this.getOwner())) throw new Error('Account changed');
        this.store.assertAgentAccess(agentId, actor);
        if (!this.store.getAgent(agentId)?.enabled) throw remoteAgentFailure('DISABLED');
      } }, async () => {
        if (actor && !sameOwner(actor, this.getOwner())) throw new Error('Account changed');
        return handler(options);
      });
    } finally { if (id) this.submitting.delete(id); }
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
    let localId: string;
    if (command.type === 'create_session') {
      if (!workspace) throw new Error('Workspace unavailable');
      const explicit = request.payload.agentId !== undefined || request.payload.expectedAgentVersion !== undefined;
      if (explicit && (typeof request.payload.agentId !== 'string' || typeof request.payload.expectedAgentVersion !== 'string'
        || !/^[1-9]\d*$/u.test(request.payload.expectedAgentVersion))) throw new RemoteAgentError(47019, 'COMMAND_INVALID', 'INVALID_AGENT_TARGET');
      const agentId = explicit ? request.payload.agentId : AgentId.Main;
      this.validateAgent(agentId, owner, explicit ? request.payload.expectedAgentVersion : undefined, explicit);
      if (explicit) this.validateDirectory(workspace);
      const config = this.store.getConfig();
      const session = this.store.createSession(request.payload.text.slice(0, 100), workspace, config.systemPrompt, 'local', [], agentId, '', { owner, ownershipSource: 'remote_command' });
      localId = session.id;
      this.store.remote.put(`agentExecution:${command.commandId}`, { agentId, version: explicit ? request.payload.expectedAgentVersion : null,
        workspaceId: request.payload.workspaceId || null, cwd: resolve(workspace) });
      this.store.remote.put(`origin:${localId}`, 'mobile');
      this.store.remote.put(`workspace:${localId}`, request.payload.workspaceId || null);
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
    if (this.submitting.has(localId)) throw new Error('REMOTE_SESSION_BUSY');
    if (command.type === 'send_message' && request.expectedControlVersion !== this.store.remote.controlVersion(localId)) throw new Error('REMOTE_CONTROL_CONFLICT');
    let runId = this.store.remote.run(localId)?.runId || null;
    if (['create_session', 'send_message'].includes(command.type)) {
      if (!command.runId) throw new Error('Server run mapping is required');
      runId = this.store.remote.beginRun(localId, command.runId, command.commandId).runId;
    }
    if (['cancel_run', 'approval_response'].includes(command.type) && request.payload.runId !== runId) throw new Error('Run changed');
    return { localSessionId: localId, remoteSessionId: this.store.remote.sync(localId)!.session_id, runId };
  }
  async execute(entry: InboxEntry, stillPermitted: () => boolean = () => false): Promise<any> {
    if (!entry.localSessionId || !sameOwner(entry.owner, this.getOwner())) throw new Error('Account changed');
    this.store.remote.assertActor(entry.localSessionId, entry.owner);
    const localId = entry.localSessionId;
    const request = entry.command.request;
    const session = this.store.getSession(localId, 0);
    const startsRun = ['create_session', 'send_message'].includes(entry.command.type);
    const binding = this.store.remote.get<{ agentId: string; version: string | null; cwd: string; workspaceId: string | null }>(`agentExecution:${entry.command.commandId}`);
    const explicit = entry.command.type === 'create_session' && request.payload.agentId !== undefined;
    const fixedAgentId = session?.agentId || AgentId.Main;
    const fixedCwd = session?.cwd;
    const assertBinding = (): void => {
      if (!startsRun) return;
      if (!session || !sameOwner(this.store.remote.owner(localId), entry.owner)) throw remoteAgentFailure('NOT_SELECTABLE');
      const current = this.store.getSession(localId, 0);
      if (!current || (current.agentId || AgentId.Main) !== fixedAgentId || current.cwd !== fixedCwd) throw remoteAgentFailure('BINDING_MISMATCH');
      if (entry.command.type === 'create_session') {
        const requested = request.payload.agentId || AgentId.Main;
        if (requested !== fixedAgentId || explicit && (!binding || binding.agentId !== requested
          || binding.version !== request.payload.expectedAgentVersion || binding.workspaceId !== request.payload.workspaceId || binding.cwd !== resolve(current.cwd))) throw remoteAgentFailure('BINDING_MISMATCH');
      }
      this.validateAgent(fixedAgentId, entry.owner, explicit ? request.payload.expectedAgentVersion : undefined, explicit);
      if (explicit || entry.command.type === 'send_message') this.validateDirectory(current.cwd);
    };
    let bindingFailure: RemoteAgentError | undefined;
    const assertAgentBinding = (): void => {
      try { assertBinding(); } catch (error) { if (error instanceof RemoteAgentError) bindingFailure = error; throw error; }
    };
    const result = await context.run({ owner: entry.owner, preparedSessionId: localId, runId: entry.runId || undefined, commandId: entry.command.commandId, stillPermitted, assertAgentBinding }, async () => {
      assertRemoteExecutionPermit();
      if (entry.command.type === 'create_session') return this.startHandler!({ prompt: request.payload.text, cwd: fixedCwd, agentId: fixedAgentId });
      if (entry.command.type === 'send_message') return this.continueHandler!({ prompt: request.payload.text, sessionId: localId });
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
      if (entry.command.type === 'approval_response') {
        const key = `approval:${localId}:${request.payload.approvalId}`;
        const approval = this.store.remote.get<any>(key);
        if (!approval || approval.status !== 'pending' || !approval.remoteAllowed || approval.approvalVersion !== request.payload.approvalVersion
          || approval.operationDigest !== request.payload.operationDigest || approval.runId !== entry.runId
          || approval.requiresLocalAction || Date.parse(approval.expiresAt) <= Date.now()
          || this.store.remote.run(localId)?.runId !== entry.runId) throw new Error('Approval stale or requires desktop');
        this.store.remote.put(key, { ...approval, pendingDecision: request.payload.decision === 'approve' ? 'approved' : 'denied' });
        if (!this.runtime.respondToPermissionConfirmed) throw new Error('Confirmed approval is unavailable');
        assertRemoteExecutionPermit();
        await this.runtime.respondToPermissionConfirmed(approval.approvalId, request.payload.decision === 'approve'
          ? { behavior: 'allow', updatedInput: {} } : { behavior: 'deny', message: 'Denied from mobile' });
        return { success: true };
      }
      throw new Error('Unsupported command');
    });
    if (!result?.success) throw bindingFailure || new Error(result?.error || 'Task submission failed');
    return { outcome: ['create_session', 'send_message'].includes(entry.command.type) ? 'started'
      : entry.command.type === 'cancel_run' ? (result.alreadyTerminal ? 'already_terminal' : 'cancel_requested') : 'approval_applied' };
  }
  private permission(sessionId: string, request: PermissionRequest): void {
    const run = this.store.remote.run(sessionId);
    if (!run) return;
    // Arbitrary shell commands and plugin descriptions can contain secrets. v1 safely requires desktop review.
    const safeRemote = request.toolInput.approvalKind === 'plugin'
      && request.toolInput.remoteSafe === true && typeof request.toolInput.publicSummary === 'string'
      && typeof request.toolInput.expiresAt === 'string' && Date.parse(request.toolInput.expiresAt) > Date.now()
      && Array.isArray(request.toolInput.allowedDecisions) && request.toolInput.allowedDecisions.includes('allow-once');
    this.store.remote.transaction(() => {
      this.store.remote.put(`approval:${sessionId}:${request.requestId}`, {
        approvalId: request.requestId, runId: run.runId, approvalVersion: '1', title: t('remotePermissionRequired'),
        summary: safeRemote ? String(request.toolInput.publicSummary).slice(0, 1000) : t('remoteReviewOnDesktop'),
        operationDigest: payloadHash({ runId: run.runId, request: JSON.parse(JSON.stringify(request)) }), remoteAllowed: safeRemote,
        requiresLocalAction: !safeRemote, expiresAt: typeof request.toolInput.expiresAt === 'string' && Number.isFinite(Date.parse(request.toolInput.expiresAt))
          ? new Date(request.toolInput.expiresAt).toISOString() : new Date(Date.now() + 15 * 60000).toISOString(), status: 'pending', resolvedAt: null,
      });
      this.store.remote.updateRun(sessionId, safeRemote ? 'waiting_approval' : 'waiting_local');
    });
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
