import { CoworkSystemMessageKind } from '../../../common/coworkSystemMessages';
import type { CoworkMessage, CoworkMessageMetadata } from '../../coworkStore';

export const EmptyResponseHintProtocol = {
  SpawnToolName: 'sessions_spawn',
  AcceptedStatus: 'accepted',
  AnnouncePrefix: 'announce:',
  RunIdSeparator: ':',
  BatchRunIdSeparator: ',',
} as const;

export const EmptyResponseHintMessageType = {
  User: 'user',
  ToolUse: 'tool_use',
  ToolResult: 'tool_result',
  System: 'system',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

const normalizeRunId = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const isRunIdToken = (value: unknown): value is string => (
  typeof value === 'string' && Boolean(value) && !/[\s:,]/.test(value)
);

const findCurrentUserIndex = (messages: readonly CoworkMessage[]): number => (
  messages.findLastIndex(message => message.type === EmptyResponseHintMessageType.User)
);

/** Capture only child executions accepted within the same user request. */
export const buildEmptyResponseHintMetadata = (
  messages: readonly CoworkMessage[],
  runId: string,
): CoworkMessageMetadata => {
  const userIndex = findCurrentUserIndex(messages);
  const childRunIds = new Set<string>();
  const toolNamesByCallId = new Map<string, string>();
  if (userIndex >= 0) {
    for (const message of messages.slice(userIndex + 1)) {
      const metadata = message.metadata;
      const toolUseId = metadata?.toolUseId;
      if (typeof toolUseId !== 'string' || !toolUseId.trim()) continue;
      if (message.type === EmptyResponseHintMessageType.ToolUse) {
        toolNamesByCallId.set(toolUseId, metadata?.toolName?.trim() ?? '');
        continue;
      }
      if (message.type !== EmptyResponseHintMessageType.ToolResult
        || toolNamesByCallId.get(toolUseId) !== EmptyResponseHintProtocol.SpawnToolName
        || metadata?.isError
        || metadata?.error
        || (metadata?.toolName && metadata.toolName !== EmptyResponseHintProtocol.SpawnToolName)) continue;
      try {
        const result: unknown = JSON.parse(message.content);
        if (isRecord(result)
          && result.status === EmptyResponseHintProtocol.AcceptedStatus
          && result.error == null
          && isRunIdToken(result.runId)) {
          childRunIds.add(result.runId);
        }
      } catch {
        // Incomplete or display-only tool results cannot establish ownership.
      }
    }
  }
  return {
    kind: CoworkSystemMessageKind.EmptyResponse,
    runId: normalizeRunId(runId),
    ...(userIndex >= 0 ? { userMessageId: messages[userIndex].id } : {}),
    childRunIds: [...childRunIds],
  };
};

/** A visible reply only recovers a hint whose execution ownership is known. */
export const findRecoveredEmptyResponseHintIds = (
  messages: readonly CoworkMessage[],
  runId: string,
): string[] => {
  const incomingRunId = normalizeRunId(runId);
  const userIndex = findCurrentUserIndex(messages);
  if (!incomingRunId || userIndex < 0) return [];
  const userMessageId = messages[userIndex].id;
  const announceTokens = incomingRunId.startsWith(EmptyResponseHintProtocol.AnnouncePrefix)
    ? new Set(incomingRunId.split(EmptyResponseHintProtocol.RunIdSeparator).slice(1)
      .flatMap(field => field.split(EmptyResponseHintProtocol.BatchRunIdSeparator)))
    : undefined;
  return messages.slice(userIndex + 1).filter(message => {
    const metadata = message.metadata;
    if (message.type !== EmptyResponseHintMessageType.System
      || metadata?.kind !== CoworkSystemMessageKind.EmptyResponse
      || metadata.userMessageId !== userMessageId) return false;
    const hintRunId = normalizeRunId(metadata.runId);
    if (!hintRunId) return false;
    if (incomingRunId === hintRunId) return true;
    return Boolean(announceTokens
      && Array.isArray(metadata.childRunIds)
      && metadata.childRunIds.some(childRunId => (
        isRunIdToken(childRunId) && announceTokens.has(childRunId)
      )));
  }).map(message => message.id);
};
