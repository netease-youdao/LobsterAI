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

const getGenericRunningStatusText = (): string => {
  const text = i18nService.t('coworkToolRunning');
  return text.endsWith('...') || text.endsWith('…') ? text : `${text}...`;
};

export const getStreamingActivityStatusText = (
  messages: CoworkMessage[],
  isContextMaintenance = false,
): string => {
  if (isContextMaintenance) {
    return i18nService.t('coworkContextMaintenanceRunning');
  }

  const toolResultIds = new Set<string>();
  for (const message of messages) {
    const id = message.metadata?.toolUseId;
    if (message.type === 'tool_result' && typeof id === 'string') {
      toolResultIds.add(id);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== 'tool_use') continue;

    const id = message.metadata?.toolUseId;
    if (typeof id === 'string' && toolResultIds.has(id)) continue;

    const toolName = typeof message.metadata?.toolName === 'string'
      ? message.metadata.toolName.trim()
      : '';
    return toolName
      ? `${i18nService.t('coworkToolRunning')} ${toolName}...`
      : getGenericRunningStatusText();
  }

  return getGenericRunningStatusText();
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

  const ensureTurn = (): ConversationTurn => {
    if (currentTurn) return currentTurn;
    const orphanTurn: ConversationTurn = {
      id: `orphan-${orphanIndex++}`,
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
      const turn = ensureTurn();
      turn.assistantItems.push({ type: 'tool_group', group: item });
      continue;
    }

    const message = item.message;
    if (isContextCompactionMessage(message) && currentTurn?.assistantItems.length) {
      currentTurn = null;
    }
    const turn = ensureTurn();

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
