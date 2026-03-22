import { v4 as uuidv4 } from 'uuid';
import { CoworkRunner } from './coworkRunner';
import { getCoworkStore, type CoworkAgentRecord } from '../coworkStore';
import type { CoworkExecutionMode } from '../coworkStore';

export const MAX_ORCHESTRATION_DEPTH = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SubagentRunStatus = 'running' | 'completed' | 'error';

export interface SubagentRunRecord {
  runId: string;
  agentId: string;
  agentName: string;
  parentSessionId: string;
  subSessionId: string;
  depth: number;
  status: SubagentRunStatus;
  spawnedAt: number;
  endedAt?: number;
  error?: string;
}

// ── SubagentRegistry ──────────────────────────────────────────────────────────

export class SubagentRegistry {
  private runs = new Map<string, SubagentRunRecord>();

  register(record: SubagentRunRecord): void {
    this.runs.set(record.runId, record);
  }

  update(runId: string, patch: Partial<SubagentRunRecord>): void {
    const existing = this.runs.get(runId);
    if (existing) {
      this.runs.set(runId, { ...existing, ...patch });
    }
  }

  listByParent(parentSessionId: string): SubagentRunRecord[] {
    return [...this.runs.values()].filter(r => r.parentSessionId === parentSessionId);
  }

  get(runId: string): SubagentRunRecord | undefined {
    return this.runs.get(runId);
  }
}

/** Singleton registry shared across all sessions in the process. */
export const subagentRegistry = new SubagentRegistry();

// ── SpawnSubagent ─────────────────────────────────────────────────────────────

export interface SpawnSubagentParams {
  agentId: string;
  task: string;
  depth: number;
  parentSessionId: string;
  runner: CoworkRunner;
}

export type SpawnSubagentResult =
  | { status: 'accepted'; runId: string; note: string }
  | { status: 'forbidden'; error: string }
  | { status: 'error'; error: string };

/**
 * Spawn a sub-agent asynchronously, aligned with OpenClaw's subagent mechanism:
 * - Returns immediately with `accepted` + `run_id`
 * - Sub-agent executes in a background Promise
 * - On completion, announces result back to parent session via runner.injectAnnounce()
 */
export function spawnSubagent(params: SpawnSubagentParams): SpawnSubagentResult {
  const { agentId, task, depth, parentSessionId, runner } = params;

  // Depth guard
  if (depth > MAX_ORCHESTRATION_DEPTH) {
    return { status: 'error', error: `Orchestration depth limit (${MAX_ORCHESTRATION_DEPTH}) exceeded` };
  }

  // Resolve target agent
  const { agents } = getCoworkStore().getAgents();
  const targetAgent = agents.find((a: CoworkAgentRecord) => a.id === agentId);
  if (!targetAgent) {
    return { status: 'error', error: `Agent '${agentId}' not found` };
  }
  // No hard restriction on which agents can be targeted — the LLM decides
  // based on its role whether dispatching to a specific agent makes sense.

  const runId = uuidv4();
  const subSessionId = `orch_${runId.slice(0, 8)}`;
  const store = getCoworkStore();

  // Register run immediately
  subagentRegistry.register({
    runId,
    agentId: targetAgent.id,
    agentName: targetAgent.name,
    parentSessionId,
    subSessionId,
    depth,
    status: 'running',
    spawnedAt: Date.now(),
  });

  // Create ephemeral sub-session
  store.createSession(
    `[subagent] ${targetAgent.name}`,
    targetAgent.workingDirectory || '',
    targetAgent.systemPrompt || '',
    (targetAgent.executionMode as CoworkExecutionMode) || 'local',
    [],
    targetAgent.id,
  );

  // Log: spawning
  runner.injectSystemLog(
    parentSessionId,
    `🚀 派发子任务 → **${targetAgent.name}**（runId: \`${runId.slice(0, 8)}\`）`
  );

  // Fire-and-forget: run sub-agent in background
  void runSubagentBackground({
    runId,
    subSessionId,
    targetAgentName: targetAgent.name,
    workingDirectory: targetAgent.workingDirectory || '',
    systemPrompt: targetAgent.systemPrompt || '',
    task,
    parentSessionId,
    runner,
    store,
  });

  return {
    status: 'accepted',
    runId,
    note: 'auto-announces on completion, do not poll/sleep. The result will be sent back as a user message.',
  };
}

// ── Background execution ──────────────────────────────────────────────────────

async function runSubagentBackground(params: {
  runId: string;
  subSessionId: string;
  targetAgentName: string;
  workingDirectory: string;
  systemPrompt: string;
  task: string;
  parentSessionId: string;
  runner: CoworkRunner;
  store: ReturnType<typeof getCoworkStore>;
}): Promise<void> {
  const {
    runId, subSessionId, targetAgentName,
    workingDirectory, systemPrompt, task,
    parentSessionId, runner, store,
  } = params;

  try {
    await runner.startSession(subSessionId, task, {
      systemPrompt,
      workspaceRoot: workingDirectory,
      autoApprove: true,
    });

    const subSession = store.getSession(subSessionId);
    const lastAssistant = subSession?.messages.filter(m => m.type === 'assistant').at(-1);
    const output = lastAssistant?.content ?? '(no output)';

    subagentRegistry.update(runId, { status: 'completed', endedAt: Date.now() });
    runner.injectSystemLog(
      parentSessionId,
      `✅ **${targetAgentName}** 完成任务（runId: \`${runId.slice(0, 8)}\`）`
    );
    runner.injectAnnounce(parentSessionId, targetAgentName, output, false);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    subagentRegistry.update(runId, { status: 'error', endedAt: Date.now(), error: errMsg });
    runner.injectSystemLog(
      parentSessionId,
      `❌ **${targetAgentName}** 执行失败（runId: \`${runId.slice(0, 8)}\`）：${errMsg.slice(0, 120)}`
    );
    runner.injectAnnounce(parentSessionId, targetAgentName, errMsg, true);
  } finally {
    try { store.deleteSession(subSessionId); } catch { /* best-effort */ }
  }
}