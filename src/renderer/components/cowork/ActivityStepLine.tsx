import {
  ClipboardDocumentListIcon,
  ClockIcon,
  CommandLineIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  PhotoIcon,
  UserGroupIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import React from 'react';

import ComposeIcon from '../icons/ComposeIcon';
import { ActivityStepKind } from './constants';
import type { ActivityLiveDetail } from './messageDisplayUtils';

const STEP_ICONS: Record<
  Exclude<ActivityStepKind, typeof ActivityStepKind.Thinking>,
  React.ComponentType<{ className?: string }>
> = {
  [ActivityStepKind.Command]: CommandLineIcon,
  [ActivityStepKind.Read]: DocumentTextIcon,
  // The app's own compose icon (new task / new agent), so writing a file
  // looks like creating anything else in LobsterAI.
  [ActivityStepKind.Edit]: ComposeIcon,
  [ActivityStepKind.Search]: MagnifyingGlassIcon,
  [ActivityStepKind.Web]: GlobeAltIcon,
  [ActivityStepKind.Media]: PhotoIcon,
  [ActivityStepKind.Agent]: UserGroupIcon,
  [ActivityStepKind.Todo]: ClipboardDocumentListIcon,
  [ActivityStepKind.Schedule]: ClockIcon,
  [ActivityStepKind.Tool]: WrenchScrewdriverIcon,
};

// Icons are sized in em so they follow the user's UI font size; a line's
// text starts past its icon (1em of text-sm) and the 0.375rem gap.
const ICON_TEXT_INDENT_CLASS = 'pl-[calc(var(--lobster-text-sm)+0.375rem)]';

const hasStepIcon = (kind: ActivityStepKind | undefined): kind is Exclude<ActivityStepKind, typeof ActivityStepKind.Thinking> => (
  kind !== undefined && kind !== ActivityStepKind.Thinking
);

/**
 * One line of agent activity (WorkBuddy style): a light gray icon and
 * phrase that darkens on hover. The whole line toggles its detail, with no
 * arrow — most readers never open it, and the ones who do find it by hover.
 * Thinking lines, and lines that are not a step (the turn's duration line),
 * carry no icon.
 */
export const ActivityStepLine: React.FC<{
  kind?: ActivityStepKind;
  label: string;
  isLive?: boolean;
  hasError?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  /** Right after the label: diff stats, a running step's elapsed time. */
  trailing?: React.ReactNode;
}> = ({ kind, label, isLive = false, hasError = false, isExpanded, onToggle, trailing }) => {
  const Icon = hasStepIcon(kind) ? STEP_ICONS[kind] : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex max-w-full items-center gap-1.5 py-0.5 text-left text-sm text-muted transition-colors hover:text-secondary"
      aria-expanded={isExpanded}
      data-activity-step-kind={kind}
    >
      {Icon && (
        <span
          className={`flex flex-shrink-0 ${hasError ? 'text-red-500/80' : ''}`}
          aria-hidden="true"
          data-activity-step-error={hasError ? 'true' : undefined}
        >
          <Icon className="h-[1em] w-[1em]" />
        </span>
      )}
      {/* Live and settled labels are separate elements. Toggling the shimmer
          class on one span made its text color transition from transparent,
          so every step that finished blinked for 150ms. */}
      {isLive ? (
        <span key="live" data-activity-label="live" className="shimmer-text min-w-0 truncate">
          {label}
        </span>
      ) : (
        <span key="settled" data-activity-label="settled" className="min-w-0 truncate">
          {label}
        </span>
      )}
      {trailing}
    </button>
  );
};

/**
 * Muted preview under a live step line of what it is doing right now: the
 * tail of streaming reasoning, or the latest line a command printed.
 */
export const ActivityLiveDetailLine: React.FC<{
  detail: ActivityLiveDetail;
  kind?: ActivityStepKind;
}> = ({ detail, kind }) => (
  <div
    className={`mt-0.5 max-w-full text-xs leading-5 text-muted ${hasStepIcon(kind) ? ICON_TEXT_INDENT_CLASS : ''} ${
      detail.kind === 'reasoning' ? 'line-clamp-2 italic' : 'truncate font-mono'
    }`}
    aria-live="polite"
    data-activity-live-detail={detail.kind}
  >
    {detail.text}
  </div>
);
