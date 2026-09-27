import type {
  CoworkSessionStatus,
  CoworkStore,
} from '../../../coworkStore';
import { parseAgentIdFromSubagentSessionKey } from './sessionKeys';
import type {
  SubagentChildSessionCandidateParams,
  SubagentChildSessionMaterializeParams,
} from './tracker';

type SubagentSessionMaterializerStore = Pick<CoworkStore, 'getSession' | 'updateSession'>
  & Partial<Pick<CoworkStore, 'getAgent' | 'upsertSubagentChildSession'>>;

export interface SubagentSessionMaterializerDeps {
  store: SubagentSessionMaterializerStore;
  rememberSessionKey: (sessionId: string, sessionKey: string) => void;
  markSessionHistoryUnsynced: (sessionId: string) => void;
  notifySessionsChanged: (sessionId: string) => void;
  emitSessionStatus: (sessionId: string, status: CoworkSessionStatus) => void;
  emitComplete: (sessionId: string, sessionKey: string) => void;
  emitError: (sessionId: string, error: string) => void;
  resolveSessionIdBySessionKey: (sessionKey: string) => string | null;
  syncSessionHistory: (sessionId: string, sessionKey: string) => Promise<void>;
}

export class SubagentSessionMaterializer {
  constructor(private readonly deps: SubagentSessionMaterializerDeps) {}

  materialize(params: SubagentChildSessionMaterializeParams): void {
    if (!params.childSessionKey.trim() || !params.childCoworkSessionId.trim()) return;
    const title = this.buildTitle(params);
    try {
      const status: CoworkSessionStatus = params.status === 'error' ? 'error' : 'running';
      if (typeof this.deps.store.upsertSubagentChildSession !== 'function') {
        return;
      }
      const session = this.deps.store.upsertSubagentChildSession({
        id: params.childCoworkSessionId,
        parentSessionId: params.parentSessionId,
        childSessionKey: params.childSessionKey,
        agentId: params.agentId || 'main',
        title,
        task: params.task,
        status,
        createdAt: params.createdAt,
      });
      console.log(
        '[OpenClawRuntime] materialized subagent child session:',
        `runId=${params.runId}`,
        `childSessionId=${session.id}`,
        `parentSessionId=${params.parentSessionId}`,
        `childSessionKey=${params.childSessionKey}`,
        `agentId=${params.agentId}`,
        `runStatus=${params.status}`,
        `sessionStatus=${status}`,
      );
      this.deps.rememberSessionKey(session.id, params.childSessionKey);
      this.deps.markSessionHistoryUnsynced(session.id);
      this.deps.notifySessionsChanged(session.id);
      void this.deps.syncSessionHistory(session.id, params.childSessionKey)
        .catch((error) => {
          console.warn('[OpenClawRuntime] subagent child history sync failed:', error);
        });
    } catch (error) {
      console.warn('[OpenClawRuntime] failed to materialize subagent child session:', error);
    }
  }

  shouldMaterialize(params: SubagentChildSessionCandidateParams): boolean {
    const childAgentId = parseAgentIdFromSubagentSessionKey(params.childSessionKey) || params.agentId.trim();
    if (!childAgentId) return true;
    const parentSession = this.deps.store.getSession(params.parentSessionId, 0);
    const parentAgentId = parentSession?.agentId?.trim() || 'main';
    return childAgentId !== parentAgentId;
  }

  finalizePassive(sessionKey: string, status: 'done' | 'error'): void {
    const sessionId = this.deps.resolveSessionIdBySessionKey(sessionKey);
    if (!sessionId) {
      console.log(
        '[OpenClawRuntime] passive subagent finalize skipped: no session mapping',
        `sessionKey=${sessionKey}`,
        `status=${status}`,
      );
      return;
    }

    const nextStatus: CoworkSessionStatus = status === 'done' ? 'completed' : 'error';
    const previousStatus = this.deps.store.getSession(sessionId, 0)?.status ?? 'unknown';
    console.log(
      '[OpenClawRuntime] passive subagent finalize:',
      `sessionId=${sessionId}`,
      `sessionKey=${sessionKey}`,
      `status=${status}`,
      `previousSessionStatus=${previousStatus}`,
      `nextSessionStatus=${nextStatus}`,
    );
    this.deps.store.updateSession(sessionId, { status: nextStatus });
    this.deps.emitSessionStatus(sessionId, nextStatus);
    if (nextStatus === 'completed') {
      this.deps.emitComplete(sessionId, sessionKey);
    } else {
      this.deps.emitError(sessionId, 'Subagent session failed.');
    }
    this.deps.notifySessionsChanged(sessionId);
    void this.deps.syncSessionHistory(sessionId, sessionKey)
      .catch((error) => {
        console.warn('[OpenClawRuntime] passive subagent final history sync failed:', error);
      });
  }

  private buildTitle(params: SubagentChildSessionMaterializeParams): string {
    const label = params.label?.trim();
    if (label) return label;
    const task = params.task?.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (task) return task.length > 80 ? `${task.slice(0, 77)}...` : task;
    const agent = this.deps.store.getAgent?.(params.agentId || 'main');
    return agent?.name?.trim() || params.agentId || 'Subagent';
  }
}
