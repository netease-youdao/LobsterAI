import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage, CoworkMessageMetadata, CoworkImageAttachment } from '../../types/cowork';
import type { Skill } from '../../types/skill';
import CoworkPromptInput from './CoworkPromptInput';
import MarkdownContent from '../MarkdownContent';
import {
  CheckIcon,
  ChevronRightIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline';
import { ShareIcon } from '@heroicons/react/20/solid';
import InformationCircleIcon from '../icons/InformationCircleIcon';
import ExclamationTriangleIcon from '../icons/ExclamationTriangleIcon';
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
import { getScheduledReminderDisplayText } from '../../../scheduledTask/reminderText';
import DiffView, { extractDiffFromToolInput } from './DiffView';

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
const NAV_SCROLL_LOCK_DURATION = 800;
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
        return 'bg-transparent border-border';
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
                ? 'text-muted'
                : 'text-foreground'
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

  // Check if this is an Edit/MultiEdit tool with diff data
  const diffDataList = useMemo(
    () => extractDiffFromToolInput(rawToolName, toolInput as Record<string, unknown> | undefined),
    [rawToolName, toolInput],
  );
  const isEditWithDiff = diffDataList !== null && diffDataList.length > 0;

  return (
    <div className="relative py-1">
      {/* Vertical connecting line to next tool group */}
      {!isLastInSequence && (
        <div className="absolute left-[3.5px] top-[14px] bottom-[-8px] w-px bg-border" />
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
            <span className="text-sm font-medium text-secondary">
              {toolName}
            </span>
            {toolInputSummary && (
              <code className="text-xs text-muted font-mono truncate max-w-[400px]">
                {toolInputSummary}
              </code>
            )}
          </div>
          {toolResult && !isTodoWriteTool && (hasToolResultText || showNoDetailError) && (
            <div className={`text-xs mt-0.5 ${
              hasToolResultText
                ? 'text-muted'
                : showNoDetailError
                  ? 'text-red-500/80'
                  : 'text-muted'
            }`}>
              {hasToolResultText
                ? (toolResultSummary ?? `${resultLineCount} ${resultLineCount === 1 ? 'line' : 'lines'} of output`)
                : toolResultFallback}
            </div>
          )}
          {!toolResult && (
            <div className="text-xs text-muted mt-0.5">
              {i18nService.t('coworkToolRunning')}
            </div>
          )}
        </div>
      </button>
      {isExpanded && (
        <div className="ml-4 mt-2">
          {isBashTool ? (
            // Terminal-style display for Bash commands
            <div className="rounded-lg overflow-hidden border border-border">
              {/* Terminal header */}
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surfaceInset">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                <span className="ml-2 text-[10px] text-secondary font-medium">Terminal</span>
              </div>
              {/* Terminal content */}
              <div className="bg-surface-inset px-3 py-3 max-h-72 overflow-y-auto font-mono text-xs">
                {toolInputDisplay && (
                  <div className="text-foreground">
                    <span className="text-primary select-none">$ </span>
                    <span className="whitespace-pre-wrap break-words">{toolInputDisplay}</span>
                  </div>
                )}
                {toolResult && (hasToolResultText || showNoDetailError) && (
                  <div className={`mt-1.5 whitespace-pre-wrap break-words ${
                    isToolError
                      ? 'text-red-400'
                      : hasToolResultText
                        ? 'text-secondary'
                        : 'text-muted italic'
                  }`}>
                    {displayToolResult}
                  </div>
                )}
                {!toolResult && (
                  <div className="text-muted mt-1.5 italic">
                    {i18nService.t('coworkToolRunning')}
                  </div>
                )}
              </div>
            </div>
          ) : isTodoWriteTool && todoItems ? (
            <TodoWriteInputView items={todoItems} />
          ) : isEditWithDiff && diffDataList ? (
            // Diff view for Edit/MultiEdit tools
            <div className="space-y-2">
              {diffDataList.map((diff, idx) => (
                <DiffView
                  key={idx}
                  oldStr={diff.oldStr}
                  newStr={diff.newStr}
                  filePath={diff.filePath}
                />
              ))}
              {toolResult && (hasToolResultText || showNoDetailError) && (
                <div>
                  <div className="text-[10px] font-medium dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolResult')}
                  </div>
                  <div className="max-h-32 overflow-y-auto">
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
          ) : (
            // Standard display for other tools with input/output labels
            <div className="space-y-2">
              {toolInputDisplay && (
                <div>
                  <div className="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolInput')}
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                      {toolInputDisplay}
                    </pre>
                  </div>
                </div>
              )}
              {toolResult && (hasToolResultText || showNoDetailError) && (
                <div>
                  <div className="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolResult')}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <pre className={`text-xs whitespace-pre-wrap break-words font-mono ${
                      isToolError
                        ? 'text-red-500'
                        : hasToolResultText
                          ? 'text-foreground'
                          : 'text-secondary italic'
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
      className={`p-1.5 rounded-md hover:bg-surface-raised transition-all duration-200 ${
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
              <div className="w-fit max-w-[42rem] rounded-2xl px-4 py-2.5 bg-surface text-foreground shadow-subtle">
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
                          className="max-h-48 max-w-[16rem] rounded-lg object-contain cursor-pointer border border-border hover:border-primary transition-colors"
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
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary-muted"
                    title={skill.description}
                  >
                    <PuzzleIcon className="h-2.5 w-2.5 text-primary" />
                    <span className="text-[10px] font-medium text-primary max-w-[60px] truncate">
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
      <div className="text-foreground">
        <MarkdownContent
          content={displayContent}
          className="prose dark:prose-invert max-w-none"
          resolveLocalFilePath={resolveLocalFilePath}
          showRevealInFolderAction
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
          <span className="text-xs text-secondary">
            {getStatusText()}
          </span>
        </div>
      </div>
    </div>
  );
};

const TypingDots: React.FC = () => (
  <div className="flex items-center space-x-1.5 py-1">
    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
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
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised transition-colors"
      >
        <ChevronRightIcon
          className={`h-3.5 w-3.5 text-secondary flex-shrink-0 transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
        <span className="text-xs font-medium text-secondary">
          {i18nService.t('reasoning')}
        </span>
        {isCurrentlyStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
        )}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 max-h-64 overflow-y-auto">
          <div className="text-xs leading-relaxed text-muted whitespace-pre-wrap">
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
    const isError = !hasText(message.content) && typeof message.metadata?.error === 'string';
    const rawContent = hasText(message.content)
      ? message.content
      : (typeof message.metadata?.error === 'string' ? message.metadata.error : '');
    const normalizedContent = getScheduledReminderDisplayText(rawContent) ?? rawContent;
    const content = mapDisplayText ? mapDisplayText(normalizedContent) : normalizedContent;
    if (!content.trim()) return null;

    return (
      <div className="rounded-lg border border-border bg-background px-3 py-2">
        <div className="flex items-center gap-2">
          {isError
            ? <ExclamationTriangleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
            : <InformationCircleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
          }
          <div className="text-xs whitespace-pre-wrap text-secondary">
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
            isToolError ? 'bg-red-500' : 'bg-surface-raised'
          }`} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-secondary">
              {i18nService.t('coworkToolResult')}
            </div>
            {resultLineCount > 0 && (
              <div className="text-xs text-muted mt-0.5">
                {resultLineCount} {resultLineCount === 1 ? 'line' : 'lines'} of output
              </div>
            )}
            {resultLineCount === 0 && showNoDetailError && (
              <div className={`text-xs mt-0.5 ${
                isToolError
                  ? 'text-red-500/80'
                  : 'text-muted'
              }`}>
                {fallbackText}
              </div>
            )}
            {(hasToolResultText || showNoDetailError) && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-surface-raised max-h-64 overflow-y-auto">
                <pre className={`text-xs whitespace-pre-wrap break-words font-mono ${
                  isToolError
                    ? 'text-red-500'
                    : hasToolResultText
                      ? 'text-foreground'
                      : 'text-secondary italic'
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

  // Rail navigation states
  const [currentRailIndex, setCurrentRailIndex] = useState(-1);
  const currentRailIndexRef = useRef(-1);
  const railItemCountRef = useRef(0);
  // Mapping: turnIndex → { first: firstRailIdx, last: lastRailIdx }
  const turnToRailRangeRef = useRef<{ first: number; last: number }[]>([]);
  const isNavigatingRef = useRef(false);
  const navigatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnElsCacheRef = useRef<HTMLElement[]>([]);
  const railLinesRef = useRef<HTMLDivElement>(null);
  const [isScrollable, setIsScrollable] = useState(false);
  const [hoveredRailIndex, setHoveredRailIndex] = useState<number | null>(null);
  const [isRailHovered, setIsRailHovered] = useState(false);
  const [railTooltip, setRailTooltip] = useState<{ label: string; top: number; right: number; isUser: boolean } | null>(null);

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
      if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    };
  }, []);

  // Reset nav state when session changes
  useEffect(() => {
    setIsScrollable(false);
    setCurrentRailIndex(-1);
    currentRailIndexRef.current = -1;
    isNavigatingRef.current = false;
    turnElsCacheRef.current = [];
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    setHoveredRailIndex(null);
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

    // Skip index recalculation during programmatic navigation
    if (isNavigatingRef.current) return;

    // Use turn-level elements (always in DOM, even for lazy-rendered turns) for scroll detection
    const turnEls = turnElsCacheRef.current;
    const railCount = railItemCountRef.current;
    if (turnEls.length === 0 || railCount === 0) return;

    // If at very bottom, snap to last rail item
    if (distanceToBottom <= NAV_BOTTOM_SNAP_THRESHOLD) {
      const lastRail = railCount - 1;
      if (currentRailIndexRef.current !== lastRail) {
        currentRailIndexRef.current = lastRail;
        setCurrentRailIndex(lastRail);
      }
      return;
    }

    // Find current turn based on turn element offsetTop
    const scrollTop = container.scrollTop;
    let currentTurn = 0;
    for (let i = 0; i < turnEls.length; i++) {
      if (turnEls[i].offsetTop <= scrollTop + 80) {
        currentTurn = i;
      } else {
        break;
      }
    }

    // Map turn to rail index: check if scrolled past the midpoint of the turn
    // (first half → user message = first rail item, second half → assistant = last rail item)
    const range = turnToRailRangeRef.current[currentTurn];
    if (!range) return;
    let railIdx = range.first;
    if (range.first !== range.last) {
      const turnEl = turnEls[currentTurn];
      const nextTurnTop = currentTurn + 1 < turnEls.length
        ? turnEls[currentTurn + 1].offsetTop
        : container.scrollHeight;
      const turnMid = turnEl.offsetTop + (nextTurnTop - turnEl.offsetTop) / 2;
      if (scrollTop + 80 >= turnMid) {
        railIdx = range.last;
      }
    }

    if (currentRailIndexRef.current !== railIdx) {
      currentRailIndexRef.current = railIdx;
      setCurrentRailIndex(railIdx);
    }
  }, []);

  const navigateToRailItem = useCallback((railIndex: number) => {
    if (railIndex < 0 || railIndex >= railItemCountRef.current) return;

    // Find the turn that contains this rail item
    const ranges = turnToRailRangeRef.current;
    let targetTurnIdx = -1;
    for (let t = 0; t < ranges.length; t++) {
      if (ranges[t] && railIndex >= ranges[t].first && railIndex <= ranges[t].last) {
        targetTurnIdx = t;
        break;
      }
    }

    isNavigatingRef.current = true;
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    navigatingTimerRef.current = setTimeout(() => { isNavigatingRef.current = false; }, NAV_SCROLL_LOCK_DURATION);

    // Try to scroll to the exact data-rail-index element if it's in the DOM
    const container = scrollContainerRef.current;
    if (container) {
      const el = container.querySelector<HTMLElement>(`[data-rail-index="${railIndex}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (targetTurnIdx >= 0) {
        // Fallback: scroll to the turn element (always in DOM)
        const turnEls = turnElsCacheRef.current;
        if (targetTurnIdx < turnEls.length) {
          turnEls[targetTurnIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }

    currentRailIndexRef.current = railIndex;
    setCurrentRailIndex(railIndex);
  }, []);
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

  // Cache turn-level DOM elements (data-turn-index, always in DOM even for lazy turns)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) { turnElsCacheRef.current = []; return; }
    turnElsCacheRef.current = Array.from(
      container.querySelectorAll<HTMLElement>('[data-turn-index]')
    );
  }, [turns]);

  // Sync rail index when turns change or rail first appears (isScrollable becomes true)
  useEffect(() => {
    // After turns/scrollable change, if rail index is uninitialized (-1) or out of bounds,
    // wait for next frame so render IIFE has updated railItemCountRef, then sync
    const frameId = requestAnimationFrame(() => {
      const count = railItemCountRef.current;
      if (count === 0) return;
      const idx = currentRailIndexRef.current;
      if (idx < 0 || idx >= count) {
        const resolved = count - 1;
        currentRailIndexRef.current = resolved;
        setCurrentRailIndex(resolved);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [turns, isScrollable]);

  // Scroll rail lines container to keep active item visible (without affecting page scroll)
  useEffect(() => {
    const container = railLinesRef.current;
    if (!container || currentRailIndex < 0) return;
    const activeEl = container.children[currentRailIndex] as HTMLElement | undefined;
    if (!activeEl) return;
    // Manual scroll calculation to avoid scrollIntoView bubbling to parent scrollable
    const elTop = activeEl.offsetTop;
    const elBottom = elTop + activeEl.offsetHeight;
    if (elTop < container.scrollTop) {
      container.scrollTop = elTop;
    } else if (elBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = elBottom - container.clientHeight;
    }
  }, [currentRailIndex]);

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
    // Sync rail index to last when auto-scrolled to bottom
    if (turns.length > 0) {
      // Use -1 when rail hasn't rendered yet (count is 0),
      // so the render IIFE resolvedRailIndex fallback picks the last item
      const lastRail = railItemCountRef.current > 0 ? railItemCountRef.current - 1 : -1;
      currentRailIndexRef.current = lastRail;
      setCurrentRailIndex(lastRail);
    }
  }, [currentSession?.messages?.length, lastMessageContent, isStreaming, shouldAutoScroll, turns.length]);


  if (!currentSession) {
    return null;
  }

  const renderConversationTurns = () => {
    let railCounter = 0;
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

      // Compute rail indices for user/assistant messages (must match rail IIFE logic)
      let asstContent = '';
      for (const item of turn.assistantItems) {
        if (item.type === 'assistant' && item.message?.content) {
          asstContent += item.message.content;
        }
      }
      const userRailIdx = turn.userMessage ? railCounter++ : -1;
      const asstRailIdx = asstContent ? railCounter++ : -1;

      return (
        <LazyRenderTurn key={turn.id} turnId={turn.id} alwaysRender={alwaysRender} data-turn-index={index}>
          {turn.userMessage && (
            <div data-export-role="user-message" {...(userRailIdx >= 0 ? { 'data-rail-index': userRailIdx } : undefined)}>
              <UserMessageItem message={turn.userMessage} skills={skills} />
            </div>
          )}
          {showAssistantBlock && (
            <div data-export-role="assistant-block" {...(asstRailIdx >= 0 ? { 'data-rail-index': asstRailIdx } : undefined)}>
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
    <div ref={detailRootRef} className="flex-1 flex flex-col bg-background h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border bg-surface shrink-0">
        {/* Left side: Toggle buttons (when collapsed) + Title */}
        <div className="flex h-full items-center gap-2 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
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
              className="non-draggable min-w-0 max-w-[300px] rounded-lg border border-border bg-background px-2 py-1 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          ) : (
            <h1 className="text-sm leading-none font-medium text-foreground truncate max-w-[360px]">
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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
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
            className="p-1.5 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
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
          className="fixed z-50 min-w-[180px] rounded-xl border border-border bg-surface shadow-popover popover-enter overflow-hidden"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          role="menu"
        >
          <button
            type="button"
            onClick={handleRenameClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-raised transition-colors"
          >
            <PencilSquareIcon className="h-4 w-4 text-secondary" />
            {i18nService.t('renameConversation')}
          </button>
          <button
            type="button"
            onClick={handleTogglePin}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-raised transition-colors"
          >
            <PushPinIcon
              slashed={currentSession.pinned}
              className={`h-[18px] w-[18px] text-secondary ${currentSession.pinned ? 'opacity-60' : ''}`}
            />
            {currentSession.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession')}
          </button>
          <button
            type="button"
            onClick={handleShareClick}
            disabled={isExportingImage}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ShareIcon className="h-4 w-4 text-secondary" />
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
            className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                {i18nService.t('deleteTaskConfirmTitle')}
              </h2>
            </div>

            {/* Content */}
            <div className="px-5 pb-4">
              <p className="text-sm text-secondary">
                {i18nService.t('deleteTaskConfirmMessage')}
              </p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
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
          className={`h-full min-h-0 overflow-y-auto pt-3 ${turns.length > 1 && isScrollable ? 'pr-8' : 'pr-3'}`}
        >
          {renderConversationTurns()}
          <div className="h-20" />
        </div>

        {/* Turn Navigation Rail — to the left of scrollbar */}
        {turns.length > 1 && isScrollable && (
          <div
            className="absolute right-[18px] top-1/2 -translate-y-1/2 w-5 flex flex-col items-end z-10"
            style={{ maxHeight: 'calc(100% - 40px)' }}
            onMouseEnter={() => setIsRailHovered(true)}
            onMouseLeave={() => {
              setIsRailHovered(false);
              setHoveredRailIndex(null);
              setRailTooltip(null);
            }}
          >
            {/* Up Arrow */}
            <button
              type="button"
              onClick={() => {
                const resolvedRail = currentRailIndex < 0 ? railItemCountRef.current - 1 : currentRailIndex;
                if (resolvedRail <= 0) return;
                navigateToRailItem(resolvedRail - 1);
              }}
              onMouseEnter={() => { setHoveredRailIndex(null); }}
              className={`shrink-0 flex items-center justify-center w-5 h-5 mb-2 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
                ${!isRailHovered
                  ? 'opacity-0 pointer-events-none'
                  : (currentRailIndex < 0 ? railItemCountRef.current - 1 : currentRailIndex) <= 0
                    ? 'opacity-30 cursor-default'
                    : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
            </button>

            {/* Message Lines */}
            <div
              ref={railLinesRef}
              className="overflow-y-auto min-h-0 flex-1"
              style={{ scrollbarWidth: 'none' }}
            >
            {(() => {
              // Build flat list of messages with their content length and turn index
              const MIN_W = 6;  // px
              const MAX_W = 16; // px
              // Strip common markdown syntax for tooltip display
              const stripMd = (s: string) => s
                .replace(/^#+\s+/gm, '')
                .replace(/```[\s\S]*?```/g, ' ')
                .replace(/`[^`]*`/g, ' ')
                .replace(/[*_~>]/g, '')
                .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
                .replace(/\s+/g, ' ')
                .trim();
              // Get first meaningful text snippet from content
              const getLabel = (content: string, fallback: string) => {
                const stripped = stripMd(content);
                return stripped.slice(0, 50) || fallback;
              };
              type RailItem = { key: string; turnIndex: number; label: string; contentLen: number; isUser: boolean };
              const items: RailItem[] = [];
              for (let i = 0; i < turns.length; i++) {
                const turn = turns[i];
                if (turn.userMessage) {
                  const content = turn.userMessage.content ?? '';
                  items.push({
                    key: `${turn.id}-user`,
                    turnIndex: i,
                    label: getLabel(content, `Turn ${i + 1}`),
                    contentLen: content.length,
                    isUser: true,
                  });
                }
                // Aggregate all assistant content into one line per turn
                let asstContent = '';
                for (const item of turn.assistantItems) {
                  if (item.type === 'assistant' && item.message?.content) {
                    asstContent += item.message.content;
                  }
                }
                if (asstContent) {
                  items.push({
                    key: `${turn.id}-asst`,
                    turnIndex: i,
                    label: getLabel(asstContent, 'LobsterAI'),
                    contentLen: asstContent.length,
                    isUser: false,
                  });
                }
              }
              const maxLen = items.reduce((acc, m) => Math.max(acc, m.contentLen), 1);
              // Sync rail item count and turn-to-rail mapping
              railItemCountRef.current = items.length;
              const rangeMap: { first: number; last: number }[] = [];
              for (let ri = 0; ri < items.length; ri++) {
                const ti = items[ri].turnIndex;
                if (!rangeMap[ti]) {
                  rangeMap[ti] = { first: ri, last: ri };
                } else {
                  rangeMap[ti].last = ri;
                }
              }
              turnToRailRangeRef.current = rangeMap;

              // Clamp rail index to valid range
              const resolvedRailIndex = currentRailIndex < 0 || currentRailIndex >= items.length
                ? items.length - 1
                : currentRailIndex;

              return items.map((msg, idx) => {
                const isActive = idx === resolvedRailIndex;
                const isHovered = idx === hoveredRailIndex;
                const ratio = msg.contentLen / maxLen;
                const lineW = Math.round(MIN_W + ratio * (MAX_W - MIN_W));
                return (
                  <button
                    key={msg.key}
                    type="button"
                    onClick={() => {
                      navigateToRailItem(idx);
                    }}
                    onMouseEnter={(e) => {
                      setHoveredRailIndex(idx);
                      const rect = e.currentTarget.getBoundingClientRect();
                      const top = Math.max(8, Math.min(rect.top + rect.height / 2, window.innerHeight - 8));
                      setRailTooltip({
                        label: msg.label,
                        top,
                        right: window.innerWidth - rect.left + 8,
                        isUser: msg.isUser,
                      });
                    }}
                    onMouseLeave={() => setRailTooltip(null)}
                    className="flex items-center justify-end cursor-pointer w-5 py-[5px]"
                  >
                    <div
                      className={`h-[2px] rounded-full transition-all ${
                        isActive || isHovered
                          ? 'bg-neutral-800 dark:bg-neutral-200'
                          : 'bg-neutral-300 dark:bg-neutral-600'
                      }`}
                      style={{ width: isActive || isHovered ? MAX_W : lineW }}
                    />
                  </button>
                );
              });
            })()}
            </div>

            {/* Down Arrow */}
            <button
              type="button"
              onClick={() => {
                const maxRail = railItemCountRef.current - 1;
                const resolvedRail = currentRailIndex < 0 ? maxRail : currentRailIndex;
                if (resolvedRail >= maxRail) return;
                navigateToRailItem(resolvedRail + 1);
              }}
              onMouseEnter={() => { setHoveredRailIndex(null); }}
              className={`shrink-0 flex items-center justify-center w-5 h-5 mt-2 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
                ${!isRailHovered
                  ? 'opacity-0 pointer-events-none'
                  : (currentRailIndex < 0 ? railItemCountRef.current - 1 : currentRailIndex) >= railItemCountRef.current - 1
                    ? 'opacity-30 cursor-default'
                    : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          </div>
        )}

        {/* Rail Tooltip — rendered via portal to escape transform context */}
        {railTooltip && createPortal(
          <div
            className={`fixed z-[100] px-3.5 py-2 text-[13px] leading-snug pointer-events-none overflow-hidden
              max-w-[240px] shadow-[0_2px_12px_rgba(0,0,0,0.12)]
              border dark:shadow-[0_2px_12px_rgba(0,0,0,0.4)]
              ${railTooltip.isUser
                ? 'rounded-[12px_12px_4px_12px] bg-white border-neutral-200/80 dark:bg-neutral-800 dark:border-neutral-700'
                : 'rounded-xl bg-neutral-50 border-neutral-200/80 dark:bg-neutral-800 dark:border-neutral-700'
              }`}
            style={{
              top: railTooltip.top,
              right: railTooltip.right,
              transform: 'translateY(-50%)',
            }}
          >
            {!railTooltip.isUser && (
              <div className="text-[12px] font-medium mb-0.5 text-neutral-800 dark:text-neutral-200">
                LobsterAI:
              </div>
            )}
            <div
              className="text-neutral-600 dark:text-neutral-300"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-all',
              }}
            >
              {railTooltip.label}
            </div>
          </div>,
          document.body
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
