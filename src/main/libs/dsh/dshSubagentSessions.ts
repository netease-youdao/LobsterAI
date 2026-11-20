import type Database from 'better-sqlite3';

import { AgentId } from '../../../shared/agent/constants';
import { DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';
import type { CoworkMessage } from '../../coworkStore';
import { SubagentMessageStore } from '../../subagentMessageStore';
import { type SubagentRun, SubagentRunStore } from '../../subagentRunStore';
import { isDshBackedSessionId, stripDshSessionPrefix } from '../agentEngine/dshRuntimeAdapter';
import { parseStoredMessageMetadata } from '../storedMessageMetadata';
import type { DshHostManager } from './dshHostManager';
import { DshChildEvent, readDshChildHistory, record } from './dshSubagentHistory';
import type { DshTypertClient } from './dshTypertClient';

const RunStatus = { Running: 'running', Done: 'done', Error: 'error' } as const;
const ChildMode = { External: 'external', OneShot: 'one-shot', Continuable: 'continuable', Unknown: 'unknown' } as const;

interface Parent {
  storedId: string | null;
  agentId: string | null;
}

export class DshSubagentSessions {
  private readonly runs: SubagentRunStore;
  private readonly messages: SubagentMessageStore;
  private readonly refreshing = new Map<string, Promise<void>>();

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
  }

  private parent(id: string): Parent | undefined {
    return this.db.prepare('SELECT claude_session_id AS storedId, agent_id AS agentId FROM cowork_sessions WHERE id = ?')
      .get(id) as Parent | undefined;
  }

  private remember(parentId: string, entry: Record<string, unknown>): string | undefined {
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.createdAt !== 'number') return;
    const id = DSH_SESSION_ID_PREFIX + entry.id;
    const existing = this.runs.getSubagentRun(id);
    if (existing) return existing.parentSessionId === parentId ? id : undefined;
    const parent = this.parent(parentId);
    if (!parent || this.db.prepare('SELECT 1 FROM dsh_deleted_subagents WHERE parent_session_id = ? AND child_id = ?')
      .get(parentId, entry.id)) return;
    const label = typeof entry.label === 'string' ? entry.label : typeof entry.name === 'string' ? entry.name : null;
    this.runs.insertSubagentRun({ id, parentSessionId: parentId, sessionKey: id, agentId: parent.agentId || AgentId.Main,
      label, task: null, status: RunStatus.Running, createdAt: entry.createdAt });
    return id;
  }

  observeCatalog(parentId: string, data: Record<string, unknown>): string | undefined {
    return this.remember(parentId, { ...data, id: data.childId, createdAt: data.childCreatedAt });
  }

  getOwningSessionId(nativeChildId: string): string | undefined {
    return this.runs.getSubagentRun(DSH_SESSION_ID_PREFIX + nativeChildId)?.parentSessionId;
  }

  setTask(parentId: string, runId: string, task: string): void {
    this.db.prepare('UPDATE subagent_runs SET task = ? WHERE id = ? AND parent_session_id = ?')
      .run(task, runId, parentId);
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
    await Promise.all(catalog.map(async raw => {
      const entry = record(raw);
      const id = this.remember(parentId, entry);
      if (!id || typeof entry.id !== 'string' || entry.mode === ChildMode.External) return;
      const child = await client.getSessionProjections(entry.id).catch((): null => null);
      const timing = record(record(child?.values).subagentTiming);
      const closed = timing.lastTurnCompleted;
      const run = this.runs.getSubagentRun(id);
      if (!run) return;
      if (timing.active) {
        if (run.status !== RunStatus.Running) this.runs.updateSubagentRunStatus(id, RunStatus.Running, null);
      } else if (typeof closed === 'boolean') {
        const status = closed ? RunStatus.Done : RunStatus.Error;
        if (status !== run.status) this.runs.updateSubagentRunStatus(id, status);
      }
    }));
  }

  listSubagentRunsByAgent(agentId: string, limit: number, offset: number) {
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const runs = this.runs.listSubagentRunsByAgent(agentId, size, start);
    return { runs, hasMore: start + runs.length < this.runs.countSubagentRunsByAgent(agentId) };
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
    return readDshChildHistory(client, { kind: 'subagent', parentSessionId: stripDshSessionPrefix(parent.storedId),
      childSessionId, mode }, identity.seq, runId);
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
      const parentProjection = await this.host.getClient().getSessionProjections(stripDshSessionPrefix(parent.storedId));
      const catalog = record(parentProjection?.values).subagentCatalog;
      if (!Array.isArray(catalog) || !catalog.some(entry => record(entry).id === childId)) return false;
      // Only local runtime-created UUIDs are valid targets for the host filesystem operation.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(childId)) return false;
      const deletion = await this.host.deleteSessionFiles(childId);
      if (deletion.skipped) return false;
    }
    this.db.transaction(() => {
      if (native) this.db.prepare('INSERT OR IGNORE INTO dsh_deleted_subagents VALUES (?, ?)').run(parentId, childId);
      this.messages.deleteByRunIds([runId]);
      this.runs.deleteSubagentRun(runId);
    })();
    return true;
  }
}
