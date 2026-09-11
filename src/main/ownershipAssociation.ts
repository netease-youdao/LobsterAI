import { randomUUID } from 'crypto';

import { AgentId, AgentOwnerKind } from '../shared/agent/constants';
import {
  OWNERSHIP_MANUAL_SOURCE, OWNERSHIP_PLAN_TTL_MS, OwnershipErrorCode, OwnershipResultStatus,
  OwnershipSyncState, OwnershipTargetKind,
} from '../shared/ownership/constants';
import type {
  OwnershipAccount, OwnershipCommitRequest, OwnershipCommitResult, OwnershipDetail, OwnershipDisplay,
  OwnershipPreview, OwnershipResources, OwnershipResult, OwnershipTarget,
} from '../shared/ownership/types';
import { type RemoteOwner,RemoteRunStatus } from '../shared/remote/constants';
import { type AgentOwnerStore, sessionVisibilitySql } from './agentOwnership';
import {
type OwnershipAssociationReceipt,   OwnershipAssociationStore, type OwnershipManifest,
} from './ownershipAssociationStore';
import { payloadHash, sameOwner, stableJson } from './remote/canonical';
import type { RemoteStore, SessionOwnershipRecord } from './remote/remoteStore';

export class OwnershipAssociationError extends Error {
  constructor(readonly code: OwnershipErrorCode) { super(code); this.name = 'OwnershipAssociationError'; }
}

export interface OwnershipActor {
  owner: RemoteOwner | null; generation: string; label: string; scopeLabel: string;
}
interface AssociationDependencies {
  store: { remote: RemoteStore; agentOwnership: AgentOwnerStore; runSessionTransaction<T>(operation: () => T): T };
  actor(): OwnershipActor;
  gate: { tryAcquire(resources: OwnershipResources): (() => void) | null; isBusy(resources: OwnershipResources): boolean };
  isBusy?(resources: OwnershipResources): boolean;
  deviceName?(): string;
  syncState?(target: OwnershipTarget): OwnershipSyncState | undefined;
  afterCommit?(result: OwnershipCommitResult): void;
  now?(): number;
}
interface SessionRow {
  id: string; title: string; agent_id: string | null; parent_session_id: string | null;
  status: string; created_at: number; updated_at: number;
}
interface RunRow {
  id: string; parent_session_id: string; child_cowork_session_id: string | null;
  agent_id: string | null; status: string;
}
interface Scope {
  target: OwnershipTarget; targetTitle: string; agentId: string; resources: OwnershipResources;
  sessions: SessionRow[]; associated: SessionRow[]; retained: SessionRow[]; children: Set<string>; hash: string;
}
interface Plan { preview: OwnershipPreview; owner: RemoteOwner; scope: Scope }

const terminalRuns = new Set<string>([
  RemoteRunStatus.Succeeded, RemoteRunStatus.Failed, RemoteRunStatus.Cancelled, RemoteRunStatus.Interrupted,
]);
const completeSubagentRuns = new Set(['done', 'error']);
const completeInbox = new Set(['applied', 'rejected']);
const completeCommands = new Set(['applied', 'rejected', 'expired']);
const fail = (code: OwnershipErrorCode): never => { throw new OwnershipAssociationError(code); };
const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** Synchronous preview/commit. A commit is never enqueued after getResult reports not_committed. */
export class OwnershipAssociationService {
  readonly receipts: OwnershipAssociationStore;
  private readonly plans = new Map<string, Plan>();
  private readonly remote: RemoteStore;
  private readonly agents: AgentOwnerStore;

  constructor(private readonly deps: AssociationDependencies) {
    this.remote = deps.store.remote;
    this.agents = deps.store.agentOwnership;
    this.receipts = new OwnershipAssociationStore(this.remote);
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private account(actor: OwnershipActor): OwnershipAccount | null {
    return actor.owner ? { label: actor.label, scopeLabel: actor.scopeLabel, partition: payloadHash(actor.owner) } : null;
  }
  private validateTarget(target: OwnershipTarget): void {
    if (!target || !Object.values(OwnershipTargetKind).includes(target.kind)
      || typeof target.id !== 'string' || !target.id.trim() || target.id.length > 256) fail(OwnershipErrorCode.NotAvailable);
  }
  private session(id: string): SessionRow | null {
    return this.remote.db.prepare(`SELECT id,title,agent_id,parent_session_id,status,created_at,updated_at
      FROM cowork_sessions WHERE id=?`).get(id) as SessionRow | undefined ?? null;
  }
  private ownerMatches(record: SessionOwnershipRecord | null, actor: RemoteOwner | null): boolean {
    return record === null || Boolean(record.ownership_status === 'confirmed' && actor
      && record.owner_user_id === actor.userId && record.owner_scope_key === actor.scopeKey);
  }
  private readableSession(id: string, actor: RemoteOwner | null): SessionRow {
    const row = this.session(id);
    if (!row || !this.ownerMatches(this.remote.ownershipRecord(id), actor)
      || !this.agents.canView(row.agent_id || AgentId.Main, actor)) return fail(OwnershipErrorCode.NotAvailable);
    return row;
  }
  private agentName(id: string): string {
    return (this.remote.db.prepare('SELECT name FROM agents WHERE id=?').get(id) as { name: string } | undefined)?.name ?? '';
  }
  private displayAgent(id: string, actor: OwnershipActor): OwnershipDisplay {
    const record = this.agents.get(id)!;
    if (record.ownerKind === AgentOwnerKind.Default) return { kind: AgentOwnerKind.Default, label: '', scopeLabel: '' };
    if (record.ownerKind === AgentOwnerKind.Anonymous) return { kind: AgentOwnerKind.Anonymous, label: '', scopeLabel: '' };
    const claim = actor.owner && this.receipts.list(actor.owner).find(receipt => receipt.target_kind === OwnershipTargetKind.Agent && receipt.target_id === id);
    return { kind: AgentOwnerKind.Owned, label: actor.label, scopeLabel: actor.scopeLabel,
      ...(claim ? { associatedAt: claim.associated_at } : {}) };
  }
  private syncState(target: OwnershipTarget): OwnershipSyncState {
    const override = this.deps.syncState?.(target);
    if (override) return override;
    if (target.kind === OwnershipTargetKind.Agent) {
      return this.agents.get(target.id)?.ownerKind === AgentOwnerKind.Owned ? OwnershipSyncState.Pending : OwnershipSyncState.Local;
    }
    const sync = this.remote.sync(target.id);
    if (!sync) return OwnershipSyncState.Local;
    if (this.remote.get(`syncFailure:${target.id}`)) return OwnershipSyncState.Failed;
    return sync.needs_snapshot || sync.ack_seq < sync.source_seq ? OwnershipSyncState.Pending : OwnershipSyncState.Synced;
  }

  getDetail(target: OwnershipTarget): OwnershipDetail {
    this.validateTarget(target);
    const actor = this.deps.actor();
    const common = { ...target, deviceName: this.deps.deviceName?.() ?? '',
      accountPartition: this.account(actor)?.partition ?? null, syncState: this.syncState(target) };
    if (target.kind === OwnershipTargetKind.Agent) {
      if (!this.agents.canView(target.id, actor.owner)) return fail(OwnershipErrorCode.NotAvailable);
      const record = this.agents.get(target.id)!;
      const visibility = sessionVisibilitySql(actor.owner);
      const filter = `FROM cowork_sessions s WHERE COALESCE(NULLIF(s.agent_id,''),'main')=? AND ${visibility.sql}`;
      const visibleTaskCount = (this.remote.db.prepare(`SELECT COUNT(*) AS total ${filter}`).get(target.id, ...visibility.parameters) as { total: number }).total;
      const latest = this.remote.db.prepare(`SELECT s.title ${filter} ORDER BY s.updated_at DESC,s.id DESC LIMIT 1`).get(target.id, ...visibility.parameters) as { title: string } | undefined;
      const agent = this.remote.db.prepare('SELECT * FROM agents WHERE id=?').get(target.id) as { description?: string } | undefined;
      return { ...common, title: this.agentName(target.id), ownership: this.displayAgent(target.id, actor),
        description: agent?.description?.slice(0, 160), visibleTaskCount, latestTaskTitle: latest?.title,
        canAssociate: record.ownerKind === AgentOwnerKind.Anonymous, updatedAt: record.updatedAt };
    }
    const task = this.readableSession(target.id, actor.owner);
    const owner = this.remote.ownershipRecord(task.id);
    const agentId = task.agent_id || AgentId.Main;
    const ownership: OwnershipDisplay = owner ? { kind: AgentOwnerKind.Owned, label: actor.label, scopeLabel: actor.scopeLabel,
      ...(owner.source === OWNERSHIP_MANUAL_SOURCE ? { associatedAt: owner.created_at } : {}) }
      : { kind: AgentOwnerKind.Anonymous, label: '', scopeLabel: '' };
    return { ...common, title: task.title, ownership, agent: { id: agentId, name: this.agentName(agentId), ownership: this.displayAgent(agentId, actor) },
      canAssociate: !owner, status: task.status, updatedAt: task.updated_at };
  }

  preview(target: OwnershipTarget): OwnershipPreview {
    const detail = this.getDetail(target);
    const actor = this.deps.actor();
    const response: OwnershipPreview = {
      planId: '', planVersion: '', accountGeneration: actor.generation, expiresAt: this.now() + OWNERSHIP_PLAN_TTL_MS,
      account: this.account(actor), eligible: false, kind: target.kind, targetId: target.id, targetTitle: detail.title,
      agentId: detail.agent?.id ?? target.id, anonymousTaskCount: 0, subtaskCount: 0, existingOwnedTaskCount: 0,
      tasks: [], agentWillAssociate: target.kind === OwnershipTargetKind.Agent,
    };
    if (!actor.owner) return { ...response, reason: OwnershipErrorCode.AuthRequired };
    if (!detail.canAssociate) return { ...response, reason: OwnershipErrorCode.NotAssociable };
    try {
      const scope = this.resolve(target, actor.owner);
      this.assertIdle(scope);
      if (this.deps.gate.isBusy(scope.resources)) fail(OwnershipErrorCode.ResourceBusy);
      const preview: OwnershipPreview = { ...response, eligible: true, planId: randomUUID(), planVersion: scope.hash,
        anonymousTaskCount: scope.associated.filter(session => !scope.children.has(session.id)).length,
        subtaskCount: scope.associated.filter(session => scope.children.has(session.id)).length,
        existingOwnedTaskCount: scope.retained.length,
        tasks: scope.associated.map(session => ({ id: session.id, title: session.title, isSubtask: scope.children.has(session.id) })),
      };
      for (const [id, plan] of this.plans) if (plan.preview.expiresAt <= this.now()) this.plans.delete(id);
      if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
      this.plans.set(preview.planId, { preview, owner: { ...actor.owner }, scope });
      return preview;
    } catch (error) {
      if (error instanceof OwnershipAssociationError) return { ...response, reason: error.code };
      throw error;
    }
  }

  private resolve(target: OwnershipTarget, actor: RemoteOwner): Scope {
    const task = target.kind === OwnershipTargetKind.Task ? this.readableSession(target.id, actor) : null;
    const agentId = task?.agent_id || (task ? AgentId.Main : target.id);
    if (!this.agents.canView(agentId, actor)) return fail(OwnershipErrorCode.NotAvailable);
    if (target.kind === OwnershipTargetKind.Agent && this.agents.get(agentId)?.ownerKind !== AgentOwnerKind.Anonymous) {
      return fail(OwnershipErrorCode.NotAssociable);
    }
    if (task && this.remote.ownershipRecord(task.id)) return fail(OwnershipErrorCode.NotAssociable);
    const runs = this.remote.db.prepare(`SELECT id,parent_session_id,child_cowork_session_id,agent_id,status FROM subagent_runs
      ORDER BY id`).all() as RunRow[];
    const parents = new Map<string, Set<string>>();
    const descendants = new Map<string, Set<string>>();
    for (const run of runs) {
      if (!run.child_cowork_session_id) continue;
      const parentSet = parents.get(run.child_cowork_session_id) ?? new Set<string>();
      parentSet.add(run.parent_session_id); parents.set(run.child_cowork_session_id, parentSet);
      const childSet = descendants.get(run.parent_session_id) ?? new Set<string>();
      childSet.add(run.child_cowork_session_id); descendants.set(run.parent_session_id, childSet);
    }
    const selected = new Map<string, SessionRow>();
    const references = new Map<string, SessionRow>();
    const agentIds = new Set([agentId]);
    const validate = (id: string): SessionRow => {
      const row = this.session(id);
      const owner = this.remote.ownershipRecord(id);
      if (!row || !this.ownerMatches(owner, actor) || (!owner && this.remote.sync(id))) return fail(OwnershipErrorCode.NotAssociable);
      const childAgent = row.agent_id || AgentId.Main;
      if (!this.agents.canView(childAgent, actor)) return fail(OwnershipErrorCode.NotAssociable);
      references.set(id, row); agentIds.add(childAgent);
      const realParents = parents.get(id);
      if (realParents && (realParents.size !== 1 || (row.parent_session_id && !realParents.has(row.parent_session_id)))) {
        return fail(OwnershipErrorCode.NotAssociable);
      }
      return row;
    };
    const parentChain = (id: string): string[] => {
      const path: string[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined = id;
      while (cursor) {
        if (seen.has(cursor)) return fail(OwnershipErrorCode.NotAssociable);
        seen.add(cursor); validate(cursor); path.push(cursor);
        cursor = parents.get(cursor)?.values().next().value;
      }
      return path;
    };
    const includeTree = (id: string, visiting = new Set<string>()): void => {
      if (visiting.has(id)) return fail(OwnershipErrorCode.NotAssociable);
      if (selected.has(id)) return;
      const row = validate(id);
      visiting.add(id); selected.set(id, row);
      for (const child of descendants.get(id) ?? []) includeTree(child, visiting);
      visiting.delete(id);
    };
    if (task) {
      const chain = parentChain(task.id);
      includeTree(chain[chain.length - 1]);
    } else {
      const direct = this.remote.db.prepare(`SELECT id FROM cowork_sessions WHERE COALESCE(NULLIF(agent_id,''),'main')=? ORDER BY id`)
        .all(agentId) as { id: string }[];
      const directIds = new Set(direct.map(row => row.id));
      for (const row of direct) {
        const chain = parentChain(row.id);
        for (const parent of chain.slice(1)) {
          if (!directIds.has(parent) && !this.remote.ownershipRecord(parent)) return fail(OwnershipErrorCode.NotAssociable);
        }
        includeTree(row.id);
      }
    }
    const relevantRuns = runs.filter(run => references.has(run.parent_session_id)
      || Boolean(run.child_cowork_session_id && references.has(run.child_cowork_session_id))
      || (target.kind === OwnershipTargetKind.Agent && run.agent_id === agentId));
    for (const run of relevantRuns) {
      // An external execution reference must have a trustworthy visible parent too.
      validate(run.parent_session_id);
      if (run.child_cowork_session_id) validate(run.child_cowork_session_id);
      if (run.agent_id) {
        if (!this.agents.canView(run.agent_id, actor)) return fail(OwnershipErrorCode.NotAssociable);
        agentIds.add(run.agent_id);
      }
      if (!completeSubagentRuns.has(run.status)) return fail(OwnershipErrorCode.ResourceBusy);
    }
    const sessions = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
    const resources = { agentIds: sorted(agentIds), sessionIds: sorted(references.keys()) };
    const associated = sessions.filter(session => !this.remote.ownershipRecord(session.id));
    const retained = sessions.filter(session => this.remote.ownershipRecord(session.id));
    const fingerprint = {
      target, sessions: [...references.values()].sort((a, b) => a.id.localeCompare(b.id)), runs: relevantRuns,
      owners: resources.sessionIds.map(id => this.remote.ownershipRecord(id)),
      agents: resources.agentIds.map(id => this.agents.get(id)),
      control: resources.sessionIds.map(id => this.remote.controlVersion(id)),
    };
    return { target, targetTitle: task?.title ?? this.agentName(agentId), agentId, resources, sessions,
      associated, retained, children: new Set(parents.keys()), hash: payloadHash(fingerprint) };
  }

  private assertIdle(scope: Scope): void {
    const sessions = new Set(scope.resources.sessionIds);
    const agents = new Set(scope.resources.agentIds);
    if (scope.target.kind === OwnershipTargetKind.Agent) {
      // A source may not have materialized a subagent run yet. Its configured target
      // reservation and active sessions still prevent changing the target's owner.
      const sources = this.remote.db.prepare('SELECT id,subagent_allow_agent_ids FROM agents').all() as
        Array<{ id: string; subagent_allow_agent_ids: string | null }>;
      for (const source of sources) {
        let allowed: unknown;
        try { allowed = JSON.parse(source.subagent_allow_agent_ids || '[]'); } catch { return fail(OwnershipErrorCode.ResourceBusy); }
        if (!Array.isArray(allowed)) return fail(OwnershipErrorCode.ResourceBusy);
        if (!allowed.includes(scope.agentId)) continue;
        agents.add(source.id);
        const sourceSessions = this.remote.db.prepare('SELECT id FROM cowork_sessions WHERE agent_id=?').all(source.id) as { id: string }[];
        sourceSessions.forEach(session => sessions.add(session.id));
      }
    }
    if (this.deps.isBusy?.({ agentIds: sorted(agents), sessionIds: sorted(sessions) })) fail(OwnershipErrorCode.ResourceBusy);
    for (const id of sessions) {
      const task = this.session(id);
      if (!task || task.status === RemoteRunStatus.Running) fail(OwnershipErrorCode.ResourceBusy);
      const run = this.remote.run(id);
      if (run && !terminalRuns.has(run.status)) fail(OwnershipErrorCode.ResourceBusy);
      const approvals = [...this.remote.entries<Record<string, unknown>>(`approval:${id}:`),
        ...this.remote.entries<Record<string, unknown>>(`localApprovalBlocker:${id}:`)];
      if (approvals.some(row => row.value.status === 'pending')) fail(OwnershipErrorCode.ResourceBusy);
    }
    for (const { value } of this.remote.entries<any>('inbox:')) {
      const id = value.localSessionId;
      const agentId = value.executionTarget?.agentId ?? value.command?.request?.payload?.agentId;
      if ((sessions.has(id) || agents.has(agentId))
        && (!completeInbox.has(value.state) || !completeCommands.has(value.command?.status))) fail(OwnershipErrorCode.ResourceBusy);
    }
  }

  commit(input: OwnershipCommitRequest): OwnershipCommitResult {
    this.validateCommit(input);
    const actor = this.deps.actor();
    if (!actor.owner) return fail(OwnershipErrorCode.AuthRequired);
    const requestHash = payloadHash(input);
    const previous = this.receipts.find(actor.owner, input.requestId);
    if (previous) {
      if (previous.commit_request_hash !== requestHash) return fail(OwnershipErrorCode.RequestConflict);
      return this.result(previous, actor);
    }
    if (input.accountGeneration !== actor.generation) return fail(OwnershipErrorCode.AccountChanged);
    const plan = this.plans.get(input.planId);
    if (!plan || plan.preview.expiresAt <= this.now()) return fail(OwnershipErrorCode.PlanExpired);
    if (!sameOwner(plan.owner, actor.owner)) return fail(OwnershipErrorCode.AccountChanged);
    if (plan.preview.planVersion !== input.planVersion) return fail(OwnershipErrorCode.PlanChanged);
    const release = this.deps.gate.tryAcquire(plan.scope.resources);
    if (!release) return fail(OwnershipErrorCode.ResourceBusy);
    let result: OwnershipCommitResult;
    try {
      result = this.deps.store.runSessionTransaction(() => this.agents.transaction(() => {
        const currentActor = this.deps.actor();
        if (!sameOwner(currentActor.owner, actor.owner) || currentActor.generation !== actor.generation) return fail(OwnershipErrorCode.AccountChanged);
        const scope = this.resolve(plan.scope.target, actor.owner!);
        if (scope.hash !== input.planVersion) return fail(OwnershipErrorCode.PlanChanged);
        this.assertIdle(scope);
        const now = this.now();
        const version = scope.target.kind === OwnershipTargetKind.Agent
          ? this.agents.associateHistorical(scope.agentId, actor.owner!, now) : null;
        for (const session of scope.associated) this.remote.associateHistorical(session.id, actor.owner!, now);
        const manifest: OwnershipManifest = {
          kind: scope.target.kind, targetId: scope.target.id, agentId: version ? scope.agentId : null, agentVersion: version,
          associatedSessionIds: scope.associated.map(session => session.id), retainedSessionIds: scope.retained.map(session => session.id),
          affectedAgentIds: scope.resources.agentIds,
        };
        const receipt: OwnershipAssociationReceipt = {
          operation_id: randomUUID(), owner_user_id: actor.owner!.userId, owner_scope_key: actor.owner!.scopeKey,
          request_id: input.requestId, commit_request_hash: requestHash, manifest_hash: scope.hash,
          target_kind: scope.target.kind, target_id: scope.target.id, manifest_json: stableJson(manifest),
          associated_at: now, remote_admissions_json: '{}',
        };
        this.receipts.save(receipt);
        return this.result(receipt, actor);
      }));
    } catch (error) {
      if (error instanceof OwnershipAssociationError) throw error;
      console.error('[Ownership] Association transaction failed:', error);
      return fail(OwnershipErrorCode.LocalCommitFailed);
    } finally { release(); }
    this.plans.delete(input.planId);
    this.agents.flushChanges();
    try { this.deps.afterCommit?.(result); } catch (error) { console.error('[Ownership] Post-commit notification failed:', error); }
    return result;
  }

  private validateCommit(input: OwnershipCommitRequest): void {
    if (!input || ['planId', 'planVersion', 'accountGeneration', 'requestId'].some(key =>
      typeof input[key as keyof OwnershipCommitRequest] !== 'string' || !input[key as keyof OwnershipCommitRequest]
      || input[key as keyof OwnershipCommitRequest].length > 256)) fail(OwnershipErrorCode.RequestConflict);
  }
  getResult(input: { requestId: string }): OwnershipResult {
    const actor = this.deps.actor();
    if (!actor.owner) return fail(OwnershipErrorCode.AuthRequired);
    if (!input || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 256) return fail(OwnershipErrorCode.RequestConflict);
    const receipt = this.receipts.find(actor.owner, input.requestId);
    return receipt ? this.result(receipt, actor) : { status: OwnershipResultStatus.NotCommitted };
  }
  private result(receipt: OwnershipAssociationReceipt, actor: OwnershipActor): OwnershipCommitResult {
    const manifest = JSON.parse(receipt.manifest_json) as OwnershipManifest;
    const sessionIds = [...manifest.associatedSessionIds, ...manifest.retainedSessionIds]
      .filter(id => this.session(id) && this.ownerMatches(this.remote.ownershipRecord(id), actor.owner)
        && this.agents.canView(this.session(id)!.agent_id || AgentId.Main, actor.owner));
    const states = sessionIds.map(id => this.syncState({ kind: OwnershipTargetKind.Task, id }));
    if (manifest.agentId) states.push(this.syncState({ kind: OwnershipTargetKind.Agent, id: manifest.agentId }));
    const syncState = states.includes(OwnershipSyncState.Failed) ? OwnershipSyncState.Failed
      : states.includes(OwnershipSyncState.WaitingService) ? OwnershipSyncState.WaitingService
      : states.length && states.every(state => state === OwnershipSyncState.Synced) ? OwnershipSyncState.Synced : OwnershipSyncState.Pending;
    return { status: OwnershipResultStatus.Associated, operationId: receipt.operation_id, requestId: receipt.request_id,
      agentIds: manifest.affectedAgentIds.filter(id => this.agents.canView(id, actor.owner)), sessionIds,
      syncState,
      accountPartition: this.account(actor)!.partition };
  }
}
