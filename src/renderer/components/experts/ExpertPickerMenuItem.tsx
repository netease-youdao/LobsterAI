import { ArrowUpRightIcon, CheckIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { ExpertUiEvent } from '@shared/agent/presets';
import { UsageEntry, UsageStage } from '@shared/analytics/usage';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { reportExpertJourney } from '../../services/usageAnalytics';
import type { RootState } from '../../store';
import { getAgentDisplayName, usesManagedPresetAvatar } from '../../utils/agentDisplay';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import { PROMPT_MENU_ROW_CLASS, PROMPT_SUBMENU_POSITION_CLASS, type PromptMenuItemControl, PromptSubmenuSide } from '../common/promptSubmenu';
import ExpertIcon from '../icons/ExpertIcon';
import SearchIcon from '../icons/SearchIcon';

interface ExpertPickerMenuItemProps {
  disabled?: boolean;
  menuItem: PromptMenuItemControl;
  onSelect: (agentId: string) => void;
  onExplore: () => void;
}

/** Kept inside the add-menu DOM so its existing outside-click handling applies. */
const ExpertPickerMenuItem: React.FC<ExpertPickerMenuItemProps> = ({ disabled, menuItem, onSelect, onExplore }) => {
  const [query, setQuery] = useState('');
  const [maxHeight, setMaxHeight] = useState<number>();
  const [maxListHeight, setMaxListHeight] = useState(180);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);
  const { agents, currentAgentId } = useSelector((state: RootState) => state.agent);
  const t = (key: string) => i18nService.t(key);
  const matching = agents.filter(agent => agent.enabled && `${getAgentDisplayName(agent)} ${agent.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const show = (focusSearch = false) => {
    if (disabled) return;
    if (!shownRef.current) {
      shownRef.current = true;
      reportExpertJourney(UsageStage.View, { entry: UsageEntry.Picker, installedCount: agents.filter(agent => agent.enabled).length });
    }
    menuItem.onOpenChange(true);
    if (focusSearch) requestAnimationFrame(() => searchRef.current?.focus());
  };

  useEffect(() => {
    if (!menuItem.open) {
      setQuery('');
      shownRef.current = false;
    }
  }, [menuItem.open]);

  useLayoutEffect(() => {
    if (!menuItem.open || !popoverRef.current) return;
    // The submenu grows upward from the add menu; keep its search and footer visible.
    setMaxHeight(Math.max(0, popoverRef.current.getBoundingClientRect().bottom - 16));
    if (buttonRef.current) {
      setMaxListHeight(Math.max(180, Math.min(300, buttonRef.current.getBoundingClientRect().bottom - 72)));
    }
  }, [menuItem.open, menuItem.side]);

  return (
    <>
      <button ref={buttonRef} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={menuItem.open} disabled={disabled}
        onMouseEnter={() => show()} onFocus={() => show()} onClick={() => show(true)}
        onKeyDown={event => {
          if (event.key === (menuItem.side === PromptSubmenuSide.Left ? 'ArrowLeft' : 'ArrowRight')) {
            event.preventDefault();
            show(true);
          }
        }}
        className={`${PROMPT_MENU_ROW_CLASS} ${menuItem.open ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`}>
        <ExpertIcon className="h-5 w-5 shrink-0 text-secondary" />
        <span className="min-w-0 flex-1 truncate">{t('expertSummonMenu')}</span><ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
      </button>
      {menuItem.open && (
        <div ref={popoverRef} role="menu" aria-label={t('expertInstalled')}
          style={{ maxHeight }}
          className={`${PROMPT_SUBMENU_POSITION_CLASS[menuItem.side]} z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-popover`}>
          <div className="shrink-0 border-b border-border px-3 py-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-secondary" />
              <input ref={searchRef} type="text" value={query} onChange={event => setQuery(event.target.value)}
                aria-label={t('expertSearchInstalled')} placeholder={t('expertSearchInstalled')}
                className="w-full rounded-md bg-transparent py-1.5 pl-8 pr-2 text-[13px] leading-5 text-foreground placeholder-secondary focus:bg-surface-raised/70 focus:outline-none" />
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto px-2 py-1.5" style={{ height: maxListHeight }}>
            <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold text-secondary">{t('expertInstalled')}</p>
            {matching.length === 0 ? <p className="px-3 py-5 text-center text-[13px] leading-5 text-secondary">{t('expertInstalledEmpty')}</p> : matching.map(agent => (
              <button key={agent.id} type="button" role="menuitemradio" aria-checked={agent.id === currentAgentId} onClick={() => onSelect(agent.id)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors focus:bg-surface-raised ${agent.id === currentAgentId ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`}>
                <AgentAvatarIcon value={agent.icon} expertFallback={usesManagedPresetAvatar(agent)} className="mt-[2px] h-[22px] w-[22px] shrink-0" iconClassName="h-4 w-4" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold leading-5 text-foreground" title={getAgentDisplayName(agent)}>{getAgentDisplayName(agent)}</div>
                  {agent.description && <p className="mt-0.5 truncate text-[12px] leading-4 text-secondary" title={agent.description}>{agent.description}</p>}
                </div>
                {agent.id === currentAgentId && <CheckIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            ))}
          </div>
          <div className="shrink-0 border-t border-border p-1.5">
            <button type="button" role="menuitem" onClick={() => { onExplore(); window.dispatchEvent(new Event(ExpertUiEvent.OpenPlaza)); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground">
              <ArrowUpRightIcon className="h-4 w-4 shrink-0" />{t('expertExploreMore')}
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default ExpertPickerMenuItem;
