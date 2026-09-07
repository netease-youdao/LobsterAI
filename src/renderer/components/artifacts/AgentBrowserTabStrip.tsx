import {
  ArrowPathIcon,
  GlobeAltIcon,
  PlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { AgentBrowserHostTab } from '@shared/browserWebAccess/constants';
import React, { useEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';

interface AgentBrowserTabStripProps {
  tabs: AgentBrowserHostTab[];
  selectedPageId?: number;
  disabled: boolean;
  onSelect: (pageId: number) => void;
  onClose: (pageId: number) => void;
  onCreate: () => void;
}

const AgentBrowserTabStrip: React.FC<AgentBrowserTabStripProps> = ({
  tabs,
  selectedPageId,
  disabled,
  onSelect,
  onClose,
  onCreate,
}) => {
  const selectedTabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedTabRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [selectedPageId]);

  return (
    <div className="flex h-9 shrink-0 items-end gap-1 border-b border-border bg-surface px-2 pt-1">
      <div
        role="tablist"
        className="scrollbar-hidden flex min-w-0 flex-1 items-end gap-1 overflow-x-auto overflow-y-hidden"
      >
        {tabs.map(tab => {
          const selected = tab.pageId === selectedPageId;
          const label = tab.title || tab.url || `#${tab.pageId}`;
          return (
            <div
              key={tab.pageId}
              ref={selected ? selectedTabRef : undefined}
              className={`group flex h-7 min-w-[112px] max-w-[200px] flex-none items-center gap-1 rounded-t-md border px-1.5 transition-colors ${
                selected
                  ? 'border-border border-b-background bg-background text-foreground'
                  : 'border-transparent text-secondary hover:bg-surface-raised hover:text-foreground'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                disabled={disabled}
                onClick={() => onSelect(tab.pageId)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs outline-none disabled:opacity-50"
                title={label}
              >
                {tab.loading ? (
                  <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <GlobeAltIcon className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate">{label}</span>
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onClose(tab.pageId)}
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/10 disabled:opacity-35 dark:hover:bg-white/10 ${
                  selected ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-70'
                }`}
                title={i18nService.t('agentBrowserCloseTab')}
                aria-label={i18nService.t('agentBrowserCloseTab')}
              >
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onCreate}
        className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-35"
        title={i18nService.t('agentBrowserNewTab')}
        aria-label={i18nService.t('agentBrowserNewTab')}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
    </div>
  );
};

export default AgentBrowserTabStrip;
