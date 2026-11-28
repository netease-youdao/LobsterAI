import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import ClockIcon from '../icons/ClockIcon';
import FolderIcon from '../icons/FolderIcon';
import ForkBranchIcon from '../icons/ForkBranchIcon';
import { AgentSidebarIndicator } from './constants';
import {
  calculateTaskHoverCardPosition,
  formatTaskHoverUpdatedTime,
  formatTaskWorkspaceDisplay,
  TASK_HOVER_CARD_DEFAULT_HEIGHT,
  TASK_HOVER_CARD_SHOW_DELAY_MS,
  TASK_HOVER_CARD_WARM_DELAY_MS,
  TASK_HOVER_CARD_WARM_WINDOW_MS,
  TASK_HOVER_CARD_WIDTH,
  type TaskHoverCardAnchor,
} from './taskHoverCard';

const HOVER_CARD_SHOW_EVENT = 'lobster:agent-task-hover-card-show';

let lastHoverCardClosedAt = 0;
let activeHoverCardId: string | null = null;

export const getTaskHoverCardDelayMs = (): number => {
  if (activeHoverCardId !== null) {
    return TASK_HOVER_CARD_WARM_DELAY_MS;
  }
  if (lastHoverCardClosedAt > 0 && Date.now() - lastHoverCardClosedAt <= TASK_HOVER_CARD_WARM_WINDOW_MS) {
    return TASK_HOVER_CARD_WARM_DELAY_MS;
  }
  return TASK_HOVER_CARD_SHOW_DELAY_MS;
};

export const notifyTaskHoverCardOpened = (cardId: string): void => {
  activeHoverCardId = cardId;
  window.dispatchEvent(new CustomEvent<string>(HOVER_CARD_SHOW_EVENT, { detail: cardId }));
};

export const notifyTaskHoverCardClosed = (cardId: string): void => {
  if (activeHoverCardId === cardId) {
    activeHoverCardId = null;
    lastHoverCardClosedAt = Date.now();
  }
};

export const dismissAllTaskHoverCards = (): void => {
  activeHoverCardId = null;
  window.dispatchEvent(new CustomEvent<string>(HOVER_CARD_SHOW_EVENT, { detail: '' }));
};

export const subscribeOtherTaskHoverCardOpen = (
  cardId: string,
  onOtherOpen: () => void,
): (() => void) => {
  const handleShow = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== cardId) {
      onOtherOpen();
    }
  };
  window.addEventListener(HOVER_CARD_SHOW_EVENT, handleShow);
  return () => {
    window.removeEventListener(HOVER_CARD_SHOW_EVENT, handleShow);
  };
};

export interface AgentTaskHoverCardMeta {
  agentName: string;
  agentIcon?: React.ReactNode;
  agentWorkingDirectory?: string;
}

interface AgentTaskHoverCardProps {
  anchor: TaskHoverCardAnchor;
  title: string;
  timestamp: number;
  cwd?: string;
  forkGitBranch?: string | null;
  indicator: AgentSidebarIndicator;
  isScheduledTask: boolean;
  isExternalDshSession?: boolean;
  imPlatformLabel?: string | null;
  meta: AgentTaskHoverCardMeta;
}

const AgentTaskHoverCard: React.FC<AgentTaskHoverCardProps> = ({
  anchor,
  title,
  timestamp,
  cwd,
  forkGitBranch,
  indicator,
  isScheduledTask,
  isExternalDshSession = false,
  imPlatformLabel,
  meta,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState(TASK_HOVER_CARD_DEFAULT_HEIGHT);

  useLayoutEffect(() => {
    const height = cardRef.current?.getBoundingClientRect().height;
    if (height && Math.abs(height - measuredHeight) > 1) {
      setMeasuredHeight(height);
    }
  }, [anchor.rowTop, cwd, forkGitBranch, indicator, meta.agentName, measuredHeight, title]);

  if (typeof document === 'undefined') {
    return null;
  }

  const position = calculateTaskHoverCardPosition(
    anchor,
    { width: window.innerWidth, height: window.innerHeight },
    { width: TASK_HOVER_CARD_WIDTH, height: measuredHeight },
  );
  const workspace = formatTaskWorkspaceDisplay(cwd, meta.agentWorkingDirectory);
  const updatedLabel = formatTaskHoverUpdatedTime(timestamp);
  const statusLabel = indicator === AgentSidebarIndicator.PendingPermission
    ? i18nService.t('myAgentSidebarPendingPermission')
    : indicator === AgentSidebarIndicator.Running
      ? i18nService.t('myAgentSidebarRunning')
      : indicator === AgentSidebarIndicator.CompletedUnread
        ? i18nService.t('myAgentSidebarUnreadResult')
        : null;
  const sourceLabel = isScheduledTask
    ? i18nService.t('myAgentSidebarScheduledTask')
    : imPlatformLabel
      || (isExternalDshSession ? i18nService.t('myAgentSidebarExternalDshTask') : null);

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      className="pointer-events-none fixed z-[90] w-[276px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-surface px-3.5 py-2.5 text-foreground shadow-popover"
      style={{
        left: position.left,
        top: position.top,
      }}
    >
      <div className="line-clamp-2 break-words text-[13px] font-medium leading-[1.35] text-foreground">
        {title}
      </div>

      <div className="mt-2 space-y-1.5 text-[12px] leading-4 text-secondary">
        {meta.agentName && (
          <div className="flex min-w-0 items-center gap-2">
            {meta.agentIcon && (
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-secondary" aria-hidden="true">
                {meta.agentIcon}
              </span>
            )}
            <span className="min-w-0 truncate text-foreground/85">{meta.agentName}</span>
            {sourceLabel && (
              <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10.5px] leading-3 text-secondary">
                {sourceLabel}
              </span>
            )}
            {statusLabel && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] leading-3 ${
                  indicator === AgentSidebarIndicator.PendingPermission || indicator === AgentSidebarIndicator.CompletedUnread
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'bg-surface-raised text-secondary'
                }`}
              >
                {statusLabel}
              </span>
            )}
          </div>
        )}

        {workspace && (
          <div className="flex min-w-0 items-center gap-2">
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-secondary/85" />
            <span className="max-w-[52%] shrink-0 truncate text-foreground/80">
              {workspace.folderName}
            </span>
            {workspace.displayPath !== workspace.folderName && (
              <span className="min-w-0 flex-1 truncate text-[11px] text-secondary/70">
                {workspace.displayPath}
              </span>
            )}
          </div>
        )}

        {forkGitBranch && (
          <div className="flex min-w-0 items-center gap-2">
            <ForkBranchIcon className="h-3.5 w-3.5 shrink-0 text-secondary/85" />
            <span className="min-w-0 truncate">{forkGitBranch}</span>
          </div>
        )}

        <div className="flex min-w-0 items-center gap-2">
          <ClockIcon className="h-3.5 w-3.5 shrink-0 text-secondary/85" aria-hidden="true" />
          <span className="min-w-0 truncate tabular-nums">{updatedLabel}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AgentTaskHoverCard;
