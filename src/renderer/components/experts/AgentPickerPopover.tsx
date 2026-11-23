import { CheckIcon, ChevronRightIcon, PlusIcon } from '@heroicons/react/24/outline';
import { ExpertUiEvent } from '@shared/agent/presets';
import { UsageEntry, UsageStage } from '@shared/analytics/usage';
import { ENABLE_EXPERT_PLAZA_UI } from '@shared/featureFlags';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import { reportExpertJourney } from '../../services/usageAnalytics';
import type { RootState } from '../../store';
import { getAgentDisplayName, usesManagedPresetAvatar } from '../../utils/agentDisplay';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import SearchIcon from '../icons/SearchIcon';

export interface AgentPickerOption {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  iconCustomized?: boolean;
  enabled?: boolean;
  source?: RootState['agent']['agents'][number]['source'];
}

interface AgentPickerPopoverProps {
  isOpen: boolean;
  anchorRef: React.RefObject<HTMLElement>;
  agents: AgentPickerOption[];
  currentAgentId: string;
  narrow?: boolean;
  preferredPlacement?: 'top' | 'bottom';
  showExplorePlaza?: boolean;
  onSelect: (agentId: string) => void;
  onExplore?: () => void;
  onClose: () => void;
}

const POPOVER_MARGIN = 12;
const DESKTOP_POPOVER_WIDTH = 320;
const NARROW_POPOVER_WIDTH = 224;
const PREFERRED_MIN_HEIGHT = 260;

const AgentPickerPopover: React.FC<AgentPickerPopoverProps> = ({
  isOpen,
  anchorRef,
  agents,
  currentAgentId,
  narrow = false,
  preferredPlacement = 'top',
  showExplorePlaza = false,
  onSelect,
  onExplore,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null);
  const [maxListHeight, setMaxListHeight] = useState(260);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shownRef = useRef(false);

  const t = (key: string) => i18nService.t(key);
  const shouldShowSearch = !narrow;
  const shouldShowExplore = !narrow && showExplorePlaza && ENABLE_EXPERT_PLAZA_UI;

  const updatePosition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = narrow ? NARROW_POPOVER_WIDTH : DESKTOP_POPOVER_WIDTH;
    const clampedLeft = Math.max(
      POPOVER_MARGIN,
      Math.min(rect.left, window.innerWidth - width - POPOVER_MARGIN),
    );
    const spaceAbove = Math.max(0, rect.top - POPOVER_MARGIN - 6);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - POPOVER_MARGIN - 6);

    const openUpward = narrow
      || (preferredPlacement === 'top'
        ? spaceAbove >= PREFERRED_MIN_HEIGHT || spaceAbove >= spaceBelow
        : spaceBelow < PREFERRED_MIN_HEIGHT && spaceAbove > spaceBelow);
    const availableHeight = openUpward ? spaceAbove : spaceBelow;
    const chromeHeight = (shouldShowSearch ? 50 : 8) + (shouldShowExplore ? 52 : 8);
    const nextListHeight = Math.max(120, Math.min(narrow ? 220 : 280, availableHeight - chromeHeight));

    setMaxListHeight(nextListHeight);
    setPopoverStyle({
      position: 'fixed',
      left: clampedLeft,
      width,
      maxWidth: `calc(100vw - ${POPOVER_MARGIN * 2}px)`,
      maxHeight: Math.max(180, availableHeight),
      zIndex: 10000,
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + (narrow ? 8 : 6) }
        : { top: rect.bottom + 6 }),
    });
  }, [anchorRef, narrow, preferredPlacement, shouldShowExplore, shouldShowSearch]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      shownRef.current = false;
      return;
    }
    if (shouldShowExplore && !shownRef.current) {
      shownRef.current = true;
      reportExpertJourney(UsageStage.View, {
        entry: UsageEntry.Picker,
        installedCount: agents.length,
      });
    }
    if (shouldShowSearch) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [agents.length, isOpen, shouldShowExplore, shouldShowSearch]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        onClose();
        anchorRef.current?.focus();
      }
    };

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [anchorRef, isOpen, onClose, updatePosition]);

  if (!isOpen || !popoverStyle) return null;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matching = normalizedQuery
    ? agents.filter((agent) => (
      `${getAgentDisplayName(agent)} ${agent.description ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ))
    : agents;

  return createPortal(
    <div
      ref={popoverRef}
      role="menu"
      aria-label={t('coworkSelectAgent')}
      style={popoverStyle}
      className={`flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-popover ${
        narrow ? 'p-1' : ''
      }`}
    >
      {shouldShowSearch && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-secondary" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('expertSearchInstalled')}
              placeholder={t('expertSearchInstalled')}
              className="w-full rounded-md bg-transparent py-1.5 pl-8 pr-2 text-[13px] leading-5 text-foreground placeholder-secondary focus:bg-surface-raised/70 focus:outline-none"
            />
          </div>
        </div>
      )}

      <div
        className={`min-h-0 overflow-y-auto ${narrow ? '' : 'px-2 py-1.5'}`}
        style={{ maxHeight: maxListHeight }}
      >
        {!narrow && (
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold text-secondary">
            {t('expertInstalled')}
          </p>
        )}
        {matching.length === 0 ? (
          <p className="px-3 py-5 text-center text-[13px] leading-5 text-secondary">
            {t('expertInstalledEmpty')}
          </p>
        ) : (
          matching.map((agent) => {
            const isSelected = agent.id === currentAgentId;
            const displayName = getAgentDisplayName(agent);
            return (
              <button
                key={agent.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => onSelect(agent.id)}
                title={displayName}
                className={`flex w-full text-left text-foreground transition-colors ${
                  narrow
                    ? `items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 ${
                      isSelected ? 'bg-primary/[0.06]' : 'hover:bg-surface-raised'
                    }`
                    : `items-start gap-2.5 rounded-lg px-2.5 py-1.5 focus:bg-surface-raised ${
                      isSelected ? 'bg-surface-raised' : 'hover:bg-surface-raised'
                    }`
                }`}
              >
                <AgentAvatarIcon
                  value={agent.icon}
                  expertFallback={usesManagedPresetAvatar(agent)}
                  className={narrow ? 'h-3.5 w-3.5 shrink-0 text-secondary' : 'mt-[2px] h-[22px] w-[22px] shrink-0'}
                  iconClassName={narrow ? 'h-3.5 w-3.5' : 'h-4 w-4'}
                  inheritColor={narrow}
                />
                {narrow ? (
                  <span className="min-w-0 flex-1 truncate">{displayName}</span>
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold leading-5 text-foreground">
                      {displayName}
                    </div>
                    {agent.description && (
                      <p className="mt-0.5 truncate text-[12px] leading-4 text-secondary" title={agent.description}>
                        {agent.description}
                      </p>
                    )}
                  </div>
                )}
                {isSelected && (
                  <CheckIcon className={`${narrow ? 'h-3.5 w-3.5' : 'mt-1 h-3.5 w-3.5'} shrink-0 text-primary`} />
                )}
              </button>
            );
          })
        )}
      </div>

      {shouldShowExplore && (
        <div className="shrink-0 border-t border-border px-2 py-1.5">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onExplore?.();
              onClose();
              window.dispatchEvent(new Event(ExpertUiEvent.OpenPlaza));
            }}
            className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-raised focus:bg-surface-raised focus:outline-none"
          >
            <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border border-dashed border-border text-secondary transition-colors group-hover:border-primary/60 group-hover:text-primary group-focus:border-primary/60 group-focus:text-primary">
              <PlusIcon className="h-3.5 w-3.5" strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">
              {t('expertExploreMore')}
            </span>
            <span className="flex shrink-0 items-center gap-0.5 text-[12px] leading-4 text-secondary transition-colors group-hover:text-foreground group-focus:text-foreground">
              {t('expertPlaza')}
              <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-focus:translate-x-0.5" />
            </span>
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
};

export default AgentPickerPopover;
