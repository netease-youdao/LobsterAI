import {
  ChatBubbleLeftIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../../services/i18n';

interface SelectedTextActionToolbarProps {
  left: number;
  top: number;
  onAddToChat: () => void;
  onAskInSideChat: () => void;
}

const SelectedTextActionToolbar: React.FC<SelectedTextActionToolbarProps> = ({
  left,
  top,
  onAddToChat,
  onAskInSideChat,
}) => (
  <div
    data-cowork-selected-text-action
    className="absolute z-40 inline-flex max-w-[calc(100%_-_1rem)] -translate-x-1/2 items-center overflow-hidden rounded-full border border-border bg-surface shadow-popover"
    style={{ left, top }}
  >
    <button
      type="button"
      onClick={onAddToChat}
      className="inline-flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
    >
      <ChatBubbleLeftIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
      <span className="truncate whitespace-nowrap">
        {i18nService.t('coworkSelectedTextAddToChat')}
      </span>
    </button>
    <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
    <button
      type="button"
      onClick={onAskInSideChat}
      className="inline-flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
    >
      <QuestionMarkCircleIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
      <span className="truncate whitespace-nowrap">
        {i18nService.t('coworkSelectedTextAskInSideChat')}
      </span>
    </button>
  </div>
);

export default SelectedTextActionToolbar;
