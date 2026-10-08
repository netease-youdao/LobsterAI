import { SubagentYield } from '../../../../shared/cowork/subagent';
import { extractGatewayMessageText } from '../../openclawHistory';
import { AgentLifecyclePhase } from '../constants';
import {
  getHistoryToolCallId,
  getHistoryToolName,
  isHistoryToolResultRole,
} from './historyBackfill';

export { SubagentYield } from '../../../../shared/cowork/subagent';

export const YieldHistoryRole = {
  Assistant: 'assistant',
  User: 'user',
  ToolResult: 'toolResult',
} as const;

export const YieldHistoryToolCallType = {
  ToolCall: 'toolCall',
  ToolUse: 'tool_use',
  ToolCallLegacy: 'tool_call',
  FunctionCall: 'function_call',
} as const;

const TOOL_CALL_TYPES = new Set<string>(Object.values(YieldHistoryToolCallType));

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

/** Match the gateway's yielded-parent contract; failures always remain terminal. */
export const isYieldedLifecycle = (data: unknown): boolean => (
  isRecord(data)
  && data.phase === AgentLifecyclePhase.End
  && data.yielded === true
  && data.livenessState === SubagentYield.LivenessState
  && data.stopReason === SubagentYield.StopReason
  && data.aborted !== true
  && data.status !== SubagentYield.CancelledStatus
  && data.status !== SubagentYield.TimedOutStatus
  && data.timeoutPhase == null
  && data.error == null
);

export const isSuccessfulYieldResult = (
  toolName: string,
  resultText: string,
  isError = false,
): boolean => {
  if (isError || toolName.trim() !== SubagentYield.ToolName) return false;
  try {
    const result: unknown = JSON.parse(resultText);
    return isRecord(result)
      && result.status === SubagentYield.ResultStatus
      && result.error == null;
  } catch {
    return false;
  }
};

const getMessageTimestamp = (message: Record<string, unknown>): number | undefined => {
  for (const value of [message.timestamp, message.createdAt, message.created_at]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value !== 'string' || !value.trim()) continue;
    const numeric = Number(value);
    const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return undefined;
};

const getToolName = (block: Record<string, unknown>): string => (
  getHistoryToolName(block)
  || (isRecord(block.function) ? getHistoryToolName(block.function) : '')
);

const getToolCallBlocks = (message: Record<string, unknown>): Record<string, unknown>[] => {
  const blocks: Record<string, unknown>[] = [];
  for (const value of [
    message.content,
    message.toolCalls,
    message.tool_calls,
    message.toolCall,
    message.tool_call,
    message.function_call,
  ]) {
    for (const block of Array.isArray(value) ? value : [value]) {
      if (!isRecord(block)) continue;
      if (TOOL_CALL_TYPES.has(String(block.type)) || (getToolName(block) && getHistoryToolCallId(block))) {
        blocks.push(block);
      }
    }
  }
  return blocks;
};

/**
 * Recover only a successful yield at this run's history tail. A new assistant
 * segment or unrelated tool activity invalidates the previous handoff, including
 * when requester-settle resumes without adding another user message.
 */
export const getCurrentRunYieldToolCallId = (
  historyMessages: unknown[],
  startedAtMs: number,
): string | undefined => {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return undefined;
  let lastCall: { id: string; name: string; timestamp?: number } | undefined;
  let yieldedToolCallId: string | undefined;

  for (const message of historyMessages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === 'string' ? message.role.trim() : '';
    if (role === YieldHistoryRole.User) {
      lastCall = undefined;
      yieldedToolCallId = undefined;
      continue;
    }
    if (role === YieldHistoryRole.Assistant) {
      yieldedToolCallId = undefined;
      lastCall = undefined;
      for (const block of getToolCallBlocks(message)) {
        lastCall = {
          id: getHistoryToolCallId(block),
          name: getToolName(block),
          timestamp: getMessageTimestamp(message),
        };
      }
      continue;
    }
    if (!isHistoryToolResultRole(role)) continue;
    yieldedToolCallId = undefined;
    const timestamp = getMessageTimestamp(message);
    const toolCallId = getHistoryToolCallId(message);
    if (!toolCallId || timestamp === undefined || timestamp < startedAtMs) continue;
    const resultToolName = getHistoryToolName(message);
    if (lastCall && (
      lastCall.id !== toolCallId
      || lastCall.timestamp === undefined
      || lastCall.timestamp < startedAtMs
      || (resultToolName && resultToolName !== lastCall.name)
    )) continue;
    const toolName = lastCall?.name ?? resultToolName;
    if (isSuccessfulYieldResult(
      toolName,
      extractGatewayMessageText(message),
      Boolean(message.isError || message.is_error || message.error),
    )) {
      yieldedToolCallId = toolCallId;
    }
  }
  return yieldedToolCallId;
};
