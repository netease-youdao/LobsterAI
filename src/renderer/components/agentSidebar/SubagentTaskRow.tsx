import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { SubagentSessionSummary } from '../../types/cowork';
import Modal from '../common/Modal';
import LoadingIcon from '../icons/LoadingIcon';
import TrashIcon from '../icons/TrashIcon';

interface SubagentTaskRowProps {
  subagent: SubagentSessionSummary;
  isBatchMode?: boolean;
  isSelected?: boolean;
  onSelect: () => void;
  onDelete: () => Promise<void>;
  onToggleSelection?: () => void;
  onSidebarAction?: (actionType: string, params?: {
    isCurrentSubagent?: boolean;
    result?: 'success' | 'failed';
    subagentStatus?: string;
  }) => void;
  analyticsParams?: {
    isCurrentSubagent: boolean;
    subagentStatus: string;
  };
}

const formatDuration = (createdAt: number, endedAt: number | null): string => {
  const elapsed = Math.max(0, (endedAt ?? Date.now()) - createdAt);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const SubagentTaskRow: React.FC<SubagentTaskRowProps> = ({
  subagent,
  isBatchMode = false,
  isSelected = false,
  onSelect,
  onDelete,
  onToggleSelection,
  onSidebarAction,
  analyticsParams,
}) => {
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const displayName = subagent.label ?? subagent.agentId ?? i18nService.t('subagentUnnamed');
  const duration = formatDuration(
    subagent.createdAt,
    subagent.status === 'running' ? null : subagent.endedAt,
  );
  const handleRowClick = () => {
    if (isBatchMode) {
      onToggleSelection?.();
      return;
    }
    onSelect();
  };

  return (
    <>
      <div
        className={`group relative -ml-[6px] flex h-[26px] w-[calc(100%+12px)] cursor-pointer items-center gap-1.5 rounded-md ${
          isBatchMode ? 'pl-9' : 'pl-[52px]'
        } pr-2.5 text-[length:var(--lobster-text-sidebarCompact)] font-normal transition-colors ${
          isSelected
            ? 'bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.07]'
            : 'text-foreground/90 hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]'
        }`}
        onClick={handleRowClick}
        role="treeitem"
        aria-level={3}
        aria-selected={isSelected}
      >
        {isBatchMode && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(event) => {
              event.stopPropagation();
              onToggleSelection?.();
            }}
            onClick={(event) => event.stopPropagation()}
            className="h-3.5 w-3.5 shrink-0 rounded border-gray-300 accent-primary"
          />
        )}

        <span className="min-w-0 flex-1 truncate pr-5">
          {displayName}
        </span>

        {subagent.status === 'running' ? (
          <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center transition-opacity group-hover:opacity-0">
            <LoadingIcon className="h-3 w-3 animate-spin text-secondary" aria-hidden="true" />
          </span>
        ) : subagent.status === 'error' ? (
          <span className="shrink-0 whitespace-nowrap text-[11px] font-normal text-red-500/80 transition-opacity group-hover:opacity-0">
            {i18nService.t('subagentError') || 'Error'}
          </span>
        ) : (
          <span className="shrink-0 whitespace-nowrap text-[11px] font-normal text-foreground/45 transition-opacity group-hover:opacity-0">
            {duration}
          </span>
        )}

        {!isBatchMode && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSidebarAction?.('subagent_delete_confirm_open', analyticsParams);
              setShowConfirmDelete(true);
            }}
            className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-foreground opacity-0 transition-opacity hover:opacity-[0.46] group-hover:opacity-[0.3]"
            aria-label={i18nService.t('deleteSession')}
            title={i18nService.t('deleteSession')}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {showConfirmDelete && (
        <Modal
          onClose={() => setShowConfirmDelete(false)}
          className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
              <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {i18nService.t('deleteTaskConfirmTitle')}
            </h2>
          </div>
          <div className="px-5 pb-4">
            <p className="text-sm text-secondary">
              {i18nService.t('deleteTaskConfirmMessage')}
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
            <button
              type="button"
              onClick={() => {
                onSidebarAction?.('subagent_delete_cancel', analyticsParams);
                setShowConfirmDelete(false);
              }}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                onSidebarAction?.('subagent_delete_submit', analyticsParams);
                setShowConfirmDelete(false);
                void onDelete();
              }}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 text-white transition-colors hover:bg-red-600"
            >
              {i18nService.t('deleteSession')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
};

export default SubagentTaskRow;
