export const CoworkItemStatus = { Running: 'running', Completed: 'completed', Failed: 'failed', Interrupted: 'interrupted' } as const;
export type CoworkItemStatus = typeof CoworkItemStatus[keyof typeof CoworkItemStatus];
const resolveCoworkToolLifecycle = (result: CoworkMessage | undefined, running: boolean): CoworkItemStatus =>
  result?.metadata?.isError ? CoworkItemStatus.Failed
    : result && !result.metadata?.isStreaming && result.metadata?.isFinal !== false ? CoworkItemStatus.Completed
      : running ? CoworkItemStatus.Running : CoworkItemStatus.Interrupted;
import type { OpenClawProgressCard } from '../../../shared/cowork/progressCard';
import type { CoworkMessage } from '../../types/cowork';
import { getToolInputSummary, normalizeToolName } from './messageDisplayUtils';

export interface ProgressActivity {
  turnId: string;
  startedAt: number;
  updatedAt: number;
  steps: Array<{ id: string; text: string; status: CoworkItemStatus }>;
  /** A successful native write/clear always takes precedence over inferred activity. */
  nativeWritten: boolean;
}

const callKey = (message: CoworkMessage) => message.metadata?.toolUseId ?? message.id;
const bookkeepingTools = new Set(['toolsearch', 'toolsearchcode', 'tooldescribe', 'toolcall', 'progresscard', 'updateplan']);

/** Project recorded actions, never invent future plan steps or infer task success. */
export function deriveProgressActivity(messages: readonly CoworkMessage[], running: boolean): ProgressActivity | null {
  let start = messages.length - 1;
  while (start >= 0 && (messages[start].type !== 'user' || messages[start].metadata?.isSteer)) start--;
  if (start < 0) return null;
  const calls = new Map<string, CoworkMessage>();
  const results = new Map<string, CoworkMessage>();
  const turn = messages.slice(start + 1);
  for (const message of turn) {
    if (!message.metadata?.toolUseId) continue;
    if (message.type === 'tool_use') calls.set(callKey(message), message);
    if (message.type === 'tool_result') results.set(callKey(message), message);
  }
  const steps: ProgressActivity['steps'] = [];
  let nativeWritten = false;
  let updatedAt = messages[start].timestamp;
  for (const [key, call] of calls) {
    const result = results.get(key);
    const status = resolveCoworkToolLifecycle(result, running);
    const name = normalizeToolName(call.metadata?.toolName ?? '');
    if (name === 'progresscard' && status === CoworkItemStatus.Completed) nativeWritten = true;
    if (bookkeepingTools.has(name) || call.metadata?.isGenerating) continue;
    updatedAt = Math.max(updatedAt, result?.timestamp ?? call.timestamp);
    steps.push({ id: key, text: String(call.metadata?.toolInput?.description ?? getToolInputSummary(call.metadata?.toolName ?? '', call.metadata?.toolInput) ?? call.metadata?.toolName ?? ''),
      status: status });
  }
  return { turnId: messages[start].id, startedAt: messages[start].timestamp, updatedAt, steps, nativeWritten };
}

/** Legacy host placeholders are not model-authored plans. Never mutate saved gateway data. */
export function isLegacyProgressPlaceholder(card: OpenClawProgressCard): boolean {
  return !card.steps?.length && [
    '已开始执行多项工具操作；详细任务计划尚未提供。',
    'Multiple tool operations have started; a detailed task plan has not been provided yet.',
  ].includes(card.markdown?.trim() ?? '');
}

export function selectProgressDisplay(card: OpenClawProgressCard | null, activity: ProgressActivity | null) {
  const native = card && !isLegacyProgressPlaceholder(card)
    && (!activity || card.updatedAt >= activity.startedAt) ? card : null;
  return {
    card: native,
    activity: !native && activity && !activity.nativeWritten && activity.steps.length >= 2 ? activity : null,
  };
}
