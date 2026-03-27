import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage, CoworkMessageMetadata, CoworkImageAttachment } from '../../types/cowork';
import type { Skill } from '../../types/skill';
import CoworkPromptInput from './CoworkPromptInput';
import MarkdownContent from '../MarkdownContent';
import {
  CheckIcon,
  InformationCircleIcon,
  ShareIcon,
  ExclamationTriangleIcon,
  ChevronRightIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline';
import { FolderIcon } from '@heroicons/react/24/solid';
import { coworkService } from '../../services/cowork';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import LazyRenderTurn, { clearHeightCache } from './LazyRenderTurn';
import PuzzleIcon from '../icons/PuzzleIcon';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import PencilSquareIcon from '../icons/PencilSquareIcon';
import TrashIcon from '../icons/TrashIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { getCompactFolderName } from '../../utils/path';
import { getScheduledReminderDisplayText } from '../../../scheduled-task/reminderText';

interface CoworkSessionDetailProps {
  onManageSkills?: () => void;
  onContinue: (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  onNavigateHome?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const AUTO_SCROLL_THRESHOLD = 120;
const NAV_HIDE_DELAY = 3000;
const NAV_SCROLL_LOCK_DURATION = 500;
const NAV_BOTTOM_SNAP_THRESHOLD = 20;
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;

const sanitizeExportFileName = (value: string): string => {
  const sanitized = value.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'cowork-session';
};

const formatExportTimestamp = (value: Date): string => {
  const pad = (num: number): string => String(num).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
};

type CaptureRect = { x: number; y: number; width: number; height: number };

const MAX_EXPORT_CANVAS_HEIGHT = 32760;
const MAX_EXPORT_SEGMENTS = 240;

const waitForNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

const loadImageFromBase64 = (pngBase64: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured image'));
    img.src = `data:image/png;base64,${pngBase64}`;
  });

const domRectToCaptureRect = (rect: DOMRect): CaptureRect => ({
  x: Math.max(0, Math.round(rect.x)),
  y: Math.max(0, Math.round(rect.y)),
  width: Math.max(0, Math.round(rect.width)),
  height: Math.max(0, Math.round(rect.height)),
});

// PushPinIcon component for pin/unpin functionality
const PushPinIcon: React.FC<React.SVGProps<SVGSVGElement> & { slashed?: boolean }> = ({
  slashed,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="rotate(45 12 12)">
      <path d="M9 3h6l-1 5 2 2v2H8v-2l2-2-1-5z" />
      <path d="M12 12v9" />
    </g>
    {slashed && <path d="M5 5L19 19" />}
  </svg>
);

const formatUnknown = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getStringArray = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const lines = value.filter((item) => typeof item === 'string') as string[];
  return lines.length > 0 ? lines.join('\n') : null;
};

type TodoStatus = 'completed' | 'in_progress' | 'pending' | 'unknown';

type ParsedTodoItem = {
  primaryText: string;
  secondaryText: string | null;
  status: TodoStatus;
};

const normalizeToolName = (value: string): string => value.toLowerCase().replace(/[\s_]+/g, '');

const TOOL_USE_ERROR_TAG_PATTERN = /^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/i;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

const getToolDisplayName = (toolName: string | undefined): string => {
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
    default:
      return toolName;
  }
};

const isBashLikeToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  const normalized = normalizeToolName(toolName);
  return normalized === 'bash' || normalized === 'exec' || normalized === 'shell';
};

const getToolInputString = (
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

const truncatePreview = (value: string, maxLength = 120): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const normalizeToolResultText = (value: string): string => {
  const withoutAnsi = value.replace(ANSI_ESCAPE_PATTERN, '');
  const errorTagMatch = withoutAnsi.trim().match(TOOL_USE_ERROR_TAG_PATTERN);
  return errorTagMatch ? errorTagMatch[1].trim() : withoutAnsi;
};

const isTodoWriteToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'todowrite';
};

const isCronToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'cron';
};

const getCronToolSummary = (input: Record<string, unknown>): string | null => {
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

const formatStructuredText = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
};

const toTrimmedString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const normalizeTodoStatus = (value: unknown): TodoStatus => {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/-/g, '_')
    : '';

  if (normalized === 'completed') return 'completed';
  if (normalized === 'in_progress' || normalized === 'running') return 'in_progress';
  if (normalized === 'pending' || normalized === 'todo') return 'pending';
  return 'unknown';
};

const parseTodoWriteItems = (input: unknown): ParsedTodoItem[] | null => {
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

const getTodoWriteSummary = (items: ParsedTodoItem[]): string => {
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

const getToolInputSummary = (
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
    default:
      return null;
  }
};

const formatToolInput = (
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

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const getToolResultDisplay = (message: CoworkMessage): string => {
  if (hasText(message.content)) {
    return formatStructuredText(normalizeToolResultText(message.content));
  }
  if (hasText(message.metadata?.toolResult)) {
    return formatStructuredText(normalizeToolResultText(message.metadata?.toolResult ?? ''));
  }
  if (hasText(message.metadata?.error)) {
    return formatStructuredText(normalizeToolResultText(message.metadata?.error ?? ''));
  }
  return '';
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

const stripFileProtocol = (value: string): string => {
  let cleaned = value.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
};

const hasScheme = (value: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(value);

const isAbsolutePath = (value: string): boolean => (
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
);

const isRelativePath = (value: string): boolean => !isAbsolutePath(value) && !hasScheme(value);

const parseRootRelativePath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return null;
  const separatorIndex = trimmed.indexOf('::');
  if (separatorIndex < 0) return null;

  const rootPart = trimmed.slice(0, separatorIndex);
  const relativePart = trimmed.slice(separatorIndex + 2);
  if (!relativePart.trim()) return null;

  const rootPath = safeDecodeURIComponent(stripFileProtocol(stripHashAndQuery(rootPart)));
  const relativePath = safeDecodeURIComponent(stripHashAndQuery(relativePart));
  if (!rootPath || !relativePath) return null;

  const normalizedRoot = rootPath.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[\\/]+/, '');
  if (!normalizedRelative) return null;

  return `${normalizedRoot}/${normalizedRelative}`;
};

const normalizeLocalPath = (
  value: string
): { path: string; isRelative: boolean; isAbsolute: boolean } | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fileScheme = /^file:\/\//i.test(trimmed);
  const schemePresent = hasScheme(trimmed);
  if (schemePresent && !fileScheme && !isAbsolutePath(trimmed)) return null;

  let raw = trimmed;
  if (fileScheme) {
    raw = stripFileProtocol(raw);
  }
  raw = stripHashAndQuery(raw);
  const decoded = safeDecodeURIComponent(raw);
  const path = decoded || raw;
  if (!path) return null;

  const isAbsolute = isAbsolutePath(path);
  const isRelative = isRelativePath(path);
  return { path, isRelative, isAbsolute };
};

const toAbsolutePathFromCwd = (filePath: string, cwd: string): string => {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }
  return `${cwd.replace(/\/$/, '')}/${filePath.replace(/^\.\//, '')}`;
};

export type ToolGroupItem = {
  type: 'tool_group';
  toolUse: CoworkMessage;
  toolResult?: CoworkMessage | null;
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

export const buildDisplayItems = (messages: CoworkMessage[]): DisplayItem[] => {
  const items: DisplayItem[] = [];
  const groupsByToolUseId = new Map<string, ToolGroupItem>();
  let pendingAdjacentGroup: ToolGroupItem | null = null;

  for (const message of messages) {
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

    const turn = ensureTurn();
    if (item.type === 'tool_group') {
      turn.assistantItems.push({ type: 'tool_group', group: item });
      continue;
    }

    const message = item.message;
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

const isRenderableAssistantOrSystemMessage = (message: CoworkMessage): boolean => {
  if (hasText(message.content) || hasText(message.metadata?.error)) {
    return true;
  }
  if (message.metadata?.isThinking) {
    return Boolean(message.metadata?.isStreaming);
  }
  return false;
};

const isVisibleAssistantTurnItem = (item: AssistantTurnItem): boolean => {
  if (item.type === 'assistant' || item.type === 'system') {
    return isRenderableAssistantOrSystemMessage(item.message);
  }
  if (item.type === 'tool_result') {
    return hasText(getToolResultDisplay(item.message));
  }
  return true;
};

const getVisibleAssistantItems = (assistantItems: AssistantTurnItem[]): AssistantTurnItem[] =>
  assistantItems.filter(isVisibleAssistantTurnItem);

export const hasRenderableAssistantContent = (turn: ConversationTurn): boolean => (
  getVisibleAssistantItems(turn.assistantItems).length > 0
);

const getToolResultLineCount = (result: string): number => {
  if (!result) return 0;
  return result.split('\n').length;
};

const TodoWriteInputView: React.FC<{ items: ParsedTodoItem[] }> = ({ items }) => {
  const getStatusCheckboxClass = (status: TodoStatus): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 border-green-500 text-green-500';
      case 'in_progress':
        return 'bg-transparent border-blue-500';
      case 'pending':
      case 'unknown':
      default:
        return 'bg-transparent dark:border-claude-darkTextSecondary/60 border-claude-textSecondary/60';
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div
          key={`todo-item-${index}`}
          className="flex items-start gap-2"
        >
          <span className={`mt-0.5 h-4 w-4 rounded-[4px] border flex-shrink-0 inline-flex items-center justify-center ${getStatusCheckboxClass(item.status)}`}>
            {item.status === 'completed' && <CheckIcon className="h-3 w-3 stroke-[2.5]" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-xs whitespace-pre-wrap break-words leading-5 ${
              item.status === 'completed'
                ? 'dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/80'
                : 'dark:text-claude-darkText text-claude-text'
            }`}>
              {item.primaryText}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const ToolCallGroup: React.FC<{
  group: ToolGroupItem;
  isLastInSequence?: boolean;
  mapDisplayText?: (value: string) => string;
}> = ({
  group,
  isLastInSequence = true,
  mapDisplayText,
}) => {
  const { toolUse, toolResult } = group;
  const rawToolName = typeof toolUse.metadata?.toolName === 'string' ? toolUse.metadata.toolName : 'Tool';
  const toolName = getToolDisplayName(rawToolName);
  const toolInput = toolUse.metadata?.toolInput;
  const isCronTool = isCronToolName(rawToolName);
  const isTodoWriteTool = isTodoWriteToolName(rawToolName);
  const todoItems = isTodoWriteTool ? parseTodoWriteItems(toolInput) : null;
  const mapText = mapDisplayText ?? ((value: string) => value);
  const toolInputDisplayRaw = formatToolInput(rawToolName, toolInput);
  const toolInputDisplay = toolInputDisplayRaw ? mapText(toolInputDisplayRaw) : null;
  const toolInputSummaryRaw = getToolInputSummary(rawToolName, toolInput) ?? toolInputDisplayRaw;
  const toolInputSummary = toolInputSummaryRaw ? mapText(toolInputSummaryRaw) : null;
  const toolResultDisplayRaw = toolResult ? getToolResultDisplay(toolResult) : '';
  const toolResultDisplay = mapText(toolResultDisplayRaw);
  const hasToolResultText = hasText(toolResultDisplay);
  const isToolError = Boolean(toolResult?.metadata?.isError || toolResult?.metadata?.error);
  const showNoDetailError = isToolError && !hasToolResultText;
  const toolResultFallback = showNoDetailError ? i18nService.t('coworkToolNoErrorDetail') : '';
  const displayToolResult = hasToolResultText ? toolResultDisplay : toolResultFallback;
  const [isExpanded, setIsExpanded] = useState(false);
  const resultLineCount = hasToolResultText ? getToolResultLineCount(toolResultDisplay) : 0;
  const toolResultSummary = isCronTool && hasToolResultText
    ? truncatePreview(toolResultDisplay.replace(/\s+/g, ' '))
    : null;

  // Check if this is a Bash-like tool that should show terminal style
  const isBashTool = isBashLikeToolName(rawToolName);

  return (
    <div className="relative py-1">
      {/* Vertical connecting line to next tool group */}
      {!isLastInSequence && (
        <div className="absolute left-[3.5px] top-[14px] bottom-[-8px] w-px dark:bg-claude-darkTextSecondary/30 bg-claude-textSecondary/30" />
      )}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-start gap-2 text-left group relative z-10"
      >
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
          !toolResult
            ? 'bg-blue-500 animate-pulse'
            : isToolError
              ? 'bg-red-500'
              : 'bg-green-500'
        }`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {toolName}
            </span>
            {toolInputSummary && (
              <code className="text-xs dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 font-mono truncate max-w-[400px]">
                {toolInputSummary}
              </code>
            )}
          </div>
          {toolResult && !isTodoWriteTool && (hasToolResultText || showNoDetailError) && (
            <div className={`text-xs mt-0.5 ${
              hasToolResultText
                ? 'dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60'
                : showNoDetailError
                  ? 'text-red-500/80'
                  : 'dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60'
            }`}>
              {hasToolResultText
                ? (toolResultSummary ?? `${resultLineCount} ${resultLineCount === 1 ? 'line' : 'lines'} of output`)
                : toolResultFallback}
            </div>
          )}
          {!toolResult && (
            <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-0.5">
              {i18nService.t('coworkToolRunning')}
            </div>
          )}
        </div>
      </button>
      {isExpanded && (
        <div className="ml-4 mt-2">
          {isBashTool ? (
            // Terminal-style display for Bash commands
            <div className="rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border">
              {/* Terminal header */}
              <div className="flex items-center gap-1.5 px-3 py-1.5 dark:bg-claude-darkSurface bg-claude-surfaceInset">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                <span className="ml-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium">Terminal</span>
              </div>
              {/* Terminal content */}
              <div className="dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-3 py-3 max-h-72 overflow-y-auto font-mono text-xs">
                {toolInputDisplay && (
                  <div className="dark:text-claude-darkText text-claude-text">
                    <span className="text-claude-accent select-none">$ </span>
                    <span className="whitespace-pre-wrap break-words">{toolInputDisplay}</span>
                  </div>
                )}
                {toolResult && (hasToolResultText || showNoDetailError) && (
                  <div className={`mt-1.5 whitespace-pre-wrap break-words ${
                    isToolError
                      ? 'text-red-400'
                      : hasToolResultText
                        ? 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
                        : 'dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 italic'
                  }`}>
                    {displayToolResult}
                  </div>
                )}
                {!toolResult && (
                  <div className="dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-1.5 italic">
                    {i18nService.t('coworkToolRunning')}
                  </div>
                )}
              </div>
            </div>
          ) : isTodoWriteTool && todoItems ? (
            <TodoWriteInputView items={todoItems} />
          ) : (
            // Standard display for other tools with input/output labels
            <div className="space-y-2">
              {toolInputDisplay && (
                <div>
                  <div className="text-[10px] font-medium dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolInput')}
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    <pre className="text-xs dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words font-mono">
                      {toolInputDisplay}
                    </pre>
                  </div>
                </div>
              )}
              {toolResult && (hasToolResultText || showNoDetailError) && (
                <div>
                  <div className="text-[10px] font-medium dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolResult')}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <pre className={`text-xs whitespace-pre-wrap break-words font-mono ${
                      isToolError
                        ? 'text-red-500'
                        : hasToolResultText
                          ? 'dark:text-claude-darkText text-claude-text'
                          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary italic'
                    }`}>
                      {displayToolResult}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Copy button component
const CopyButton: React.FC<{
  content: string;
  visible: boolean;
}> = ({ content, visible }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-1.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      title={i18nService.t('copyToClipboard')}
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 text-green-500"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 text-[var(--icon-secondary)]"
          aria-hidden="true"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
        </svg>
      )}
    </button>
  );
};

export const UserMessageItem: React.FC<{ message: CoworkMessage; skills: Skill[] }> = React.memo(({ message, skills }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  // Get skills used for this message
  const messageSkillIds = (message.metadata as CoworkMessageMetadata)?.skillIds || [];
  const messageSkills = messageSkillIds
    .map(id => skills.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  // Get image attachments from metadata
  const imageAttachments = ((message.metadata as CoworkMessageMetadata)?.imageAttachments ?? []) as CoworkImageAttachment[];

  return (
    <div
      className="py-2 px-4"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="max-w-3xl mx-auto">
        <div className="pl-4 sm:pl-8 md:pl-12">
          <div className="flex items-start gap-3 flex-row-reverse">
            <div className="w-full min-w-0 flex flex-col items-end">
              <div className="w-fit max-w-[42rem] rounded-2xl px-4 py-2.5 dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text shadow-subtle">
                {message.content?.trim() && (
                  <MarkdownContent
                    content={message.content}
                    className="max-w-none whitespace-pre-wrap break-words"
                  />
                )}
                {imageAttachments.length > 0 && (
                  <div className={`flex flex-wrap gap-2 ${message.content?.trim() ? 'mt-2' : ''}`}>
                    {imageAttachments.map((img, idx) => (
                      <div key={idx} className="relative group">
                        <img
                          src={`data:${img.mimeType};base64,${img.base64Data}`}
                          alt={img.name}
                          className="max-h-48 max-w-[16rem] rounded-lg object-contain cursor-pointer border dark:border-claude-darkBorder/50 border-claude-border/50 hover:border-claude-accent/50 transition-colors"
                          title={img.name}
                          onClick={() => setExpandedImage(`data:${img.mimeType};base64,${img.base64Data}`)}
                        />
                        <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/50 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity truncate pointer-events-none">
                          <PhotoIcon className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{img.name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-1.5 mt-1">
                {messageSkills.map(skill => (
                  <div
                    key={skill.id}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-claude-accent/5 dark:bg-claude-accent/10"
                    title={skill.description}
                  >
                    <PuzzleIcon className="h-2.5 w-2.5 text-claude-accent/70" />
                    <span className="text-[10px] font-medium text-claude-accent/70 max-w-[60px] truncate">
                      {skill.name}
                    </span>
                  </div>
                ))}
                <CopyButton
                  content={message.content}
                  visible={isHovered}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Image lightbox overlay */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Preview"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
});

const AssistantMessageItem: React.FC<{
  message: CoworkMessage;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showCopyButton?: boolean;
}> = ({
  message,
  resolveLocalFilePath,
  mapDisplayText,
  showCopyButton = false,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="dark:text-claude-darkText text-claude-text">
        <MarkdownContent
          content={displayContent}
          className="prose dark:prose-invert max-w-none"
          resolveLocalFilePath={resolveLocalFilePath}
        />
      </div>
      {showCopyButton && (
        <div className="flex items-center gap-1.5 mt-1">
          <CopyButton
            content={displayContent}
            visible={isHovered}
          />
        </div>
      )}
    </div>
  );
};

// Streaming activity bar shown between messages and input
const StreamingActivityBar: React.FC<{ messages: CoworkMessage[] }> = ({ messages }) => {
  // Walk messages backwards to find the latest tool_use without a paired tool_result
  const getStatusText = (): string => {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      const id = msg.metadata?.toolUseId;
      if (typeof id === 'string') {
        if (msg.type === 'tool_result') toolResultIds.add(id);
        if (msg.type === 'tool_use') toolUseIds.add(id);
      }
    }
    // Walk backwards to find latest unresolved tool_use
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'tool_use') {
        const id = msg.metadata?.toolUseId;
        if (typeof id === 'string' && !toolResultIds.has(id)) {
          const toolName = typeof msg.metadata?.toolName === 'string' ? msg.metadata.toolName : null;
          if (toolName) {
            return `${i18nService.t('coworkToolRunning')} ${toolName}...`;
          }
        }
      }
    }
    return `${i18nService.t('coworkToolRunning')}`;
  };

  return (
    <div className="shrink-0 animate-fade-in px-4">
      <div className="max-w-3xl mx-auto">
        <div className="streaming-bar" />
        <div className="py-1">
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {getStatusText()}
          </span>
        </div>
      </div>
    </div>
  );
};

const TypingDots: React.FC = () => (
  <div className="flex items-center space-x-1.5 py-1">
    <div className="w-2 h-2 rounded-full bg-claude-accent animate-bounce" style={{ animationDelay: '0ms' }} />
    <div className="w-2 h-2 rounded-full bg-claude-accent animate-bounce" style={{ animationDelay: '150ms' }} />
    <div className="w-2 h-2 rounded-full bg-claude-accent animate-bounce" style={{ animationDelay: '300ms' }} />
  </div>
);

const ThinkingBlock: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
}> = ({ message, mapDisplayText }) => {
  const isCurrentlyStreaming = Boolean(message.metadata?.isStreaming);
  const [isExpanded, setIsExpanded] = useState(isCurrentlyStreaming);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;

  // Auto-expand while streaming, auto-collapse when streaming completes
  useEffect(() => {
    if (isCurrentlyStreaming) {
      setIsExpanded(true);
    } else {
      setIsExpanded(false);
    }
  }, [isCurrentlyStreaming]);

  return (
    <div className="rounded-lg border dark:border-claude-darkBorder/50 border-claude-border/50 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left dark:hover:bg-claude-darkSurfaceHover/50 hover:bg-claude-surfaceHover/50 transition-colors"
      >
        <ChevronRightIcon
          className={`h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0 transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
        <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('reasoning')}
        </span>
        {isCurrentlyStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-claude-accent animate-pulse" />
        )}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 max-h-64 overflow-y-auto">
          <div className="text-xs leading-relaxed dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 whitespace-pre-wrap">
            {displayContent}
          </div>
        </div>
      )}
    </div>
  );
};

export const AssistantTurnBlock: React.FC<{
  turn: ConversationTurn;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showTypingIndicator?: boolean;
  showCopyButtons?: boolean;
}> = ({
  turn,
  resolveLocalFilePath,
  mapDisplayText,
  showTypingIndicator = false,
  showCopyButtons = true,
}) => {
  const visibleAssistantItems = getVisibleAssistantItems(turn.assistantItems);

  const renderSystemMessage = (message: CoworkMessage) => {
    const rawContent = hasText(message.content)
      ? message.content
      : (typeof message.metadata?.error === 'string' ? message.metadata.error : '');
    const normalizedContent = getScheduledReminderDisplayText(rawContent) ?? rawContent;
    const content = mapDisplayText ? mapDisplayText(normalizedContent) : normalizedContent;
    if (!content.trim()) return null;

    return (
      <div className="rounded-lg border dark:border-claude-darkBorder/70 border-claude-border/70 dark:bg-claude-darkBg/40 bg-claude-bg/60 px-3 py-2">
        <div className="flex items-start gap-2">
          <InformationCircleIcon className="h-4 w-4 mt-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0" />
          <div className="text-xs whitespace-pre-wrap dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {content}
          </div>
        </div>
      </div>
    );
  };

  const renderOrphanToolResult = (message: CoworkMessage) => {
    const toolResultDisplayRaw = getToolResultDisplay(message);
    const toolResultDisplay = mapDisplayText ? mapDisplayText(toolResultDisplayRaw) : toolResultDisplayRaw;
    const isToolError = Boolean(message.metadata?.isError || message.metadata?.error);
    const hasToolResultText = hasText(toolResultDisplay);
    const resultLineCount = hasToolResultText ? getToolResultLineCount(toolResultDisplay) : 0;
    const showNoDetailError = isToolError && !hasToolResultText;
    const fallbackText = showNoDetailError ? i18nService.t('coworkToolNoErrorDetail') : '';
    const displayText = hasToolResultText ? toolResultDisplay : fallbackText;
    return (
      <div className="py-1">
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
            isToolError ? 'bg-red-500' : 'bg-claude-darkTextSecondary/50'
          }`} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkToolResult')}
            </div>
            {resultLineCount > 0 && (
              <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-0.5">
                {resultLineCount} {resultLineCount === 1 ? 'line' : 'lines'} of output
              </div>
            )}
            {resultLineCount === 0 && showNoDetailError && (
              <div className={`text-xs mt-0.5 ${
                isToolError
                  ? 'text-red-500/80'
                  : 'dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60'
              }`}>
                {fallbackText}
              </div>
            )}
            {(hasToolResultText || showNoDetailError) && (
              <div className="mt-2 px-3 py-2 rounded-lg dark:bg-claude-darkSurface/50 bg-claude-surface/50 max-h-64 overflow-y-auto">
                <pre className={`text-xs whitespace-pre-wrap break-words font-mono ${
                  isToolError
                    ? 'text-red-500'
                    : hasToolResultText
                      ? 'dark:text-claude-darkText text-claude-text'
                      : 'dark:text-claude-darkTextSecondary text-claude-textSecondary italic'
                }`}>
                  {displayText}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="px-4 py-2">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 px-4 py-3 space-y-3">
            {visibleAssistantItems.map((item, index) => {
              if (item.type === 'assistant') {
                if (item.message.metadata?.isThinking) {
                  return (
                    <ThinkingBlock
                      key={item.message.id}
                      message={item.message}
                      mapDisplayText={mapDisplayText}
                    />
                  );
                }
                // Check if there are any tool_group items after this assistant message
                const hasToolGroupAfter = visibleAssistantItems
                  .slice(index + 1)
                  .some(laterItem => laterItem.type === 'tool_group');

                return (
                  <AssistantMessageItem
                    key={item.message.id}
                    message={item.message}
                    resolveLocalFilePath={resolveLocalFilePath}
                    mapDisplayText={mapDisplayText}
                    showCopyButton={showCopyButtons && !hasToolGroupAfter}
                  />
                );
              }

              if (item.type === 'tool_group') {
                const nextItem = visibleAssistantItems[index + 1];
                const isLastInSequence = !nextItem || nextItem.type !== 'tool_group';
                return (
                  <ToolCallGroup
                    key={`tool-${item.group.toolUse.id}`}
                    group={item.group}
                    isLastInSequence={isLastInSequence}
                    mapDisplayText={mapDisplayText}
                  />
                );
              }

              if (item.type === 'system') {
                const systemMessage = renderSystemMessage(item.message);
                if (!systemMessage) {
                  return null;
                }
                return (
                  <div key={item.message.id}>
                    {systemMessage}
                  </div>
                );
              }

              return (
                <div key={item.message.id}>
                  {renderOrphanToolResult(item.message)}
                </div>
              );
            })}
            {showTypingIndicator && <TypingDots />}
          </div>
        </div>
      </div>
    </div>
  );
};

const CoworkSessionDetail: React.FC<CoworkSessionDetailProps> = ({
  onManageSkills,
  onContinue,
  onStop,
  onNavigateHome,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.cowork.isStreaming);
  const remoteManaged = useSelector((state: RootState) => state.cowork.remoteManaged);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const detailRootRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  // Clear lazy-render height cache when session changes
  const sessionId = currentSession?.id;
  useEffect(() => {
    clearHeightCache();
  }, [sessionId]);

  // Turn navigation states
  // currentTurnIndex (state) drives UI rendering; currentTurnIndexRef (ref) provides
  // up-to-date value inside callbacks (avoids stale closure). Both must be updated together.
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const currentTurnIndexRef = useRef(0);
  const [showTurnNav, setShowTurnNav] = useState(false);
  const hideNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNavigatingRef = useRef(false);
  const navigatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnElsCacheRef = useRef<HTMLElement[]>([]);
  const [isScrollable, setIsScrollable] = useState(false);
  const [showTurnIndexPopover, setShowTurnIndexPopover] = useState(false);
  const showTurnIndexPopoverRef = useRef(false);
  const turnIndexPopoverRef = useRef<HTMLDivElement>(null);
  const turnIndexButtonRef = useRef<HTMLButtonElement>(null);

  // Menu and action states
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isExportingImage, setIsExportingImage] = useState(false);

  // Rename states
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);

  // Reset rename value when session changes
  useEffect(() => {
    if (!isRenaming && currentSession) {
      setRenameValue(currentSession.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, currentSession?.title]);

  useEffect(() => {
    setShouldAutoScroll(true);
  }, [currentSession?.id]);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  // Cleanup nav timers on unmount
  useEffect(() => {
    return () => {
      if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
      if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    };
  }, []);

  // Reset nav state when session changes
  useEffect(() => {
    setShowTurnNav(false);
    setIsScrollable(false);
    setCurrentTurnIndex(0);
    currentTurnIndexRef.current = 0;
    isNavigatingRef.current = false;
    turnElsCacheRef.current = [];
    if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    setShowTurnIndexPopover(false);
    showTurnIndexPopoverRef.current = false;
  }, [currentSession?.id]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !actionButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [menuPosition]);

  // Helper: truncate path for display
  const truncatePath = (path: string, maxLength = 20): string => {
    if (!path) return i18nService.t('noFolderSelected');
    return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
  };

  // Menu position calculator
  const calculateMenuPosition = (height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const menuWidth = 180;
    const padding = 8;
    const x = Math.min(
      Math.max(padding, rect.right - menuWidth),
      window.innerWidth - menuWidth - padding
    );
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - padding);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) {
      closeMenu();
      return;
    }
    const menuHeight = 160;
    const position = calculateMenuPosition(menuHeight);
    if (position) {
      setMenuPosition(position);
    }
    setShowConfirmDelete(false);
  };

  const closeMenu = () => {
    setMenuPosition(null);
    setShowConfirmDelete(false);
  };

  // Open folder in Finder/Explorer
  const handleOpenFolder = useCallback(async () => {
    if (!currentSession?.cwd) return;
    try {
      await window.electron.shell.openPath(currentSession.cwd);
    } catch (error) {
      console.error('Failed to open folder:', error);
    }
  }, [currentSession?.cwd]);

  // Rename handlers
  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession) return;
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setShowConfirmDelete(false);
    setRenameValue(currentSession.title);
    setMenuPosition(null);
  };

  const handleRenameSave = async (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    if (!currentSession) return;
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle && nextTitle !== currentSession.title) {
      await coworkService.renameSession(currentSession.id, nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    if (currentSession) {
      setRenameValue(currentSession.title);
    }
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  // Pin/unpin handler
  const handleTogglePin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession) return;
    await coworkService.setSessionPinned(currentSession.id, !currentSession.pinned);
    closeMenu();
  };

  // Delete handlers
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(true);
    setMenuPosition(null);
  };

  const handleShareClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession || isExportingImage) return;
    closeMenu();
    setIsExportingImage(true);

    window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const scrollContainer = scrollContainerRef.current;
          if (!scrollContainer) {
            throw new Error('Capture target not found');
          }
          const initialScrollTop = scrollContainer.scrollTop;
          try {
            const scrollRect = domRectToCaptureRect(scrollContainer.getBoundingClientRect());
            if (scrollRect.width <= 0 || scrollRect.height <= 0) {
              throw new Error('Invalid capture area');
            }

            const scrollContentHeight = Math.max(scrollContainer.scrollHeight, scrollContainer.clientHeight);
            if (scrollContentHeight <= 0) {
              throw new Error('Invalid content height');
            }

            const toContentY = (viewportY: number): number => {
              const y = scrollContainer.scrollTop + (viewportY - scrollRect.y);
              return Math.max(0, Math.min(scrollContentHeight, y));
            };

            const userAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="user-message"]');
            const assistantAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="assistant-block"]');

            let contentStart = 0;
            let contentEnd = scrollContentHeight;

            if (userAnchors.length > 0) {
              contentStart = toContentY(userAnchors[0].getBoundingClientRect().top);
            } else if (assistantAnchors.length > 0) {
              contentStart = toContentY(assistantAnchors[0].getBoundingClientRect().top);
            }

            if (assistantAnchors.length > 0) {
              const lastAssistant = assistantAnchors[assistantAnchors.length - 1];
              contentEnd = toContentY(lastAssistant.getBoundingClientRect().bottom);
            } else if (userAnchors.length > 0) {
              const lastUser = userAnchors[userAnchors.length - 1];
              contentEnd = toContentY(lastUser.getBoundingClientRect().bottom);
            }

            const maxStart = Math.max(0, scrollContentHeight - 1);
            contentStart = Math.max(0, Math.min(maxStart, Math.round(contentStart)));
            contentEnd = Math.max(contentStart + 1, Math.min(scrollContentHeight, Math.round(contentEnd)));

            const outputHeight = contentEnd - contentStart;

            if (outputHeight > MAX_EXPORT_CANVAS_HEIGHT) {
              throw new Error(`Export image is too tall (${outputHeight}px)`);
            }

            const segmentsEstimate = Math.ceil(outputHeight / Math.max(1, scrollRect.height)) + 1;
            if (segmentsEstimate > MAX_EXPORT_SEGMENTS) {
              throw new Error('Export image is too long');
            }

            const canvas = document.createElement('canvas');
            canvas.width = scrollRect.width;
            canvas.height = outputHeight;
            const context = canvas.getContext('2d');
            if (!context) {
              throw new Error('Canvas context unavailable');
            }

            const captureAndLoad = async (rect: CaptureRect): Promise<HTMLImageElement> => {
              const chunk = await coworkService.captureSessionImageChunk({ rect });
              if (!chunk.success || !chunk.pngBase64) {
                throw new Error(chunk.error || 'Failed to capture image chunk');
              }
              return loadImageFromBase64(chunk.pngBase64);
            };

            scrollContainer.scrollTop = Math.min(contentStart, Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight));
            await waitForNextFrame();
            await waitForNextFrame();

            const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            let contentOffset = contentStart;
            while (contentOffset < contentEnd) {
              const targetScrollTop = Math.min(contentOffset, maxScrollTop);
              scrollContainer.scrollTop = targetScrollTop;
              await waitForNextFrame();
              await waitForNextFrame();

              const chunkImage = await captureAndLoad(scrollRect);
              const sourceYOffset = Math.max(0, contentOffset - targetScrollTop);
              const drawableHeight = Math.min(scrollRect.height - sourceYOffset, contentEnd - contentOffset);
              if (drawableHeight <= 0) {
                throw new Error('Failed to stitch export image');
              }
              const scaleY = chunkImage.naturalHeight / scrollRect.height;
              const sourceYInImage = Math.max(0, Math.round(sourceYOffset * scaleY));
              const sourceHeightInImage = Math.max(1, Math.min(
                chunkImage.naturalHeight - sourceYInImage,
                Math.round(drawableHeight * scaleY),
              ));

              context.drawImage(
                chunkImage,
                0,
                sourceYInImage,
                chunkImage.naturalWidth,
                sourceHeightInImage,
                0,
                contentOffset - contentStart,
                scrollRect.width,
                drawableHeight,
              );

              contentOffset += drawableHeight;
            }

            const pngDataUrl = canvas.toDataURL('image/png');
            const base64Index = pngDataUrl.indexOf(',');
            if (base64Index < 0) {
              throw new Error('Failed to encode export image');
            }

            const timestamp = formatExportTimestamp(new Date());
            const saveResult = await coworkService.saveSessionResultImage({
              pngBase64: pngDataUrl.slice(base64Index + 1),
              defaultFileName: sanitizeExportFileName(`${currentSession.title}-${timestamp}.png`),
            });
            if (saveResult.success && !saveResult.canceled) {
              window.dispatchEvent(new CustomEvent('app:showToast', {
                detail: i18nService.t('coworkExportImageSuccess'),
              }));
              return;
            }
            if (!saveResult.success) {
              throw new Error(saveResult.error || 'Failed to export image');
            }
          } finally {
            scrollContainer.scrollTop = initialScrollTop;
          }
        } catch (error) {
          console.error('Failed to export session image:', error);
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkExportImageFailed'),
          }));
        } finally {
          setIsExportingImage(false);
        }
      })();
    });
  };

  const handleConfirmDelete = async () => {
    if (!currentSession) return;
    await coworkService.deleteSession(currentSession.id);
    setShowConfirmDelete(false);
    if (onNavigateHome) {
      onNavigateHome();
    }
  };

  const handleCancelDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowConfirmDelete(false);
  };

  const handleMessagesScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceToBottom <= AUTO_SCROLL_THRESHOLD;
    setShouldAutoScroll((prev) => (prev === isNearBottom ? prev : isNearBottom));

    // Check if content overflows the container (use functional updater to avoid redundant re-renders)
    const scrollable = container.scrollHeight > container.clientHeight;
    setIsScrollable((prev) => (prev === scrollable ? prev : scrollable));
    if (!scrollable) return;

    // Show turn nav and reset hide timer (use functional updater to avoid redundant re-renders)
    setShowTurnNav((prev) => (prev ? prev : true));

    if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
    if (!showTurnIndexPopoverRef.current) {
      hideNavTimerRef.current = setTimeout(() => setShowTurnNav(false), NAV_HIDE_DELAY);
    }

    // Skip index recalculation during programmatic navigation
    if (isNavigatingRef.current) return;

    // Update current turn index based on cached turn elements
    const turnEls = turnElsCacheRef.current;
    if (turnEls.length === 0) return;

    // If at very bottom, snap to last turn (use smaller threshold than auto-scroll)
    if (distanceToBottom <= NAV_BOTTOM_SNAP_THRESHOLD) {
      const lastIndex = turnEls.length - 1;
      currentTurnIndexRef.current = lastIndex;
      setCurrentTurnIndex(lastIndex);
      return;
    }

    const scrollTop = container.scrollTop;
    let visibleIndex = 0;
    for (let i = 0; i < turnEls.length; i++) {
      if (turnEls[i].offsetTop <= scrollTop + 80) {
        visibleIndex = i;
      } else {
        break;
      }
    }
    currentTurnIndexRef.current = visibleIndex;
    setCurrentTurnIndex(visibleIndex);
  }, []);

  const navigateToTurnByIndex = useCallback((index: number) => {
    const turnEls = turnElsCacheRef.current;
    if (index < 0 || index >= turnEls.length) return;

    isNavigatingRef.current = true;
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    navigatingTimerRef.current = setTimeout(() => { isNavigatingRef.current = false; }, NAV_SCROLL_LOCK_DURATION);

    turnEls[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
    currentTurnIndexRef.current = index;
    setCurrentTurnIndex(index);

    setShowTurnNav(true);
    if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
    hideNavTimerRef.current = setTimeout(() => setShowTurnNav(false), NAV_HIDE_DELAY);
  }, []);

  const navigateToTurn = useCallback((direction: 'prev' | 'next') => {
    const turnEls = turnElsCacheRef.current;
    if (turnEls.length === 0) return;
    const idx = currentTurnIndexRef.current;
    const targetIndex = direction === 'prev' ? idx - 1 : idx + 1;
    if (targetIndex < 0 || targetIndex >= turnEls.length) return;
    navigateToTurnByIndex(targetIndex);
  }, [navigateToTurnByIndex]);
  const lastMessage = currentSession?.messages?.[currentSession.messages.length - 1];
  const lastMessageContent = lastMessage?.content;

  const resolveLocalFilePath = useCallback((href: string, text: string) => {
    const hrefValue = typeof href === 'string' ? href.trim() : '';
    const textValue = typeof text === 'string' ? text.trim() : '';
    if (!hrefValue && !textValue) return null;

    const hrefRootRelative = hrefValue ? parseRootRelativePath(hrefValue) : null;
    if (hrefRootRelative) {
      return hrefRootRelative;
    }

    const hrefPath = hrefValue ? normalizeLocalPath(hrefValue) : null;
    if (hrefPath) {
      if (hrefPath.isRelative && currentSession?.cwd) {
        return toAbsolutePathFromCwd(hrefPath.path, currentSession.cwd);
      }
      if (hrefPath.isAbsolute) {
        return hrefPath.path;
      }
    }

    const textRootRelative = textValue ? parseRootRelativePath(textValue) : null;
    if (textRootRelative) {
      return textRootRelative;
    }

    const textPath = textValue ? normalizeLocalPath(textValue) : null;
    if (textPath) {
      if (textPath.isRelative && currentSession?.cwd) {
        return toAbsolutePathFromCwd(textPath.path, currentSession.cwd);
      }
      if (textPath.isAbsolute) {
        return textPath.path;
      }
    }

    return null;
  }, [currentSession?.cwd]);

  const mapDisplayText = useCallback((value: string): string => {
    return value;
  }, []);

  const messages = currentSession?.messages;
  const displayItems = useMemo(() => messages ? buildDisplayItems(messages) : [], [messages]);
  const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);

  // Cache turn DOM elements when turns change
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) { turnElsCacheRef.current = []; return; }
    // DOM is already committed when useEffect runs, query synchronously
    turnElsCacheRef.current = Array.from(
      container.querySelectorAll<HTMLElement>('[data-turn-index]')
    );
  }, [turns]);

  // Close turn index popover on click-outside or Escape
  useEffect(() => {
    if (!showTurnIndexPopover) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        turnIndexPopoverRef.current && !turnIndexPopoverRef.current.contains(e.target as Node)
        && !turnIndexButtonRef.current?.contains(e.target as Node)
      ) {
        setShowTurnIndexPopover(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTurnIndexPopover(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showTurnIndexPopover]);

  // Auto-scroll popover to bottom (show latest conversations) when opened
  useEffect(() => {
    if (showTurnIndexPopover && turnIndexPopoverRef.current) {
      turnIndexPopoverRef.current.scrollTop = turnIndexPopoverRef.current.scrollHeight;
    }
  }, [showTurnIndexPopover]);

  // Sync popover ref and manage hide timer based on popover visibility
  useEffect(() => {
    showTurnIndexPopoverRef.current = showTurnIndexPopover;
    if (showTurnIndexPopover) {
      // Popover opened — clear hide timer to keep nav visible
      if (hideNavTimerRef.current) {
        clearTimeout(hideNavTimerRef.current);
        hideNavTimerRef.current = null;
      }
    } else {
      // Popover closed — restart hide timer
      if (showTurnNav) {
        if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
        hideNavTimerRef.current = setTimeout(() => setShowTurnNav(false), NAV_HIDE_DELAY);
      }
    }
  }, [showTurnIndexPopover, showTurnNav]);

  // Close popover when nav hides
  useEffect(() => {
    if (!showTurnNav) setShowTurnIndexPopover(false);
  }, [showTurnNav]);

  // Auto scroll to bottom when new messages arrive or content updates (streaming)
  useEffect(() => {
    if (!shouldAutoScroll) {
      return;
    }
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      setIsScrollable(container.scrollHeight > container.clientHeight);
    }
    // Sync turn index to last when auto-scrolled to bottom
    if (turns.length > 0) {
      const lastIndex = turns.length - 1;
      currentTurnIndexRef.current = lastIndex;
      setCurrentTurnIndex(lastIndex);
    }
  }, [currentSession?.messages?.length, lastMessageContent, isStreaming, shouldAutoScroll, turns.length]);


  if (!currentSession) {
    return null;
  }

  const renderConversationTurns = () => {
    if (turns.length === 0) {
      if (!isStreaming) return null;
      return (
        <div data-export-role="assistant-block">
          <AssistantTurnBlock
            turn={{
              id: 'streaming-only',
              userMessage: null,
              assistantItems: [],
            }}
            resolveLocalFilePath={resolveLocalFilePath}
            showTypingIndicator
            showCopyButtons={!isStreaming}
          />
        </div>
      );
    }

    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      const showTypingIndicator = isStreaming && isLastTurn && !hasRenderableAssistantContent(turn);
      const showAssistantBlock = turn.assistantItems.length > 0 || showTypingIndicator;
      // Always render last 3 turns (needed for streaming, auto-scroll, and smooth UX)
      const alwaysRender = index >= turns.length - 3;

      return (
        <LazyRenderTurn key={turn.id} turnId={turn.id} alwaysRender={alwaysRender} data-turn-index={index}>
          {turn.userMessage && (
            <div data-export-role="user-message">
              <UserMessageItem message={turn.userMessage} skills={skills} />
            </div>
          )}
          {showAssistantBlock && (
            <div data-export-role="assistant-block">
              <AssistantTurnBlock
                turn={turn}
                resolveLocalFilePath={resolveLocalFilePath}
                mapDisplayText={mapDisplayText}
                showTypingIndicator={showTypingIndicator}
                showCopyButtons={!isStreaming}
              />
            </div>
          )}
        </LazyRenderTurn>
      );
    });
  };

  return (
    <div ref={detailRootRef} className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 shrink-0">
        {/* Left side: Toggle buttons (when collapsed) + Title */}
        <div className="flex h-full items-center gap-2 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameSave(e);
                }
                if (e.key === 'Escape') {
                  handleRenameCancel(e);
                }
              }}
              onBlur={handleRenameBlur}
              className="non-draggable min-w-0 max-w-[300px] rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
            />
          ) : (
            <h1 className="text-sm leading-none font-medium dark:text-claude-darkText text-claude-text truncate max-w-[360px]">
              {currentSession.title || i18nService.t('coworkNewSession')}
            </h1>
          )}
        </div>

        {/* Right side: Folder + Menu */}
        <div className="non-draggable flex items-center gap-1">
          {/* Folder button */}
          <button
            type="button"
            onClick={handleOpenFolder}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
            aria-label={i18nService.t('coworkOpenFolder')}
          >
            <FolderIcon className="h-4 w-4" />
            <span className="max-w-[120px] truncate text-xs">
              {truncatePath(currentSession.cwd)}
            </span>
          </button>

          {/* Menu button */}
          <button
            ref={actionButtonRef}
            type="button"
            onClick={openMenu}
            className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            aria-label={i18nService.t('coworkSessionActions')}
          >
            <EllipsisHorizontalIcon className="h-5 w-5" />
          </button>
          <WindowTitleBar inline className="ml-1" />
        </div>
      </div>

      {/* Floating Menu */}
      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover popover-enter overflow-hidden"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          role="menu"
        >
          <button
            type="button"
            onClick={handleRenameClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <PencilSquareIcon className="h-4 w-4" />
            {i18nService.t('renameConversation')}
          </button>
          <button
            type="button"
            onClick={handleTogglePin}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <PushPinIcon
              slashed={currentSession.pinned}
              className={`h-4 w-4 ${currentSession.pinned ? 'opacity-60' : ''}`}
            />
            {currentSession.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession')}
          </button>
          <button
            type="button"
            onClick={handleShareClick}
            disabled={isExportingImage}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ShareIcon className="h-4 w-4" />
            {i18nService.t('coworkShareSession')}
          </button>
          <button
            type="button"
            onClick={handleDeleteClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <TrashIcon className="h-4 w-4" />
            {i18nService.t('deleteSession')}
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showConfirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
          onClick={handleCancelDelete}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('deleteTaskConfirmTitle')}
              </h2>
            </div>

            {/* Content */}
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('deleteTaskConfirmMessage')}
              </p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('deleteSession')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handleMessagesScroll}
          className="h-full min-h-0 overflow-y-auto pt-3"
        >
          {renderConversationTurns()}
          <div className="h-20" />
        </div>

        {/* Turn Navigation Buttons */}
        {turns.length > 1 && isScrollable && (
          <>
            <div
              className={`absolute right-6 top-1/2 -translate-y-1/2 flex flex-col rounded-lg overflow-hidden shadow-lg transition-opacity duration-300 z-10

                dark:bg-claude-darkSurface/90 bg-claude-surface/90 backdrop-blur-sm
                border dark:border-claude-darkBorder border-claude-border
                ${showTurnNav ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
            >
              <button
                type="button"
                onClick={() => currentTurnIndex > 0 && navigateToTurn('prev')}
                className={`px-1.5 py-3 transition-colors dark:text-claude-darkText text-claude-text
                  ${currentTurnIndex <= 0
                    ? 'opacity-30 cursor-default'
                    : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer'}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                </svg>
              </button>
              <div className="dark:border-claude-darkBorder border-claude-border border-t" />
              <button
                ref={turnIndexButtonRef}
                type="button"
                onClick={() => setShowTurnIndexPopover(prev => !prev)}
                className="px-1.5 py-2 transition-colors dark:text-claude-darkText text-claude-text
                  dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer"
                title={i18nService.t('turnIndex')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
              </button>
              <div className="dark:border-claude-darkBorder border-claude-border border-t" />
              <button
                type="button"
                onClick={() => currentTurnIndex < turns.length - 1 && navigateToTurn('next')}
                className={`px-1.5 py-3 transition-colors dark:text-claude-darkText text-claude-text
                  ${currentTurnIndex >= turns.length - 1
                    ? 'opacity-30 cursor-default'
                    : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer'}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
            </div>

            {/* Turn Index Popover */}
            {showTurnIndexPopover && (
              <div
                ref={turnIndexPopoverRef}
                className="absolute right-16 top-1/2 -translate-y-1/2 z-20
                  w-64 max-h-72 overflow-y-auto rounded-lg shadow-xl
                  dark:bg-claude-darkSurface bg-claude-surface backdrop-blur-sm
                  border dark:border-claude-darkBorder border-claude-border"
              >
                {turns.map((turn, index) => {
                  const label = turn.userMessage?.content
                    ? turn.userMessage.content.split('\n')[0].slice(0, 60)
                    : '...';
                  const isActive = index === currentTurnIndex;
                  return (
                    <button
                      key={turn.id}
                      type="button"
                      onClick={() => {
                        navigateToTurnByIndex(index);
                        setShowTurnIndexPopover(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm truncate transition-colors
                        ${isActive
                          ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium'
                          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'}
                        ${index > 0 ? 'border-t dark:border-claude-darkBorder border-claude-border' : ''}`}
                    >
                      <span className="mr-2 text-xs opacity-50">{index + 1}</span>
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Streaming Activity Bar */}
      {isStreaming && <StreamingActivityBar messages={currentSession.messages} />}

      {/* Input Area */}
      <div className="p-4 shrink-0">
        <div className="max-w-3xl mx-auto">
          <CoworkPromptInput
            onSubmit={onContinue}
            onStop={onStop}
            isStreaming={isStreaming}
            placeholder={i18nService.t(remoteManaged ? 'coworkRemoteManagedPlaceholder' : 'coworkContinuePlaceholder')}
            disabled={remoteManaged}
            size="large"
            remoteManaged={remoteManaged}
            onManageSkills={remoteManaged ? undefined : onManageSkills}
            showModelSelector={!remoteManaged}
            sessionId={currentSession?.id}
          />
        </div>
      </div>
    </div>
  );
};

export default CoworkSessionDetail;
