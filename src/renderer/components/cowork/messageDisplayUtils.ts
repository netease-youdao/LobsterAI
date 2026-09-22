/**
 * Utility functions and types for message display in conversation views.
 * Extracted from CoworkSessionDetail.tsx for reuse by ConversationTurnsView.
 */

import {
  ContextCompactionMode,
  ContextCompactionStatus,
  CoworkSystemMessageKind,
  isInternalCompactionSystemText,
} from '../../../common/coworkSystemMessages';
import { hasToolResultMediaAssets, normalizeFilePathForDedup } from '../../services/artifactParser';
import { i18nService } from '../../services/i18n';
import type { Artifact } from '../../types/artifact';
import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import type { MediaPollingGroup } from './MediaPollingIndicator';

// ── Types ────────────────────────────────────────────────────────────────────

export type TodoStatus = 'completed' | 'in_progress' | 'pending' | 'unknown';

export type ParsedTodoItem = {
  primaryText: string;
  secondaryText: string | null;
  status: TodoStatus;
};

export type ToolGroupItem = {
  type: 'tool_group';
  toolUse: CoworkMessage;
  toolResult?: CoworkMessage | null;
  mediaPollOrdinal?: number;
};

export type DisplayItem =
  | { type: 'message'; message: CoworkMessage }
  | ToolGroupItem;

export type AssistantTurnItem =
  | { type: 'assistant'; message: CoworkMessage }
  | { type: 'system'; message: CoworkMessage }
  | { type: 'tool_group'; group: ToolGroupItem }
  | { type: 'tool_result'; message: CoworkMessage };

export type ConversationTurn = {
  id: string;
  userMessage: CoworkMessage | null;
  assistantItems: AssistantTurnItem[];
};

export const getTurnMessageIds = (turn: ConversationTurn): Set<string> => {
  const messageIds = new Set<string>();
  if (turn.userMessage) {
    messageIds.add(turn.userMessage.id);
  }
  for (const item of turn.assistantItems) {
    if (item.type === 'assistant' || item.type === 'system' || item.type === 'tool_result') {
      messageIds.add(item.message.id);
      continue;
    }
    if (item.type === 'tool_group') {
      messageIds.add(item.group.toolUse.id);
      if (item.group.toolResult) {
        messageIds.add(item.group.toolResult.id);
      }
    }
  }
  return messageIds;
};

// ── Constants ────────────────────────────────────────────────────────────────

export const COWORK_DETAIL_CONTENT_CLASS = 'mx-auto w-full max-w-[760px]';
export const COWORK_DETAIL_GUTTER_CLASS = 'px-6 sm:px-8 lg:px-10';

const TOOL_USE_ERROR_TAG_PATTERN = /^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/i;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
export const MEDIA_TOKEN_DISPLAY_RE = /\n?MEDIA:\s*`?[^`\n]+?`?\s*$/gim;
const SILENT_TOKEN_RE = /^[`*_~"'""''()[\]{}<>.,!?;:，。！？；：\s-]{0,8}NO_REPLY[`*_~"'""''()[\]{}<>.,!?;:，。！？；：\s-]{0,8}$/i;
export const TOOL_RESULT_COLLAPSED_FULL_DISPLAY_MAX_CHARS = 16 * 1024;
export const TOOL_RESULT_COLLAPSED_PREVIEW_MAX_CHARS = 4 * 1024;
export const STRUCTURED_TEXT_FORMAT_MAX_CHARS = 128 * 1024;

export type ToolResultCollapsedDisplay = {
  hasText: boolean;
  text: string;
  lineCount: number;
  isLarge: boolean;
  sizeLabel: string | null;
};

// ── Pure utility functions ───────────────────────────────────────────────────

export const formatUnknown = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const getStringArray = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const lines = value.filter((item) => typeof item === 'string') as string[];
  return lines.length > 0 ? lines.join('\n') : null;
};

export const normalizeToolName = (value: string): string => value.toLowerCase().replace(/[\s_]+/g, '');

export const getToolDisplayName = (toolName: string | undefined): string => {
  if (!toolName) return 'Tool';
  const normalized = normalizeToolName(toolName);
  switch (normalized) {
    case 'cron':
      return 'Cron';
    case 'exec':
    case 'bash':
    case 'shell':
      return 'Bash';
    case 'read':
    case 'readfile':
      return 'Read';
    case 'write':
    case 'writefile':
      return 'Write';
    case 'edit':
    case 'editfile':
      return 'Edit';
    case 'multiedit':
      return 'MultiEdit';
    case 'process':
      return 'Process';
    case 'sessionsspawn':
      return 'Subagent';
    case 'sessionsyield':
      return i18nService.t('coworkToolWaitingSubagents');
    default:
      return toolName;
  }
};

export const isBashLikeToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  const normalized = normalizeToolName(toolName);
  return normalized === 'bash' || normalized === 'exec' || normalized === 'shell';
};

export const getToolInputString = (
  input: Record<string, unknown>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
};

export const truncatePreview = (value: string, maxLength = 120): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

export const normalizeToolResultText = (value: string): string => {
  const withoutAnsi = value.replace(ANSI_ESCAPE_PATTERN, '');
  const errorTagMatch = withoutAnsi.trim().match(TOOL_USE_ERROR_TAG_PATTERN);
  const cleaned = errorTagMatch ? errorTagMatch[1].trim() : withoutAnsi;
  return cleaned.replace(MEDIA_TOKEN_DISPLAY_RE, '').trimEnd();
};

export const isTodoWriteToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'todowrite';
};

export const isCronToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'cron';
};

export const getCronToolSummary = (input: Record<string, unknown>): string | null => {
  const action = getToolInputString(input, ['action']);
  if (!action) return null;

  const job = input.job && typeof input.job === 'object'
    ? input.job as Record<string, unknown>
    : null;
  const jobName = job
    ? getToolInputString(job, ['name', 'id'])
    : null;
  const jobId = getToolInputString(input, ['jobId', 'id'])
    ?? (job ? getToolInputString(job, ['id']) : null);
  const wakeText = getToolInputString(input, ['text']);

  switch (action) {
    case 'add':
      return [action, jobName ?? jobId].filter(Boolean).join(' · ');
    case 'update':
    case 'remove':
    case 'run':
    case 'runs':
      return [action, jobId ?? jobName].filter(Boolean).join(' · ');
    case 'wake':
      return [action, wakeText].filter(Boolean).join(' · ');
    default:
      return action;
  }
};

export const formatStructuredText = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }
  if (trimmed.length > STRUCTURED_TEXT_FORMAT_MAX_CHARS) {
    return value;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
};

export const toTrimmedString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

export const normalizeTodoStatus = (value: unknown): TodoStatus => {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/-/g, '_')
    : '';

  if (normalized === 'completed') return 'completed';
  if (normalized === 'in_progress' || normalized === 'running') return 'in_progress';
  if (normalized === 'pending' || normalized === 'todo') return 'pending';
  return 'unknown';
};

export const parseTodoWriteItems = (input: unknown): ParsedTodoItem[] | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.todos)) return null;

  const parsedItems = record.todos
    .map((rawTodo) => {
      if (!rawTodo || typeof rawTodo !== 'object') {
        return null;
      }

      const todo = rawTodo as Record<string, unknown>;
      const activeForm = toTrimmedString(todo.activeForm);
      const content = toTrimmedString(todo.content);
      const primaryText = activeForm ?? content ?? i18nService.t('coworkTodoUntitled');
      const secondaryText = content && content !== primaryText ? content : null;

      return {
        primaryText,
        secondaryText,
        status: normalizeTodoStatus(todo.status),
      } satisfies ParsedTodoItem;
    })
    .filter((item): item is ParsedTodoItem => item !== null);

  return parsedItems.length > 0 ? parsedItems : null;
};

export const getTodoWriteSummary = (items: ParsedTodoItem[]): string => {
  const completedCount = items.filter((item) => item.status === 'completed').length;
  const inProgressCount = items.filter((item) => item.status === 'in_progress').length;
  const pendingCount = items.length - completedCount - inProgressCount;

  const summary = [
    `${items.length} ${i18nService.t('coworkTodoItems')}`,
    `${completedCount} ${i18nService.t('coworkTodoCompleted')}`,
    `${inProgressCount} ${i18nService.t('coworkTodoInProgress')}`,
    `${pendingCount} ${i18nService.t('coworkTodoPending')}`,
  ];

  const activeItem = items.find((item) => item.status === 'in_progress');
  if (activeItem) {
    summary.push(activeItem.primaryText);
  }

  return summary.join(' · ');
};

export const getToolInputSummary = (
  toolName: string | undefined,
  toolInput?: Record<string, unknown>
): string | null => {
  if (!toolName || !toolInput) return null;
  const input = toolInput as Record<string, unknown>;
  if (isTodoWriteToolName(toolName)) {
    const items = parseTodoWriteItems(input);
    return items ? getTodoWriteSummary(items) : null;
  }

  const normalizedToolName = normalizeToolName(toolName);

  switch (normalizedToolName) {
    case 'cron':
      return getCronToolSummary(input);
    case 'bash':
    case 'exec':
    case 'shell':
      return getToolInputString(input, ['command', 'cmd', 'script'])
        ?? getStringArray(input.commands);
    case 'read':
    case 'readfile':
    case 'write':
    case 'writefile':
    case 'edit':
    case 'editfile':
    case 'multiedit':
      return getToolInputString(input, ['file_path', 'path', 'filePath', 'target_file', 'targetFile'])
        ?? (
          typeof input.content === 'string' && input.content.trim()
            ? truncatePreview(input.content.split('\n')[0].trim())
            : null
        );
    case 'glob':
    case 'grep':
      return getToolInputString(input, ['pattern', 'query']);
    case 'task':
      return getToolInputString(input, ['description', 'task']);
    case 'webfetch':
      return getToolInputString(input, ['url']);
    case 'image':
      return getToolInputString(input, ['path', 'file_path', 'filePath', 'url']);
    case 'browser': {
      const action = getToolInputString(input, ['action']);
      const target = getToolInputString(input, ['url', 'name', 'selector', 'text']);
      return [action, target ? truncatePreview(target, 60) : null].filter(Boolean).join(' · ') || null;
    }
    case 'process': {
      const action = getToolInputString(input, ['action']);
      const sessionId = getToolInputString(input, ['sessionId', 'session_id']);
      if (action && sessionId) return `${action} · ${sessionId}`;
      return action ?? sessionId;
    }
    case 'sessionsspawn': {
      const spawnAgent = getToolInputString(input, ['agentId', 'agent_id']);
      const spawnTask = getToolInputString(input, ['task']);
      return [spawnAgent, spawnTask ? truncatePreview(spawnTask) : null].filter(Boolean).join(' · ');
    }
    default:
      return null;
  }
};

export const formatToolInput = (
  toolName: string | undefined,
  toolInput?: Record<string, unknown>
): string | null => {
  if (!toolInput) return null;
  const summary = getToolInputSummary(toolName, toolInput);
  if (summary && summary.trim()) {
    return summary;
  }
  return formatUnknown(toolInput);
};

export const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const getToolResultRawText = (message: CoworkMessage): string => {
  if (hasText(message.content)) {
    return message.content;
  }
  if (hasText(message.metadata?.toolResult)) {
    return message.metadata?.toolResult ?? '';
  }
  if (hasText(message.metadata?.error)) {
    return message.metadata?.error ?? '';
  }
  return '';
};

export const getToolResultDisplay = (message: CoworkMessage): string => {
  const rawText = getToolResultRawText(message);
  return hasText(rawText)
    ? formatStructuredText(normalizeToolResultText(rawText))
    : '';
};

export const getToolResultLineCount = (result: string): number => {
  if (!result) return 0;
  let lineCount = 1;
  for (let index = 0; index < result.length; index += 1) {
    if (result.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }
  return lineCount;
};

const formatToolResultSize = (charCount: number): string => {
  if (charCount < 1024) {
    return `${charCount} B`;
  }
  if (charCount < 1024 * 1024) {
    return `${Math.ceil(charCount / 1024)} KB`;
  }
  return `${(charCount / (1024 * 1024)).toFixed(1)} MB`;
};

export const getToolResultLineCountSummary = (lineCount: number): string => {
  const unit = i18nService.t(lineCount === 1 ? 'coworkToolOutputLine' : 'coworkToolOutputLines');
  return i18nService.t('coworkToolOutputLineCount')
    .replace('{count}', String(lineCount))
    .replace('{unit}', unit);
};

export const getLargeToolResultSummary = (sizeLabel: string): string =>
  i18nService.t('coworkToolLargeOutput').replace('{size}', sizeLabel);

export const getActivityIndicatorStatusText = (
  isContextMaintenance = false,
  isLongWaiting = false,
  hasContent = false,
): string => {
  if (isContextMaintenance) {
    return i18nService.t('coworkContextMaintenanceRunning');
  }
  if (isLongWaiting) {
    return i18nService.t('coworkModelResponseWaitingLong');
  }
  return i18nService.t(hasContent ? 'coworkProcessing' : 'coworkThinking');
};

/**
 * Phase words shown while the model is silent, rotated by the activity indicator so the
 * status keeps moving instead of sitting on "Thinking" for a minute. The first entry is
 * always the plain thinking label, so the initial render matches getActivityIndicatorStatusText.
 */
export const getThinkingPhaseLabels = (): string[] => {
  const phases = i18nService.t('coworkThinkingPhases')
    .split('|')
    .map(phase => phase.trim())
    .filter(Boolean);
  return phases.length > 0 ? phases : [i18nService.t('coworkThinking')];
};

const isToolGroupSettled = (group: ToolGroupItem): boolean => {
  const meta = group.toolResult?.metadata;
  if (!group.toolResult) return false;
  return !(meta?.isStreaming && !meta?.isFinal);
};

/** Tool steps of this turn that already have a final result; shown next to the live timer. */
export const countTurnCompletedSteps = (turn: ConversationTurn): number => {
  let count = 0;
  for (const item of turn.assistantItems) {
    if (item.type === 'tool_group' && isToolGroupSettled(item.group)) count += 1;
  }
  return count;
};

export const formatElapsedDuration = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
};

export const getToolResultCollapsedDisplay = (message: CoworkMessage): ToolResultCollapsedDisplay => {
  const rawText = getToolResultRawText(message);
  if (!hasText(rawText)) {
    return {
      hasText: false,
      text: '',
      lineCount: 0,
      isLarge: false,
      sizeLabel: null,
    };
  }

  if (rawText.length > TOOL_RESULT_COLLAPSED_FULL_DISPLAY_MAX_CHARS) {
    const previewText = normalizeToolResultText(rawText.slice(0, TOOL_RESULT_COLLAPSED_PREVIEW_MAX_CHARS));
    return {
      hasText: hasText(previewText) || hasText(rawText),
      text: previewText,
      lineCount: 0,
      isLarge: true,
      sizeLabel: formatToolResultSize(rawText.length),
    };
  }

  const displayText = getToolResultDisplay(message);
  return {
    hasText: hasText(displayText),
    text: displayText,
    lineCount: hasText(displayText) ? getToolResultLineCount(displayText) : 0,
    isLarge: false,
    sizeLabel: null,
  };
};

// ── Message classification ───────────────────────────────────────────────────

export const isSilentAssistantMessage = (message: CoworkMessage): boolean => (
  message.type === 'assistant' && SILENT_TOKEN_RE.test(message.content.trim())
);

export const isContextCompactionMessage = (message: CoworkMessage): boolean => (
  message.type === 'system' && message.metadata?.kind === CoworkSystemMessageKind.ContextCompaction
);

export const isForkCompactionSummaryMessage = (message: CoworkMessage): boolean => (
  message.type === 'system' && message.metadata?.kind === CoworkSystemMessageKind.ForkCompactionSummary
);

export const isLegacyInternalCompactionSystemMessage = (message: CoworkMessage): boolean => (
  message.type === 'system'
  && !message.metadata?.kind
  && isInternalCompactionSystemText(message.content)
);

const isRenderableAssistantOrSystemMessage = (message: CoworkMessage): boolean => {
  if (isSilentAssistantMessage(message)) {
    return false;
  }
  if (isLegacyInternalCompactionSystemMessage(message)) {
    return false;
  }
  if (isForkCompactionSummaryMessage(message)) {
    return false;
  }
  if (hasText(message.content) || hasText(message.metadata?.error)) {
    return true;
  }
  if (message.metadata?.isThinking) {
    return true;
  }
  return false;
};

const isVisibleAssistantTurnItem = (item: AssistantTurnItem): boolean => {
  if (item.type === 'assistant' || item.type === 'system') {
    return isRenderableAssistantOrSystemMessage(item.message);
  }
  if (item.type === 'tool_result') {
    return getToolResultCollapsedDisplay(item.message).hasText;
  }
  return true;
};

export const getVisibleAssistantItems = (assistantItems: AssistantTurnItem[]): AssistantTurnItem[] =>
  assistantItems.filter(isVisibleAssistantTurnItem);

export const hasRenderableAssistantContent = (turn: ConversationTurn): boolean => (
  getVisibleAssistantItems(turn.assistantItems).length > 0
);

// True when the turn contains an element that carries its own running
// animation (pulsing pending-tool row, media generation lottie, streaming
// thinking block). The turn-level activity indicator stays hidden for these
// so at most one element animates at a time.
export const turnHasSelfIndicatingActivity = (turn: ConversationTurn): boolean =>
  turn.assistantItems.some(item => {
    if (item.type === 'tool_group') {
      return !item.group.toolResult
        || isMediaGenerateRunning(item.group)
        || isMediaStatusPollRunning(item.group);
    }
    return item.type === 'assistant'
      && Boolean(item.message.metadata?.isThinking)
      && Boolean(item.message.metadata?.isStreaming);
  });

// Earliest message timestamp in the turn — the stable start time for the
// activity indicator's elapsed counter. Falls back across the user message
// and assistant items so orphan turns (e.g. after context compaction) keep
// a stable start across remounts; null when the turn has no timestamps yet.
export const getTurnStartTimestamp = (turn: ConversationTurn): number | null => {
  let earliest: number | null = null;
  const consider = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      earliest = earliest == null ? value : Math.min(earliest, value);
    }
  };
  consider(turn.userMessage?.timestamp);
  for (const item of turn.assistantItems) {
    if (item.type === 'tool_group') {
      consider(item.group.toolUse.timestamp);
      consider(item.group.toolResult?.timestamp);
      continue;
    }
    consider(item.message.timestamp);
  }
  return earliest;
};

// Latest message timestamp in the turn — the end anchor for the completed
// turn's total duration line.
export const getTurnEndTimestamp = (turn: ConversationTurn): number | null => {
  let latest: number | null = null;
  const consider = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      latest = latest == null ? value : Math.max(latest, value);
    }
  };
  consider(turn.userMessage?.timestamp);
  for (const item of turn.assistantItems) {
    if (item.type === 'tool_group') {
      consider(item.group.toolUse.timestamp);
      consider(item.group.toolResult?.timestamp);
      continue;
    }
    consider(item.message.timestamp);
  }
  return latest;
};

// Failed tool steps in a turn. Once the process folds they are no longer
// visible, so the duration line carries the count instead of hiding it.
export const countTurnFailedSteps = (turn: ConversationTurn): number => {
  let failed = 0;
  for (const item of turn.assistantItems) {
    if (item.type !== 'tool_group') continue;
    const metadata = item.group.toolResult?.metadata;
    if (metadata?.isError || metadata?.error) failed += 1;
  }
  return failed;
};

/** Localized duration for the collapsed-process line, e.g. "21分钟 45秒" / "21m 45s". */
export const formatTurnDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return i18nService.t('coworkDurationHours')
      .replace('{hours}', String(hours))
      .replace('{minutes}', String(minutes));
  }
  if (minutes > 0) {
    return i18nService.t('coworkDurationMinutes')
      .replace('{minutes}', String(minutes))
      .replace('{seconds}', String(seconds));
  }
  return i18nService.t('coworkDurationSecondsOnly').replace('{seconds}', String(seconds));
};

// Changes whenever streamed content for the turn grows. The activity
// indicator uses this to tell "output is flowing" (stay hidden) from a quiet
// gap with nothing on screen animating (fade in).
export const getTurnActivityFingerprint = (turn: ConversationTurn): string => {
  let contentLength = 0;
  for (const item of turn.assistantItems) {
    if (item.type === 'tool_group') {
      contentLength += item.group.toolUse.content.length;
      contentLength += item.group.toolResult?.content.length ?? 0;
    } else {
      contentLength += item.message.content.length;
    }
  }
  return `${turn.id}:${turn.assistantItems.length}:${contentLength}`;
};

// ── Build pipeline ───────────────────────────────────────────────────────────

export const buildDisplayItems = (messages: CoworkMessage[]): DisplayItem[] => {
  const items: DisplayItem[] = [];
  const groupsByToolUseId = new Map<string, ToolGroupItem>();
  let pendingAdjacentGroup: ToolGroupItem | null = null;

  for (const message of messages) {
    if (isSilentAssistantMessage(message)) {
      continue;
    }
    if (isLegacyInternalCompactionSystemMessage(message)) {
      continue;
    }

    if (message.type === 'tool_use') {
      const group: ToolGroupItem = { type: 'tool_group', toolUse: message };
      items.push(group);

      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && toolUseId.trim()) {
        groupsByToolUseId.set(toolUseId, group);
      }
      pendingAdjacentGroup = group;
      continue;
    }

    if (message.type === 'tool_result') {
      let matched = false;
      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && groupsByToolUseId.has(toolUseId)) {
        const group = groupsByToolUseId.get(toolUseId);
        if (group) {
          group.toolResult = message;
          matched = true;
        }
      } else if (pendingAdjacentGroup && !pendingAdjacentGroup.toolResult) {
        pendingAdjacentGroup.toolResult = message;
        matched = true;
      }

      pendingAdjacentGroup = null;
      if (!matched) {
        items.push({ type: 'message', message });
      }
      continue;
    }

    pendingAdjacentGroup = null;
    items.push({ type: 'message', message });
  }

  return items;
};

export const buildConversationTurns = (items: DisplayItem[]): ConversationTurn[] => {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;
  let orphanIndex = 0;

  const ensureTurn = (anchorMessageId?: string): ConversationTurn => {
    if (currentTurn) return currentTurn;
    const orphanTurn: ConversationTurn = {
      id: anchorMessageId ? `orphan-${anchorMessageId}` : `orphan-${orphanIndex++}`,
      userMessage: null,
      assistantItems: [],
    };
    turns.push(orphanTurn);
    currentTurn = orphanTurn;
    return orphanTurn;
  };

  for (const item of items) {
    if (item.type === 'message' && item.message.type === 'user') {
      currentTurn = {
        id: item.message.id,
        userMessage: item.message,
        assistantItems: [],
      };
      turns.push(currentTurn);
      continue;
    }

    if (item.type === 'tool_group') {
      const turn = ensureTurn(item.toolUse.id);
      turn.assistantItems.push({ type: 'tool_group', group: item });
      continue;
    }

    const message = item.message;
    if (isContextCompactionMessage(message) && currentTurn?.assistantItems.length) {
      currentTurn = null;
    }
    const turn = ensureTurn(message.id);

    if (message.type === 'assistant') {
      turn.assistantItems.push({ type: 'assistant', message });
      continue;
    }

    if (message.type === 'system') {
      turn.assistantItems.push({ type: 'system', message });
      continue;
    }

    if (message.type === 'tool_result') {
      turn.assistantItems.push({ type: 'tool_result', message });
      continue;
    }

    if (message.type === 'tool_use') {
      turn.assistantItems.push({
        type: 'tool_group',
        group: {
          type: 'tool_group',
          toolUse: message,
        },
      });
    }
  }

  return turns;
};

// ── Metadata helpers ─────────────────────────────────────────────────────────

export const getMessageModelLabel = (metadata?: CoworkMessageMetadata | null): string | null => {
  const model = typeof metadata?.model === 'string' ? metadata.model.trim() : '';
  if (!model) return null;
  return model.includes('/') ? (model.split('/').pop() || model) : model;
};

export const messageMetaClassName = (visible: boolean, align: 'left' | 'right' = 'left'): string => [
  'flex items-center gap-2 mt-1 text-[11px] text-zinc-400 dark:text-zinc-500 select-none transition-opacity duration-200',
  align === 'right' ? 'justify-end' : '',
  visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
].filter(Boolean).join(' ');

// ── Context compaction helpers ───────────────────────────────────────────────

export const getContextCompactionMessageLabel = (message: CoworkMessage, fallbackContent: string): string => {
  if (message.metadata?.mode === ContextCompactionMode.Manual && fallbackContent.trim()) {
    return fallbackContent;
  }

  switch (message.metadata?.status) {
    case ContextCompactionStatus.Running:
      return i18nService.t('coworkContextCompactionRunning');
    case ContextCompactionStatus.Retrying:
      return i18nService.t('coworkContextCompactionRetrying');
    case ContextCompactionStatus.Failed:
      return i18nService.t('coworkContextCompactionFailed');
    case ContextCompactionStatus.Completed:
      return i18nService.t('coworkContextCompactionCompleted');
    default:
      return fallbackContent.trim()
        ? fallbackContent
        : i18nService.t('coworkContextCompactionCompleted');
  }
};

// ── Media generation utilities ──────────────────────────────────────────────

const MEDIA_TOKEN_MARKER_RE = /(^|\n)\s*MEDIA(?::\s*`?[^`\n]+?`?)?\s*$/im;
const PARTIAL_MEDIA_TOKEN_MARKER_RE = /(^|\n)\s*(?:M|ME|MED|MEDI|MEDIA)(?::\s*`?[^`\n]+?`?)?\s*$/im;
const MEDIA_FILE_LINK_DISPLAY_RE = /\[([^\]]+)\]\((file:\/\/[^)]*\.(?:png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov)(?:\?[^)]*)?)\)/gi;
const LOCAL_VIDEO_PATH_DISPLAY_RE = /(?:^|[\s"'`(：:])((?:\/|[A-Za-z]:\/)[^\n"'`()\[\]]+\.(?:mp4|webm|mov))(?:[\s"'`)]|$)/gi;
const SAVED_GENERATED_MEDIA_RE = /^Saved generated (?:video|image)s?:/i;
const GENERATED_MEDIA_SUCCEEDED_RE = /^(?:Video|Image) generation succeeded\./i;
const GENERATED_VIDEO_TEXT_RE = /(?:视频(?:已生成|生成完成)|video\s+(?:generated|generation\s+succeeded|generation\s+complete))/i;
const TERMINAL_MEDIA_STATUSES = new Set(['succeeded', 'failed', 'timeout', 'cancelled']);

export type MediaStreamingInfo = {
  taskId?: string;
  upstreamTaskId?: string;
  pollCount?: number;
};

export type ConsolidatedItem = AssistantTurnItem | { type: 'media_polling_group'; group: MediaPollingGroup };

const stripMediaDisplayTokens = (value: string): string =>
  value.replace(MEDIA_TOKEN_DISPLAY_RE, '').trimEnd();

const getDisplayPathFromFileUrl = (url: string): string => {
  let filePath = url.trim();
  if (filePath.startsWith('file:///')) {
    filePath = filePath.slice(7);
  } else if (filePath.startsWith('file://')) {
    filePath = filePath.slice(7);
  } else if (filePath.startsWith('file:/')) {
    filePath = filePath.slice(5);
  }
  const queryIndex = filePath.search(/[?#]/);
  if (queryIndex >= 0) {
    filePath = filePath.slice(0, queryIndex);
  }
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // keep original
  }
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  return filePath.replace(/\\/g, '/');
};

const stripMediaFileLinksForDisplay = (value: string): string =>
  value
    .replace(MEDIA_FILE_LINK_DISPLAY_RE, (_match, _label: string, url: string) => getDisplayPathFromFileUrl(url))
    .replace(/([:：])\s*\n\s*((?:\/|[A-Za-z]:\/)[^\n]+\.(?:png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov))/gi, '$1 $2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

export const getAssistantMessageDisplayText = (content: string): string =>
  stripMediaDisplayTokens(stripMediaFileLinksForDisplay(content));

const extractLocalVideoPathsFromText = (content: string): string[] => {
  const paths: string[] = [];
  const fileLinkRe = new RegExp(MEDIA_FILE_LINK_DISPLAY_RE.source, 'gi');
  let fileLinkMatch: RegExpExecArray | null;
  while ((fileLinkMatch = fileLinkRe.exec(content)) !== null) {
    const url = fileLinkMatch[2];
    if (/\.(?:mp4|webm|mov)(?:\?[^)]*)?$/i.test(url)) {
      paths.push(getDisplayPathFromFileUrl(url));
    }
  }
  const barePathRe = new RegExp(LOCAL_VIDEO_PATH_DISPLAY_RE.source, 'gi');
  let barePathMatch: RegExpExecArray | null;
  while ((barePathMatch = barePathRe.exec(content)) !== null) {
    paths.push(getDisplayPathFromFileUrl(barePathMatch[1]));
  }
  return [...new Set(paths.filter(Boolean))];
};

export const getVideoPathArtifacts = (artifacts: Artifact[] | undefined): Artifact[] => {
  if (!artifacts?.length) return [];
  const result: Artifact[] = [];
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'video' || !artifact.filePath) continue;
    const key = normalizeFilePathForDedup(artifact.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(artifact);
  }
  return result;
};

export const isDuplicateGeneratedVideoAssistantMessage = (
  message: CoworkMessage,
  videoArtifacts: Artifact[],
): boolean => {
  if (videoArtifacts.length === 0) return false;
  const rawContent = message.content || '';
  const textPaths = extractLocalVideoPathsFromText(rawContent);
  if (textPaths.length === 0) return false;

  const artifactPaths = new Set(
    videoArtifacts
      .map(artifact => artifact.filePath)
      .filter((filePath): filePath is string => Boolean(filePath))
      .map(filePath => normalizeFilePathForDedup(filePath)),
  );
  const referencesGeneratedVideo = textPaths.some(filePath => artifactPaths.has(normalizeFilePathForDedup(filePath)));
  if (!referencesGeneratedVideo) return false;

  return GENERATED_VIDEO_TEXT_RE.test(rawContent)
    || MEDIA_TOKEN_MARKER_RE.test(rawContent)
    || PARTIAL_MEDIA_TOKEN_MARKER_RE.test(rawContent);
};

export const getMediaCompletionDisplayText = (
  message: CoworkMessage,
  content: string,
): string | null => {
  if (!hasToolResultMediaAssets(message)) return null;
  const trimmed = content.trim();
  const details = message.metadata?.toolResultDetails as Record<string, unknown> | undefined;
  const status = typeof details?.status === 'string' ? details.status.trim().toLowerCase() : '';
  if (
    !SAVED_GENERATED_MEDIA_RE.test(trimmed) &&
    !GENERATED_MEDIA_SUCCEEDED_RE.test(trimmed) &&
    status !== 'succeeded'
  ) {
    return null;
  }
  return i18nService.t('mediaGenerationComplete');
};

export const isMediaStatusPoll = (group: ToolGroupItem): boolean => {
  const toolName = group.toolUse.metadata?.toolName;
  if (!toolName) return false;
  const normalized = normalizeToolName(toolName);
  if (normalized !== 'lobsteraivideogenerate' && normalized !== 'lobsteraiimagegenerate') return false;
  const input = group.toolUse.metadata?.toolInput as Record<string, unknown> | undefined;
  return input?.action === 'status' && typeof input?.taskId === 'string';
};

const getMediaStatusDetails = (group: ToolGroupItem): Record<string, unknown> | undefined => {
  const liveDetails = group.toolUse.metadata?.mediaStatusDetails as Record<string, unknown> | undefined;
  const resultDetails = group.toolResult?.metadata?.toolResultDetails as Record<string, unknown> | undefined;
  if (!liveDetails) return resultDetails;
  if (!resultDetails) return liveDetails;
  const livePollCount = typeof liveDetails.pollCount === 'number' ? liveDetails.pollCount : undefined;
  const resultPollCount = typeof resultDetails.pollCount === 'number' ? resultDetails.pollCount : undefined;
  const pollCount = livePollCount == null
    ? resultPollCount
    : resultPollCount == null
      ? livePollCount
      : Math.max(livePollCount, resultPollCount);
  return {
    ...liveDetails,
    ...resultDetails,
    ...(pollCount != null ? { pollCount } : {}),
  };
};

const readMediaPollCount = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
);

export const getDisplayMediaPollCount = (value: number | undefined): number | undefined => (
  value != null && value > 1 ? value : undefined
);

const getMediaStatusDetailPollCount = (group: ToolGroupItem): number | undefined => {
  const details = getMediaStatusDetails(group);
  return readMediaPollCount(details?.pollCount);
};

const getMediaPollCount = (group: ToolGroupItem): number | undefined => {
  const detailPollCount = getMediaStatusDetailPollCount(group);
  if (detailPollCount == null) return group.mediaPollOrdinal;
  if (group.mediaPollOrdinal == null) return detailPollCount;
  return Math.max(detailPollCount, group.mediaPollOrdinal);
};

export const isMediaGenerateRunning = (group: ToolGroupItem): boolean => {
  const toolName = group.toolUse.metadata?.toolName;
  if (!toolName) return false;
  const normalized = normalizeToolName(toolName);
  if (normalized !== 'lobsteraivideogenerate') return false;
  const input = group.toolUse.metadata?.toolInput as Record<string, unknown> | undefined;
  const action = input?.action;
  if (action !== 'generate' && action !== undefined) return false;
  if (!group.toolResult) return true;
  const meta = group.toolResult.metadata;
  if (meta?.isStreaming && !meta?.isFinal) return true;
  return false;
};

export const isMediaStatusPollRunning = (group: ToolGroupItem): boolean => {
  if (!isMediaStatusPoll(group)) return false;
  if (!group.toolResult) return true;
  const meta = group.toolResult.metadata;
  if (meta?.isStreaming && !meta?.isFinal) return true;
  return false;
};

const getMediaTaskIdKeys = (info: Pick<MediaStreamingInfo, 'taskId' | 'upstreamTaskId'>): string[] => {
  const keys = [info.taskId, info.upstreamTaskId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim());
  return [...new Set(keys)];
};

const setRetainedMediaPollCount = (
  counts: Map<string, number>,
  info: Pick<MediaStreamingInfo, 'taskId' | 'upstreamTaskId'>,
  pollCount: number | undefined,
): void => {
  const displayPollCount = getDisplayMediaPollCount(pollCount);
  if (displayPollCount == null) return;
  for (const key of getMediaTaskIdKeys(info)) {
    counts.set(key, Math.max(counts.get(key) ?? 0, displayPollCount));
  }
};

export const getRetainedMediaPollCount = (
  info: Pick<MediaStreamingInfo, 'taskId' | 'upstreamTaskId'>,
  retainedCounts?: Map<string, number>,
): number | undefined => {
  if (!retainedCounts) return undefined;
  let pollCount: number | undefined;
  for (const key of getMediaTaskIdKeys(info)) {
    const retained = retainedCounts.get(key);
    if (retained != null) {
      pollCount = Math.max(pollCount ?? 0, retained);
    }
  }
  return getDisplayMediaPollCount(pollCount);
};

export const parseMediaStreamingInfo = (group: ToolGroupItem): MediaStreamingInfo => {
  const input = group.toolUse.metadata?.toolInput as Record<string, unknown> | undefined;
  const inputTaskId = typeof input?.taskId === 'string' && input.taskId.trim()
    ? input.taskId.trim()
    : undefined;
  const statusFallbackPollCount = input?.action === 'status' ? group.mediaPollOrdinal : undefined;
  const details = getMediaStatusDetails(group);
  const pollCount = getDisplayMediaPollCount(getMediaPollCount(group) ?? statusFallbackPollCount);
  if (details?.taskId || inputTaskId) {
    return {
      taskId: details?.taskId ? String(details.taskId) : inputTaskId,
      upstreamTaskId: details?.upstreamTaskId ? String(details.upstreamTaskId) : undefined,
      ...(pollCount != null ? { pollCount } : {}),
    };
  }
  if (!group.toolResult) {
    return inputTaskId
      ? { taskId: inputTaskId, ...(pollCount != null ? { pollCount } : {}) }
      : {};
  }
  return {};
};

export const collectMediaPollCounts = (items: ConsolidatedItem[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.type === 'media_polling_group') {
      setRetainedMediaPollCount(
        counts,
        { taskId: item.group.taskId, upstreamTaskId: item.group.upstreamTaskId },
        item.group.pollCount,
      );
      continue;
    }
    if (item.type !== 'tool_group') continue;
    const info = parseMediaStreamingInfo(item.group);
    setRetainedMediaPollCount(counts, info, info.pollCount);
  }
  return counts;
};

const extractMediaPollStatus = (poll: ToolGroupItem): string | null => {
  const details = getMediaStatusDetails(poll);
  if (typeof details?.status === 'string' && details.status.trim()) {
    return details.status.trim();
  }
  const result = poll.toolResult;
  if (!result) return null;
  const text = result.content || (result.metadata?.toolResult as string) || '';
  const match = text.match(/^Status:\s*(\S+)/m);
  return match ? match[1] : null;
};

const extractUpstreamTaskId = (poll: ToolGroupItem): string | undefined => {
  const details = getMediaStatusDetails(poll);
  return details?.upstreamTaskId ? String(details.upstreamTaskId) : undefined;
};

const extractMediaPollCount = (poll: ToolGroupItem): number | undefined => {
  return getMediaPollCount(poll);
};

export const consolidateMediaPolling = (items: AssistantTurnItem[]): ConsolidatedItem[] => {
  const pollsByTaskId = new Map<string, { toolName: string; indices: number[] }>();
  const mediaPollOrdinals = new Map<number, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'tool_group' && isMediaStatusPoll(item.group)) {
      const toolName = item.group.toolUse.metadata!.toolName!;
      const input = item.group.toolUse.metadata!.toolInput as Record<string, string>;
      const taskId = input.taskId;
      const entry = pollsByTaskId.get(taskId);
      if (entry) {
        entry.indices.push(i);
      } else {
        pollsByTaskId.set(taskId, { toolName, indices: [i] });
      }
    }
  }

  for (const { indices } of pollsByTaskId.values()) {
    let cumulativePollCount = 0;
    for (const itemIndex of indices) {
      const group = (items[itemIndex] as { type: 'tool_group'; group: ToolGroupItem }).group;
      const detailPollCount = getMediaStatusDetailPollCount(group);
      const nextPollCount = detailPollCount == null
        ? cumulativePollCount + 1
        : detailPollCount > cumulativePollCount
          ? detailPollCount
          : cumulativePollCount + detailPollCount;
      cumulativePollCount = Math.max(cumulativePollCount, nextPollCount);
      mediaPollOrdinals.set(itemIndex, cumulativePollCount);
    }
  }

  const skipIndices = new Set<number>();
  const insertAfterIndex = new Map<number, MediaPollingGroup>();

  for (const [taskId, { toolName, indices }] of pollsByTaskId) {
    if (indices.length < 2) continue;
    const consolidatedPolls: ToolGroupItem[] = [];
    for (let k = 1; k < indices.length; k++) {
      skipIndices.add(indices[k]);
      const group = (items[indices[k]] as { type: 'tool_group'; group: ToolGroupItem }).group;
      consolidatedPolls.push({
        ...group,
        mediaPollOrdinal: mediaPollOrdinals.get(indices[k]),
      });
    }
    const lastPoll = consolidatedPolls[consolidatedPolls.length - 1];
    const lastStatus = extractMediaPollStatus(lastPoll);
    let isComplete = lastStatus != null && TERMINAL_MEDIA_STATUSES.has(lastStatus);

    if (!isComplete) {
      const completionPattern = new RegExp(
        `Task ID: ${taskId}[\\s\\S]*?generation (succeeded|failed|timed out|cancelled)`
        + `|generation (succeeded|failed|timed out|cancelled)[\\s\\S]*?Task ID: ${taskId}`,
        'i',
      );
      for (const item of items) {
        if (item.type === 'system' || item.type === 'tool_result') {
          if (completionPattern.test(item.message.content)) {
            isComplete = true;
            break;
          }
          const details = item.message.metadata?.toolResultDetails as Record<string, unknown> | undefined;
          if (details?.status && TERMINAL_MEDIA_STATUSES.has(details.status as string)) {
            isComplete = true;
            break;
          }
          if (/^Saved generated (video|image)s?:/m.test(item.message.content)) {
            isComplete = true;
            break;
          }
        }
      }
    }
    const lastIndex = indices[indices.length - 1];
    insertAfterIndex.set(lastIndex, {
      type: 'media_polling_group',
      toolName,
      taskId,
      upstreamTaskId: extractUpstreamTaskId(lastPoll),
      lastStatus,
      pollCount: extractMediaPollCount(lastPoll) ?? indices.length,
      polls: consolidatedPolls,
      isComplete,
    });
  }

  const result: ConsolidatedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!skipIndices.has(i)) {
      const item = items[i];
      const mediaPollOrdinal = mediaPollOrdinals.get(i);
      if (item.type === 'tool_group' && mediaPollOrdinal != null) {
        result.push({
          ...item,
          group: { ...item.group, mediaPollOrdinal },
        });
      } else {
        result.push(item);
      }
    }
    const group = insertAfterIndex.get(i);
    if (group) {
      result.push({ type: 'media_polling_group', group });
    }
  }

  return result;
};

// ── Activity grouping (collapsed consecutive tool/thinking steps) ────────────

export type ActivityChunkEntry = { item: ConsolidatedItem; index: number };

export type ConsolidatedRenderChunk =
  | { kind: 'item'; item: ConsolidatedItem; index: number }
  | { kind: 'activity_group'; entries: ActivityChunkEntry[] };

/**
 * Every run of consecutive work items collapses, even a run of one, so
 * assistant turns read as summary lines interleaved with text (Claude
 * Code app style) instead of mixing collapsed groups with raw tool rows.
 */
export const ACTIVITY_GROUP_MIN_ITEMS = 1;

/**
 * Work items that read as intermediate agent activity rather than answer
 * content: tool calls, orphan tool results, and thinking. Media polling
 * groups stay standalone — their indicator carries live progress and a
 * cancel action that must not disappear behind a collapsed header.
 */
export const isActivityConsolidatedItem = (item: ConsolidatedItem): boolean => {
  if (item.type === 'tool_group' || item.type === 'tool_result') {
    return true;
  }
  return item.type === 'assistant' && item.message.metadata?.isThinking === true;
};

export const chunkConsolidatedItemsForDisplay = (
  items: ConsolidatedItem[],
  isGroupable: (item: ConsolidatedItem, index: number) => boolean = isActivityConsolidatedItem,
): ConsolidatedRenderChunk[] => {
  const chunks: ConsolidatedRenderChunk[] = [];
  let pending: ActivityChunkEntry[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    if (pending.length >= ACTIVITY_GROUP_MIN_ITEMS) {
      chunks.push({ kind: 'activity_group', entries: pending });
    } else {
      for (const entry of pending) {
        chunks.push({ kind: 'item', item: entry.item, index: entry.index });
      }
    }
    pending = [];
  };

  items.forEach((item, index) => {
    if (isGroupable(item, index)) {
      pending.push({ item, index });
      return;
    }
    flushPending();
    chunks.push({ kind: 'item', item, index });
  });
  flushPending();
  return chunks;
};

/**
 * Where the turn's final answer begins: the trailing run of plain assistant
 * text (and system notices) at the end of the chunk list. Everything before
 * it is intermediate process that folds away once the turn completes.
 */
export const getTurnAnswerStartIndex = (chunks: ConsolidatedRenderChunk[]): number => {
  let index = chunks.length;
  while (index > 0) {
    const chunk = chunks[index - 1];
    if (chunk.kind !== 'item') break;
    const item = chunk.item;
    const isAnswerItem = item.type === 'system'
      || (item.type === 'assistant' && item.message.metadata?.isThinking !== true);
    if (!isAnswerItem) break;
    index -= 1;
  }
  return index;
};

/**
 * Whether a non-streaming turn's process may fold behind the duration line.
 * Folding requires both a process to hide and a visible trailing answer —
 * a turn that still ends with work items (e.g. waiting for subagents to
 * hand control back, or the gap before the parent run resumes afterwards)
 * has produced no result yet, and folding it would leave only an empty
 * duration line that reads as a failure.
 */
export const canFoldTurnProcess = (
  chunks: ConsolidatedRenderChunk[],
  answerStartIndex: number,
): boolean => answerStartIndex > 0 && answerStartIndex < chunks.length;

export type ActivityGroupSummary = {
  stepCount: number;
};

const getActivityItemStepCount = (item: ConsolidatedItem): number => {
  if (item.type === 'media_polling_group') {
    return Math.max(1, item.group.polls.length);
  }
  return 1;
};

export const getActivityGroupSummary = (items: ConsolidatedItem[]): ActivityGroupSummary => {
  let stepCount = 0;
  for (const item of items) {
    stepCount += getActivityItemStepCount(item);
  }
  return { stepCount };
};

const READ_TOOL_NAMES = new Set(['read', 'readfile']);
const WRITE_TOOL_NAMES = new Set(['write', 'writefile']);
const EDIT_ONLY_TOOL_NAMES = new Set(['edit', 'editfile', 'multiedit']);
const EDIT_TOOL_NAMES = new Set([...WRITE_TOOL_NAMES, ...EDIT_ONLY_TOOL_NAMES]);

const getFileBasename = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
};

type ActivityCategoryCounts = {
  commands: number;
  reads: number;
  edits: number;
  tools: number;
  thinking: number;
};

const countActivityCategories = (items: ConsolidatedItem[]): ActivityCategoryCounts => {
  const counts: ActivityCategoryCounts = { commands: 0, reads: 0, edits: 0, tools: 0, thinking: 0 };
  for (const item of items) {
    if (item.type === 'tool_group') {
      const rawName = item.group.toolUse.metadata?.toolName;
      const normalized = typeof rawName === 'string' ? normalizeToolName(rawName) : '';
      if (isBashLikeToolName(typeof rawName === 'string' ? rawName : undefined)) {
        counts.commands += 1;
      } else if (READ_TOOL_NAMES.has(normalized)) {
        counts.reads += 1;
      } else if (EDIT_TOOL_NAMES.has(normalized)) {
        counts.edits += 1;
      } else {
        counts.tools += 1;
      }
      continue;
    }
    if (item.type === 'media_polling_group') {
      counts.tools += Math.max(1, item.group.polls.length);
      continue;
    }
    if (item.type === 'tool_result') {
      counts.tools += 1;
      continue;
    }
    counts.thinking += 1;
  }
  return counts;
};

/**
 * Natural-language summary for a collapsed activity group, e.g.
 * "运行了 3 个命令、读取了 2 个文件" / "Ran 3 commands, read 2 files".
 * A single-step group shows the concrete action ("Read App.tsx") instead.
 */
export const getActivityGroupHeaderLabel = (items: ConsolidatedItem[]): string => {
  if (items.length === 1 && items[0].type !== 'assistant') {
    const step = getActivityStepDisplay(items[0]);
    return step.summary ? `${step.name} ${step.summary}` : step.name;
  }
  const counts = countActivityCategories(items);
  const segment = (count: number, oneKey: string, manyKey: string): string =>
    i18nService.t(count === 1 ? oneKey : manyKey).replace('{count}', String(count));

  const segments: string[] = [];
  if (counts.commands > 0) {
    segments.push(segment(counts.commands, 'coworkActivitySegmentCommand', 'coworkActivitySegmentCommands'));
  }
  if (counts.reads > 0) {
    segments.push(segment(counts.reads, 'coworkActivitySegmentFileRead', 'coworkActivitySegmentFilesRead'));
  }
  if (counts.edits > 0) {
    segments.push(segment(counts.edits, 'coworkActivitySegmentEdit', 'coworkActivitySegmentEdits'));
  }
  if (counts.tools > 0) {
    segments.push(segment(counts.tools, 'coworkActivitySegmentTool', 'coworkActivitySegmentTools'));
  }
  if (segments.length === 0) {
    return i18nService.t('coworkActivityThoughtProcess');
  }
  const joined = segments.join(i18nService.t('coworkActivitySegmentSeparator'));
  return joined.charAt(0).toUpperCase() + joined.slice(1);
};

export type ActivityStepDisplay = { name: string; summary: string | null };

/** Compact one-line row label for a tool step; file tools show just the basename. */
export const getToolStepDisplay = (
  rawToolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): ActivityStepDisplay => {
  const name = getToolDisplayName(rawToolName);
  let summary = getToolInputSummary(rawToolName, toolInput);
  if (summary) {
    const normalized = rawToolName ? normalizeToolName(rawToolName) : '';
    if (READ_TOOL_NAMES.has(normalized) || EDIT_TOOL_NAMES.has(normalized)) {
      summary = getFileBasename(summary);
    }
    summary = truncatePreview(summary.split('\n')[0].trim(), 96);
  }
  return { name, summary: summary ?? null };
};

export const getActivityStepDisplay = (item: ConsolidatedItem): ActivityStepDisplay => {
  if (item.type === 'tool_group') {
    const rawName = item.group.toolUse.metadata?.toolName;
    return getToolStepDisplay(
      typeof rawName === 'string' ? rawName : undefined,
      item.group.toolUse.metadata?.toolInput,
    );
  }
  if (item.type === 'media_polling_group') {
    return { name: getToolDisplayName(item.group.toolName), summary: null };
  }
  if (item.type === 'tool_result') {
    return { name: i18nService.t('coworkToolResult'), summary: null };
  }
  return { name: i18nService.t('reasoning'), summary: null };
};

/**
 * Live header text while the current step is still running: a verb phrase
 * mirroring the Claude Code app ("Editing Settings.tsx", "正在运行 npm test").
 */
export const getActivityCurrentActionText = (item: ConsolidatedItem): string => {
  if (item.type === 'assistant') {
    return i18nService.t('coworkActivityThinkingNow');
  }
  const mediaToolName = item.type === 'media_polling_group'
    ? item.group.toolName
    : item.type === 'tool_group' && isMediaStatusPoll(item.group)
      ? item.group.toolUse.metadata?.toolName
      : null;
  if (typeof mediaToolName === 'string') {
    const isVideo = normalizeToolName(mediaToolName) === 'lobsteraivideogenerate';
    return i18nService.t(isVideo ? 'mediaGeneratingVideo' : 'mediaGeneratingImage');
  }
  if (item.type === 'tool_group') {
    const rawName = item.group.toolUse.metadata?.toolName;
    const toolName = typeof rawName === 'string' ? rawName : undefined;
    const normalized = toolName ? normalizeToolName(toolName) : '';
    if (normalized === 'sessionsyield') {
      return i18nService.t('coworkActivityLiveWaitSubagents');
    }
    if (normalized === 'sessionsspawn') {
      return i18nService.t('coworkActivityLiveSpawnSubagent');
    }
    const { summary } = getToolStepDisplay(toolName, item.group.toolUse.metadata?.toolInput);
    const verb = (templateKey: string, genericKey: string): string => (
      summary
        ? i18nService.t(templateKey).replace('{target}', summary)
        : i18nService.t(genericKey)
    );
    if (isBashLikeToolName(toolName)) {
      return verb('coworkActivityLiveCommand', 'coworkActivityLiveCommandGeneric');
    }
    if (READ_TOOL_NAMES.has(normalized)) {
      return verb('coworkActivityLiveRead', 'coworkActivityLiveReadGeneric');
    }
    if (WRITE_TOOL_NAMES.has(normalized)) {
      return verb('coworkActivityLiveWrite', 'coworkActivityLiveWriteGeneric');
    }
    if (EDIT_ONLY_TOOL_NAMES.has(normalized)) {
      return verb('coworkActivityLiveEdit', 'coworkActivityLiveEditGeneric');
    }
    return i18nService.t('coworkActivityLiveTool').replace('{target}', getToolDisplayName(toolName));
  }
  const { name, summary } = getActivityStepDisplay(item);
  return summary ? `${name} ${summary}` : name;
};
