import React, { useState, useMemo, useCallback } from 'react';
import { XMarkIcon, ChevronRightIcon, ChevronLeftIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { ConversationTurn } from './CoworkSessionDetail';
import { diffLines, type Change } from 'diff';

interface ToolOperation {
  id: string;
  toolName: string;
  displayName: string;
  filePath: string | null;
  status: 'running' | 'completed' | 'error';
  toolInput: Record<string, unknown>;
  toolResult: string | null;
  isError: boolean;
  oldStr: string | null;
  newStr: string | null;
  isNewFile: boolean;
}

interface ProgressPanelProps {
  turns: ConversationTurn[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string | null) => void;
  onClose: () => void;
  cwd?: string;
}

const normalizeToolName = (value: string): string => value.toLowerCase().replace(/[\s_]+/g, '');

const getDisplayName = (toolName: string): string => {
  const normalized = normalizeToolName(toolName);
  switch (normalized) {
    case 'write':
    case 'writefile':
      return 'Write';
    case 'edit':
    case 'editfile':
      return 'Edit';
    case 'multiedit':
      return 'MultiEdit';
    case 'read':
    case 'readfile':
      return 'Read';
    case 'bash':
    case 'exec':
    case 'shell':
      return 'Bash';
    case 'glob':
      return 'Glob';
    case 'grep':
      return 'Grep';
    case 'task':
      return 'Task';
    case 'todowrite':
      return 'TodoWrite';
    case 'webfetch':
      return 'WebFetch';
    default:
      return toolName;
  }
};

const isFileOperation = (toolName: string): boolean => {
  const normalized = normalizeToolName(toolName);
  return ['write', 'writefile', 'edit', 'editfile', 'multiedit'].includes(normalized);
};

const getToolInputString = (input: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const getFilePath = (input: Record<string, unknown>): string | null => {
  return getToolInputString(input, [
    'file_path', 'path', 'filePath', 'target_file', 'targetFile',
  ]);
};

const getOldStr = (input: Record<string, unknown>): string | null => {
  return getToolInputString(input, [
    'old_str', 'old_string', 'oldStr', 'old_text', 'oldText',
  ]);
};

const getNewStr = (input: Record<string, unknown>): string | null => {
  return getToolInputString(input, [
    'new_str', 'new_string', 'newStr', 'new_text', 'newText',
  ]);
};

const getFileContent = (input: Record<string, unknown>): string | null => {
  return getToolInputString(input, ['content', 'file_text', 'fileText']);
};

const truncateFilePath = (fullPath: string, cwd?: string): string => {
  if (!fullPath) return '';
  if (cwd && fullPath.startsWith(cwd)) {
    const relative = fullPath.slice(cwd.length).replace(/^\//, '');
    return relative || fullPath;
  }
  const parts = fullPath.split('/');
  if (parts.length <= 2) return fullPath;
  return '\u2026/' + parts.slice(-2).join('/');
};

const extractToolOpsFromTurn = (turn: ConversationTurn): ToolOperation[] => {
  const ops: ToolOperation[] = [];

  for (const item of turn.assistantItems) {
    if (item.type !== 'tool_group') continue;

    const toolUse = item.group.toolUse;
    const toolResult = item.group.toolResult;
    const toolName = typeof toolUse.metadata?.toolName === 'string' ? toolUse.metadata.toolName : 'unknown';
    const toolInput = (toolUse.metadata?.toolInput ?? {}) as Record<string, unknown>;
    const filePath = getFilePath(toolInput);
    const normalized = normalizeToolName(toolName);
    const isWrite = normalized === 'write' || normalized === 'writefile';
    const isEdit = normalized === 'edit' || normalized === 'editfile' || normalized === 'multiedit';

    let status: ToolOperation['status'] = 'running';
    let isError = false;
    let toolResultText: string | null = null;

    if (toolResult) {
      isError = Boolean(toolResult.metadata?.isError || toolResult.metadata?.error);
      status = isError ? 'error' : 'completed';
      toolResultText = toolResult.content || (typeof toolResult.metadata?.toolResult === 'string' ? toolResult.metadata.toolResult : null);
    }

    ops.push({
      id: toolUse.id,
      toolName,
      displayName: getDisplayName(toolName),
      filePath,
      status,
      toolInput,
      toolResult: toolResultText,
      isError,
      oldStr: isEdit ? getOldStr(toolInput) : null,
      newStr: isEdit ? getNewStr(toolInput) : (isWrite ? getFileContent(toolInput) : null),
      isNewFile: isWrite,
    });
  }

  return ops;
};

const getTurnLabel = (turn: ConversationTurn, index: number): string => {
  if (turn.userMessage?.content) {
    const text = turn.userMessage.content
      .replace(/^#+\s+/gm, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/[*_~>]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.slice(0, 40) + (text.length > 40 ? '…' : '');
  }
  return `Turn ${index + 1}`;
};

const hasToolGroups = (turn: ConversationTurn): boolean =>
  turn.assistantItems.some(item => item.type === 'tool_group');

const StatusDot: React.FC<{ status: 'running' | 'completed' | 'error' }> = ({ status }) => (
  <span className={`flex-shrink-0 w-2 h-2 rounded-full ${
    status === 'running'
      ? 'bg-blue-500 animate-pulse'
      : status === 'error'
        ? 'bg-red-500'
        : 'bg-green-500'
  }`} />
);

const DiffView: React.FC<{
  oldStr: string | null;
  newStr: string | null;
  isNewFile: boolean;
}> = ({ oldStr, newStr, isNewFile }) => {
  const changes = useMemo((): Change[] => {
    if (isNewFile && newStr) {
      return [{ value: newStr, added: true, removed: false, count: newStr.split('\n').length }];
    }
    if (oldStr !== null && newStr !== null) {
      return diffLines(oldStr, newStr);
    }
    return [];
  }, [oldStr, newStr, isNewFile]);

  if (changes.length === 0) return null;

  return (
    <div className="mt-2 rounded-lg overflow-hidden border dark:border-claude-darkBorder/50 border-claude-border/50 text-xs font-mono">
      <div className="max-h-64 overflow-y-auto">
        {changes.map((change, i) => {
          const lines = change.value.replace(/\n$/, '').split('\n');
          return lines.map((line, j) => (
            <div
              key={`${i}-${j}`}
              className={`px-3 py-0.5 whitespace-pre-wrap break-all ${
                change.added
                  ? 'bg-green-500/15 dark:bg-green-500/10 text-green-800 dark:text-green-300'
                  : change.removed
                    ? 'bg-red-500/15 dark:bg-red-500/10 text-red-800 dark:text-red-300'
                    : 'dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70'
              }`}
            >
              <span className="select-none mr-2 opacity-50">
                {change.added ? '+' : change.removed ? '-' : ' '}
              </span>
              {line || ' '}
            </div>
          ));
        })}
      </div>
    </div>
  );
};

const ToolOperationItem: React.FC<{
  operation: ToolOperation;
  cwd?: string;
}> = ({ operation, cwd }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasFileOp = isFileOperation(operation.toolName);
  const hasDiff = hasFileOp && (operation.isNewFile || (operation.oldStr !== null && operation.newStr !== null));

  return (
    <div className="border-b dark:border-claude-darkBorder/30 border-claude-border/30 last:border-b-0">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 transition-colors"
      >
        <ChevronRightIcon
          className={`h-3 w-3 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform duration-150 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
        <StatusDot status={operation.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
              {operation.displayName}
            </span>
            {operation.filePath && (
              <span className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 truncate">
                {truncateFilePath(operation.filePath, cwd)}
              </span>
            )}
          </div>
        </div>
        {hasDiff && (
          <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-green-500" title={i18nService.t('progressPanelHasDiff')} />
        )}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3">
          {hasDiff ? (
            <DiffView
              oldStr={operation.oldStr}
              newStr={operation.newStr}
              isNewFile={operation.isNewFile}
            />
          ) : (
            <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {operation.status === 'running'
                ? i18nService.t('coworkToolRunning')
                : operation.isError
                  ? (operation.toolResult || i18nService.t('coworkToolNoErrorDetail'))
                  : i18nService.t('progressPanelNoDiff')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ProgressPanel: React.FC<ProgressPanelProps> = ({ turns, selectedTurnId, onSelectTurn, onClose, cwd }) => {
  const turnsWithTools = useMemo(() =>
    turns
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn }) => hasToolGroups(turn)),
    [turns]
  );

  const resolvedTurnId = useMemo(() => {
    if (selectedTurnId !== null) {
      const found = turnsWithTools.find(({ turn }) => turn.id === selectedTurnId);
      if (found) return selectedTurnId;
    }
    if (turnsWithTools.length > 0) {
      return turnsWithTools[turnsWithTools.length - 1].turn.id;
    }
    return null;
  }, [selectedTurnId, turnsWithTools]);

  const currentTurnEntry = useMemo(() =>
    turnsWithTools.find(({ turn }) => turn.id === resolvedTurnId) ?? null,
    [turnsWithTools, resolvedTurnId]
  );

  const currentIndexInFiltered = useMemo(() =>
    turnsWithTools.findIndex(({ turn }) => turn.id === resolvedTurnId),
    [turnsWithTools, resolvedTurnId]
  );

  const operations = useMemo((): ToolOperation[] =>
    currentTurnEntry ? extractToolOpsFromTurn(currentTurnEntry.turn) : [],
    [currentTurnEntry]
  );

  const navigateTurn = useCallback((direction: -1 | 1) => {
    const nextIdx = currentIndexInFiltered + direction;
    if (nextIdx >= 0 && nextIdx < turnsWithTools.length) {
      onSelectTurn(turnsWithTools[nextIdx].turn.id);
    }
  }, [currentIndexInFiltered, turnsWithTools, onSelectTurn]);

  const turnLabel = currentTurnEntry
    ? getTurnLabel(currentTurnEntry.turn, currentTurnEntry.index)
    : '';

  return (
    <div className="w-[380px] shrink-0 flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg border-l dark:border-claude-darkBorder border-claude-border">
      <div className="flex items-center justify-between px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('progressPanelTitle')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      {turnsWithTools.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b dark:border-claude-darkBorder/50 border-claude-border/50 shrink-0">
          <button
            type="button"
            onClick={() => navigateTurn(-1)}
            disabled={currentIndexInFiltered <= 0}
            className="p-0.5 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
          </button>
          <span className="flex-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate text-center">
            {currentIndexInFiltered + 1}/{turnsWithTools.length} · {turnLabel}
          </span>
          <button
            type="button"
            onClick={() => navigateTurn(1)}
            disabled={currentIndexInFiltered >= turnsWithTools.length - 1}
            className="p-0.5 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {operations.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <span className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {i18nService.t('progressPanelEmpty')}
            </span>
          </div>
        ) : (
          <div>
            {operations.map((op) => (
              <ToolOperationItem key={op.id} operation={op} cwd={cwd} />
            ))}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t dark:border-claude-darkBorder/50 border-claude-border/50 shrink-0">
        <div className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
          {operations.length} {i18nService.t('progressPanelTotalOps')}
        </div>
      </div>
    </div>
  );
};

export default ProgressPanel;
