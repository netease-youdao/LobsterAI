import { isDshSubagentSpawn, SubagentToolName, SubagentYield } from '../../shared/cowork/subagent';
import type { CoworkMessage, SubagentSessionSummary } from '../types/cowork';

export const SubagentWaitPhase = {
  Children: 'children',
  Summary: 'summary',
} as const;
export type SubagentWaitPhase = typeof SubagentWaitPhase[keyof typeof SubagentWaitPhase];

/** Derive the waiting label from this request's successful handoff, never an older turn. */
export function getSubagentWaitPhase(
  messages: readonly CoworkMessage[],
  subagents: readonly SubagentSessionSummary[],
): SubagentWaitPhase | null {
  const spawnIds = new Set<string>();
  const yieldIds = new Set<string>();
  const nativeWaitIds = new Set<string>();
  let waiting = false;
  for (const message of messages) {
    if (message.type === 'user') {
      spawnIds.clear();
      yieldIds.clear();
      nativeWaitIds.clear();
      waiting = false;
    } else if (message.type === 'assistant' && message.content.trim()) {
      waiting = false;
    } else if (message.type === 'tool_use') {
      waiting = false;
      const id = message.metadata?.toolUseId;
      if (typeof id !== 'string') continue;
      const tool = message.metadata?.toolName;
      if (tool === SubagentToolName.Spawn || isDshSubagentSpawn(tool)) spawnIds.add(id);
      if (tool === SubagentToolName.Yield) yieldIds.add(id);
      if (tool === SubagentToolName.DshWait) {
        nativeWaitIds.add(id);
        waiting = true;
      }
    } else if (message.type === 'tool_result' && spawnIds.has(String(message.metadata?.toolUseId))) {
      const runId = message.metadata?.subagentRunId;
      if (typeof runId === 'string' && !message.metadata?.isError) spawnIds.add(runId);
    } else if (message.type === 'tool_result' && nativeWaitIds.has(String(message.metadata?.toolUseId))) {
      waiting = !message.metadata?.isError;
    } else if (message.type === 'tool_result' && yieldIds.has(String(message.metadata?.toolUseId))) {
      try {
        const result = JSON.parse(message.content);
        waiting = result?.status === SubagentYield.ResultStatus && !result.error && !message.metadata?.isError;
      } catch { waiting = false; }
    }
  }
  const children = subagents.filter(child => spawnIds.has(child.id) && child.sessionKey);
  if (!waiting || children.length === 0) return null;
  return children.some(child => child.status === 'running') ? SubagentWaitPhase.Children : SubagentWaitPhase.Summary;
}
