import { SubagentToolName, SubagentYield } from '../../shared/cowork/subagent';
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
  let waiting = false;
  for (const message of messages) {
    if (message.type === 'user') {
      spawnIds.clear();
      yieldIds.clear();
      waiting = false;
    } else if (message.type === 'assistant' && message.content.trim()) {
      waiting = false;
    } else if (message.type === 'tool_use') {
      waiting = false;
      const id = message.metadata?.toolUseId;
      if (typeof id !== 'string') continue;
      if (message.metadata?.toolName === SubagentToolName.Spawn) spawnIds.add(id);
      if (message.metadata?.toolName === SubagentToolName.Yield) yieldIds.add(id);
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
