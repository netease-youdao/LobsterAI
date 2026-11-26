import type Database from 'better-sqlite3';

import { AgentId } from '../../../shared/agent/constants';
import { DSH_DELEGATE_MAX_DEPTH, DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';
import type { RemoteOwner } from '../../../shared/remote/constants';
import type { CoworkMessage } from '../../coworkStore';
import { SubagentMessageStore } from '../../subagentMessageStore';
import { type SubagentRun, SubagentRunStore } from '../../subagentRunStore';
import { isDshBackedSessionId, stripDshSessionPrefix } from '../agentEngine/dshRuntimeAdapter';
import { parseStoredMessageMetadata } from '../storedMessageMetadata';
import type { DshHostManager, DshSubagentAgentBinding } from './dshHostManager';
import { DshChildEvent, readDshChildHistory, record } from './dshSubagentHistory';
import type { DshTypertClient } from './dshTypertClient';

const RunStatus = { Running: 'running', Done: 'done', Error: 'error' } as const;
const ChildMode = { External: 'external', OneShot: 'one-shot', Continuable: 'continuable', Unknown: 'unknown' } as const;
const DEFAULT_REPLAY_BINDING_LIMIT = 500;

interface Parent {
  storedId: string | null;
  agentId: string | null;
}

interface BindingRow {
  remote_request_id: string | null;
  child_session_id: string;
  parent_dsh_session_id: string;
  root_cowork_session_id: string;
  target_agent_id: string;
  created_at: number;
}

export class DshSubagentSessions {
  private readonly runs: SubagentRunStore;
  private readonly messages: SubagentMessageStore;
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly directParentByChildId = new Map<string, string>();

  constructor(
    private readonly db: Database.Database,
    private readonly host: Pick<DshHostManager, 'isReady' | 'start' | 'deleteSessionFiles'> & {
      getClient(): Pick<DshTypertClient, 'getSessionProjections' | 'getSessionEvents'>;
    },
    private readonly getStoredMessages: (id: string) => CoworkMessage[],
  ) {
    this.runs = new SubagentRunStore(db);
    this.messages = new SubagentMessageStore(db);
    // dsh's immutable parent catalog keeps the creation event after a user deletes a child.
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_deleted_subagents (
      parent_session_id TEXT NOT NULL REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      child_id TEXT NOT NULL,
      PRIMARY KEY (parent_session_id, child_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_subagent_agent_bindings (
      child_session_id TEXT PRIMARY KEY,
      parent_dsh_session_id TEXT NOT NULL,
      root_cowork_session_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    if (!(db.pragma('table_info(dsh_subagent_agent_bindings)') as Array<{ name: string }>)
      .some(column => column.name === 'remote_request_id')) {
      db.exec('ALTER TABLE dsh_subagent_agent_bindings ADD COLUMN remote_request_id TEXT');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dsh_subagent_bindings_root
      ON dsh_subagent_agent_bindings(root_cowork_session_id)`);
  }

  private parent(id: string): Parent | undefined {
    return this.db.prepare('SELECT claude_session_id AS storedId, agent_id AS agentId FROM cowork_sessions WHERE id = ?')
      .get(id) as Parent | undefined;
  }

  private getAgentBinding(childSessionId: string): DshSubagentAgentBinding | undefined {
    const row = this.db.prepare(
      `SELECT child_session_id, parent_dsh_session_id, root_cowork_session_id, target_agent_id, created_at, remote_request_id
       FROM dsh_subagent_agent_bindings WHERE child_session_id = ?`,
    ).get(childSessionId) as BindingRow | undefined;
    if (!row) return undefined;
    return {
      childSessionId: row.child_session_id,
      parentDshSessionId: row.parent_dsh_session_id,
      rootCoworkSessionId: row.root_cowork_session_id,
      targetAgentId: row.target_agent_id,
      createdAt: row.created_at,
      ...(row.remote_request_id ? { remoteRequestId: row.remote_request_id } : {}),
    };
  }

  private getDirectParentDshSessionId(childSessionId: string, rootDshSessionId: string): string {
    return this.getAgentBinding(childSessionId)?.parentDshSessionId
      ?? this.directParentByChildId.get(childSessionId)
      ?? rootDshSessionId;
  }

  recordAgentBinding(binding: DshSubagentAgentBinding): void {
    const childSessionId = binding.childSessionId.trim();
    const parentDshSessionId = binding.parentDshSessionId.trim();
    const rootCoworkSessionId = binding.rootCoworkSessionId.trim();
    const targetAgentId = binding.targetAgentId.trim();
    if (!childSessionId || !parentDshSessionId || !rootCoworkSessionId || !targetAgentId) return;
    const createdAt = typeof binding.createdAt === 'number' && Number.isFinite(binding.createdAt)
      ? binding.createdAt
      : Date.now();
    this.db.prepare(
      `INSERT OR REPLACE INTO dsh_subagent_agent_bindings (
        child_session_id, parent_dsh_session_id, root_cowork_session_id, target_agent_id, created_at, remote_request_id
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(childSessionId, parentDshSessionId, rootCoworkSessionId, targetAgentId, createdAt, binding.remoteRequestId ?? null);
    this.directParentByChildId.set(childSessionId, parentDshSessionId);
    const runId = DSH_SESSION_ID_PREFIX + childSessionId;
    this.db.prepare('UPDATE subagent_runs SET agent_id = ? WHERE id = ? AND parent_session_id = ?')
      .run(targetAgentId, runId, rootCoworkSessionId);
  }

  deleteAgentBinding(childSessionId: string): void {
    const normalized = childSessionId.trim();
    if (!normalized) return;
    this.db.prepare('DELETE FROM dsh_subagent_agent_bindings WHERE child_session_id = ?').run(normalized);
    this.directParentByChildId.delete(normalized);
  }

  listAgentBindings(limit = DEFAULT_REPLAY_BINDING_LIMIT): DshSubagentAgentBinding[] {
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(2_000, Math.floor(limit))) : DEFAULT_REPLAY_BINDING_LIMIT;
    const rows = this.db.prepare(
      `SELECT child_session_id, parent_dsh_session_id, root_cowork_session_id, target_agent_id, created_at, remote_request_id
       FROM dsh_subagent_agent_bindings
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(size) as BindingRow[];
    return rows.map(row => ({
      childSessionId: row.child_session_id,
      parentDshSessionId: row.parent_dsh_session_id,
      rootCoworkSessionId: row.root_cowork_session_id,
      targetAgentId: row.target_agent_id,
      createdAt: row.created_at,
      ...(row.remote_request_id ? { remoteRequestId: row.remote_request_id } : {}),
    }));
  }

  private remember(
    parentId: string,
    entry: Record<string, unknown>,
    directParentDshSessionId?: string,
  ): string | undefined {
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.createdAt !== 'number') return;
    if (directParentDshSessionId) {
      this.directParentByChildId.set(entry.id, directParentDshSessionId);
    }
    const id = DSH_SESSION_ID_PREFIX + entry.id;
    const binding = this.getAgentBinding(entry.id);
    const existing = this.runs.getSubagentRun(id);
    if (existing) {
      if (existing.parentSessionId !== parentId) return undefined;
      if (binding?.targetAgentId && existing.agentId !== binding.targetAgentId) {
        this.db.prepare('UPDATE subagent_runs SET agent_id = ? WHERE id = ? AND parent_session_id = ?')
          .run(binding.targetAgentId, id, parentId);
      }
      return id;
    }
    const parent = this.parent(parentId);
    if (!parent || this.db.prepare('SELECT 1 FROM dsh_deleted_subagents WHERE parent_session_id = ? AND child_id = ?')
      .get(parentId, entry.id)) return;
    const label = typeof entry.label === 'string' ? entry.label : typeof entry.name === 'string' ? entry.name : null;
    const agentId = binding?.targetAgentId || parent.agentId || AgentId.Main;
    this.runs.insertSubagentRun({
      id,
      parentSessionId: parentId,
      sessionKey: id,
      agentId,
      label,
      task: null,
      status: RunStatus.Running,
      createdAt: entry.createdAt,
    });
    return id;
  }

  observeCatalog(parentId: string, data: Record<string, unknown>): string | undefined {
    return this.remember(parentId, { ...data, id: data.childId, createdAt: data.childCreatedAt });
  }

  getOwningSessionId(nativeChildId: string): string | undefined {
    return this.runs.getSubagentRun(DSH_SESSION_ID_PREFIX + nativeChildId)?.parentSessionId
      ?? this.getAgentBinding(nativeChildId)?.rootCoworkSessionId;
  }

  getRemoteBinding(nativeChildId: string): DshSubagentAgentBinding | undefined {
    return this.getAgentBinding(nativeChildId);
  }

  setTask(parentId: string, runId: string, task: string): void {
    this.db.prepare('UPDATE subagent_runs SET task = ? WHERE id = ? AND parent_session_id = ?')
      .run(task, runId, parentId);
  }

  setDelegatedAgent(parentId: string, runId: string, targetAgentId: string): void {
    const normalized = targetAgentId.trim();
    if (!normalized) return;
    this.db.prepare('UPDATE subagent_runs SET agent_id = ? WHERE id = ? AND parent_session_id = ?')
      .run(normalized, runId, parentId);
  }

  observeNotice(parentId: string, data: Record<string, unknown>, time: unknown): void {
    const source = record(data.source);
    if (source.kind !== DshChildEvent.Settled || typeof source.senderSessionId !== 'string') return;
    const id = DSH_SESSION_ID_PREFIX + source.senderSessionId;
    if (this.runs.getSubagentRun(id)?.parentSessionId !== parentId) return;
    const status = source.stopReason === 'completed' ? RunStatus.Done : RunStatus.Error;
    this.runs.updateSubagentRunStatus(id, status, typeof time === 'number' ? time : undefined);
  }

  async listSubagentRuns(parentId: string): Promise<SubagentRun[]> {
    const parent = this.parent(parentId);
    if (!parent) return [];
    if (parent.storedId && isDshBackedSessionId(parent.storedId) && this.host.isReady()) {
      let pending = this.refreshing.get(parentId);
      if (!pending) {
        pending = this.syncCatalog(parentId, stripDshSessionPrefix(parent.storedId))
          .catch(error => console.warn('[DshSubagent] Could not refresh the parent catalog', error))
          .finally(() => this.refreshing.delete(parentId));
        this.refreshing.set(parentId, pending);
      }
      await pending;
    }
    return this.runs.listSubagentRuns(parentId);
  }

  private async syncCatalog(parentId: string, nativeId: string): Promise<void> {
    const client = this.host.getClient();
    const projection = await client.getSessionProjections(nativeId);
    const catalog = record(projection?.values).subagentCatalog;
    if (!Array.isArray(catalog)) return;
    const visited = new Set<string>([nativeId]);
    await this.syncCatalogEntries(client, parentId, nativeId, catalog, 1, visited);
  }

  private async syncCatalogEntries(
    client: Pick<DshTypertClient, 'getSessionProjections'>,
    rootCoworkSessionId: string,
    directParentDshId: string,
    catalog: unknown[],
    depth: number,
    visited: Set<string>,
  ): Promise<void> {
    await Promise.all(catalog.map(async raw => {
      const entry = record(raw);
      const id = this.remember(rootCoworkSessionId, entry, directParentDshId);
      if (!id || typeof entry.id !== 'string' || entry.mode === ChildMode.External) return;
      const child = await client.getSessionProjections(entry.id).catch((): null => null);
      const childValues = record(child?.values);
      const timing = record(childValues.subagentTiming);
      const closed = timing.lastTurnCompleted;
      const run = this.runs.getSubagentRun(id);
      if (run) {
        if (timing.active) {
          if (run.status !== RunStatus.Running) this.runs.updateSubagentRunStatus(id, RunStatus.Running, null);
        } else if (typeof closed === 'boolean') {
          const status = closed ? RunStatus.Done : RunStatus.Error;
          if (status !== run.status) this.runs.updateSubagentRunStatus(id, status);
        }
      }
      if (depth < DSH_DELEGATE_MAX_DEPTH && !visited.has(entry.id)) {
        const nestedCatalog = childValues.subagentCatalog;
        if (Array.isArray(nestedCatalog) && nestedCatalog.length > 0) {
          visited.add(entry.id);
          await this.syncCatalogEntries(
            client,
            rootCoworkSessionId,
            entry.id,
            nestedCatalog,
            depth + 1,
            visited,
          );
        }
      }
    }));
  }

  listSubagentRunsByAgent(agentId: string, limit: number, offset: number, actor?: RemoteOwner | null) {
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const runs = this.runs.listSubagentRunsByAgent(agentId, size, start, actor);
    return { runs, hasMore: start + runs.length < this.runs.countSubagentRunsByAgent(agentId, actor) };
  }

  async getSubTaskHistory(parentId: string, runId: string): Promise<CoworkMessage[]> {
    const run = this.runs.getSubagentRun(runId);
    const parent = this.parent(parentId);
    if (!parent || run?.parentSessionId !== parentId) throw new Error('Subagent does not belong to this session');
    if (run.id !== run.sessionKey || !run.id.startsWith(DSH_SESSION_ID_PREFIX)) {
      const saved = this.messages.getMessages(runId).map(row => ({
        id: row.id, type: row.type as CoworkMessage['type'], content: row.content, timestamp: row.createdAt,
        metadata: parseStoredMessageMetadata(row.metadata, () =>
          console.warn('[DshSubagent] Ignoring malformed legacy message metadata', row.id)),
      }));
      return saved.length || !run.childCoworkSessionId ? saved : this.getStoredMessages(run.childCoworkSessionId);
    }
    if (!parent.storedId || !isDshBackedSessionId(parent.storedId)) return [];
    await this.host.start();
    const client = this.host.getClient();
    const childSessionId = stripDshSessionPrefix(run.id);
    const projection = await client.getSessionProjections(childSessionId);
    const identity = record(record(projection?.values).subagent);
    if (typeof identity.seq !== 'number') return [];
    const mode = identity.mode === ChildMode.Continuable || identity.mode === ChildMode.OneShot
      ? identity.mode : ChildMode.Unknown;
    const directParentDshId = this.getDirectParentDshSessionId(
      childSessionId,
      stripDshSessionPrefix(parent.storedId),
    );
    return readDshChildHistory(
      client,
      { kind: 'subagent', parentSessionId: directParentDshId, childSessionId, mode },
      identity.seq,
      runId,
    );
  }

  async deleteSubagentSession(parentId: string, runId: string): Promise<boolean> {
    const run = this.runs.getSubagentRun(runId);
    if (run?.parentSessionId !== parentId) return false;
    const native = run.id === run.sessionKey && run.id.startsWith(DSH_SESSION_ID_PREFIX);
    const childId = stripDshSessionPrefix(run.id);
    if (native) {
      await this.host.start();
      const parent = this.parent(parentId);
      if (!parent?.storedId || !isDshBackedSessionId(parent.storedId)) return false;
      const directParentDshId = this.getDirectParentDshSessionId(
        childId,
        stripDshSessionPrefix(parent.storedId),
      );
      const parentProjection = await this.host.getClient().getSessionProjections(directParentDshId);
      const catalog = record(parentProjection?.values).subagentCatalog;
      if (!Array.isArray(catalog) || !catalog.some(entry => record(entry).id === childId)) return false;
      // Only local runtime-created UUIDs are valid targets for the host filesystem operation.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(childId)) return false;
      const deletion = await this.host.deleteSessionFiles(childId);
      if (deletion.skipped) return false;
    }
    this.db.transaction(() => {
      if (native) {
        this.db.prepare('INSERT OR IGNORE INTO dsh_deleted_subagents VALUES (?, ?)').run(parentId, childId);
        this.db.prepare('DELETE FROM dsh_subagent_agent_bindings WHERE child_session_id = ?').run(childId);
      }
      this.messages.deleteByRunIds([runId]);
      this.runs.deleteSubagentRun(runId);
    })();
    this.directParentByChildId.delete(childId);
    return true;
  }
}
