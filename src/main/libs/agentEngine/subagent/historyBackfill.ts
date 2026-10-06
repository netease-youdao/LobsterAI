import { extractGatewayMessageText } from '../../openclawHistory';
import { parseAgentIdFromSubagentSessionKey } from './sessionKeys';

export type BackfillableHistoryToolEntry = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
  resultTimestamp?: number;
  resultIsError: boolean;
  order: number;
};

const BACKFILLABLE_HISTORY_TOOL_NAMES = new Set([
  'agents_list',
  'sessions_read',
  'sessions_resume',
  'sessions_spawn',
  'sessions_yield',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

export const getHistoryToolCallId = (value: Record<string, unknown>): string => {
  const candidates = [
    value.id,
    value.toolCallId,
    value.tool_call_id,
    value.toolUseId,
    value.tool_use_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
};

export const getHistoryToolName = (value: Record<string, unknown>): string => {
  const candidates = [value.name, value.toolName, value.tool_name];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
};

const getHistoryToolArguments = (value: Record<string, unknown>): Record<string, unknown> => {
  const candidates = [value.arguments, value.args, value.input];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      try {
        const parsed = JSON.parse(candidate);
        if (isRecord(parsed)) {
          return parsed;
        }
      } catch { /* ignore malformed historical tool arguments */ }
    }
  }
  return {};
};

const getHistoryMessageTimestamp = (message: Record<string, unknown>): number | undefined => {
  const candidates = [message.timestamp, message.createdAt, message.created_at];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};

const isBackfillableHistoryToolName = (toolName: string): boolean => (
  BACKFILLABLE_HISTORY_TOOL_NAMES.has(toolName.trim().toLowerCase())
);

const isHistoryToolCallBlock = (value: Record<string, unknown>): boolean => {
  const blockType = typeof value.type === 'string' ? value.type.trim() : '';
  return blockType === 'toolCall' || blockType === 'tool_use' || blockType === 'tool_call';
};

export const isHistoryToolResultRole = (role: string): boolean => {
  const normalized = role.trim().toLowerCase();
  return normalized === 'tool'
    || normalized === 'toolresult'
    || normalized === 'tool_result';
};

const getHistoryToolResultIsError = (message: Record<string, unknown>): boolean => (
  Boolean(message.isError)
  || Boolean(message.is_error)
  || Boolean(message.error)
);

const inferSessionsSpawnArgsFromResultText = (resultText: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(resultText);
    if (!isRecord(parsed)) return null;
    const childSessionKey = typeof parsed.childSessionKey === 'string' ? parsed.childSessionKey.trim() : '';
    if (!childSessionKey) return null;
    const agentId = parseAgentIdFromSubagentSessionKey(childSessionKey);
    const args: Record<string, unknown> = {};
    if (agentId) {
      args.agentId = agentId;
    }
    const taskName = typeof parsed.taskName === 'string' ? parsed.taskName.trim() : '';
    if (taskName) {
      args.taskName = taskName;
    }
    return args;
  } catch {
    return null;
  }
};

export const collectBackfillableHistoryToolEntries = (
  messages: unknown[],
): BackfillableHistoryToolEntry[] => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const toolCalls = new Map<string, { toolName: string; args: Record<string, unknown>; order: number }>();
  const toolResults = new Map<string, {
    toolName: string;
    text: string;
    timestamp?: number;
    isError: boolean;
    order: number;
  }>();

  for (let index = startIdx; index < messages.length; index++) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const role = typeof message.role === 'string' ? message.role.trim() : '';

    if (role === 'assistant' && Array.isArray(message.content)) {
      let blockIndex = 0;
      for (const block of message.content) {
        blockIndex++;
        if (!isRecord(block) || !isHistoryToolCallBlock(block)) continue;
        const toolName = getHistoryToolName(block).trim().toLowerCase();
        if (!isBackfillableHistoryToolName(toolName)) continue;
        const toolCallId = getHistoryToolCallId(block);
        if (!toolCallId || toolCalls.has(toolCallId)) continue;
        toolCalls.set(toolCallId, {
          toolName,
          args: getHistoryToolArguments(block),
          order: index * 1000 + blockIndex,
        });
      }
      continue;
    }

    if (!isHistoryToolResultRole(role)) continue;
    const toolCallId = getHistoryToolCallId(message);
    if (!toolCallId || toolResults.has(toolCallId)) continue;
    const text = extractGatewayMessageText(message);
    if (!text.trim()) continue;
    const toolName = getHistoryToolName(message).trim().toLowerCase();
    toolResults.set(toolCallId, {
      toolName,
      text,
      timestamp: getHistoryMessageTimestamp(message),
      isError: getHistoryToolResultIsError(message),
      order: index * 1000,
    });
  }

  const entries: BackfillableHistoryToolEntry[] = [];
  const consumedResultIds = new Set<string>();

  for (const [toolCallId, call] of toolCalls.entries()) {
    const result = toolResults.get(toolCallId);
    if (!result?.text.trim()) continue;
    consumedResultIds.add(toolCallId);
    entries.push({
      toolCallId,
      toolName: call.toolName,
      args: call.args,
      resultText: result.text,
      resultTimestamp: result.timestamp,
      resultIsError: result.isError,
      order: Math.min(call.order, result.order),
    });
  }

  for (const [toolCallId, result] of toolResults.entries()) {
    if (consumedResultIds.has(toolCallId)) continue;
    const resultToolName = result.toolName;
    if (isBackfillableHistoryToolName(resultToolName)) {
      entries.push({
        toolCallId,
        toolName: resultToolName,
        args: {},
        resultText: result.text,
        resultTimestamp: result.timestamp,
        resultIsError: result.isError,
        order: result.order,
      });
      continue;
    }

    const inferredSpawnArgs = inferSessionsSpawnArgsFromResultText(result.text);
    if (inferredSpawnArgs) {
      entries.push({
        toolCallId,
        toolName: 'sessions_spawn',
        args: inferredSpawnArgs,
        resultText: result.text,
        resultTimestamp: result.timestamp,
        resultIsError: result.isError,
        order: result.order,
      });
    }
  }

  return entries.sort((a, b) => a.order - b.order);
};
