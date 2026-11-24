import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import LoadingIcon from '../icons/LoadingIcon';
import SidebarFilterIcon from '../icons/SidebarFilterIcon';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';
import {
  SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME,
  SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME,
} from './sidebarHeaderTooltip';
import {
  DEFAULT_SIDEBAR_TASK_FILTER,
  EMPTY_SIDEBAR_TASK_STATUS_COUNTS,
  hasSidebarTaskAttention,
  isSidebarTaskFilterActive,
  SIDEBAR_TASK_STATUS_FILTER_OPTIONS,
  SIDEBAR_TASK_TIME_FILTER_OPTIONS,
  type SidebarTaskFilter,
  type SidebarTaskStatusCounts,
  SidebarTaskStatusFilter,
} from './taskFilter';
import {
  formatSidebarTaskStatusCount,
  getSidebarTaskFilterTooltip,
  getSidebarTaskStatusFilterLabel,
  getSidebarTaskTimeFilterLabel,
} from './taskFilterLabels';

// Shows the task filter entry in the sidebar agent section header.
export const SIDEBAR_TASK_FILTER_ENABLED: boolean = true;

const MENU_EDGE_GAP = 8;
const MENU_TRIGGER_GAP = 6;
// Keep in sync with the exit animation of `.sidebar-task-filter-menu` in index.css.
const MENU_EXIT_DURATION = 120;

const menuItemClassName =
  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40';

interface SidebarTaskFilterButtonProps {
  filter: SidebarTaskFilter;
  onChange: (filter: SidebarTaskFilter) => void;
  statusCounts?: SidebarTaskStatusCounts;
  label: string;
  className?: string;
  tooltipAlign?: TooltipAlign;
}

interface MenuOption {
  key: string;
  label: string;
  isSelected: boolean;
  hasAttention?: boolean;
  badge?: React.ReactNode;
  next: SidebarTaskFilter;
}

const renderStatusOptionBadge = (
  status: SidebarTaskStatusFilter,
  counts: SidebarTaskStatusCounts,
): { hasAttention: boolean; badge?: React.ReactNode } => {
  if (status === SidebarTaskStatusFilter.CompletedUnread && counts.completedUnread > 0) {
    return {
      hasAttention: true,
      badge: (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums text-primary">
          <span className="h-[6px] w-[6px] rounded-full bg-primary" aria-hidden="true" />
          {formatSidebarTaskStatusCount(counts.completedUnread)}
        </span>
      ),
    };
  }
  if (status === SidebarTaskStatusFilter.PendingPermission && counts.pendingPermission > 0) {
    return {
      hasAttention: true,
      badge: (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums text-primary">
          <span className="h-[6px] w-[6px] rounded-full bg-primary animate-pulse" aria-hidden="true" />
          {formatSidebarTaskStatusCount(counts.pendingPermission)}
        </span>
      ),
    };
  }
  if (status === SidebarTaskStatusFilter.Running && counts.running > 0) {
    return {
      hasAttention: false,
      badge: (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium leading-none tabular-nums text-secondary">
          <LoadingIcon className="h-3 w-3 animate-spin" aria-hidden="true" />
          {formatSidebarTaskStatusCount(counts.running)}
        </span>
      ),
    };
  }
  return { hasAttention: false };
};

const SidebarTaskFilterButton: React.FC<SidebarTaskFilterButtonProps> = ({
  filter,
  onChange,
  statusCounts = EMPTY_SIDEBAR_TASK_STATUS_COUNTS,
  label,
  className = '',
  tooltipAlign = TooltipAlign.End,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  // Stays true briefly after closing so the menu can play its exit animation.
  const [isMenuMounted, setIsMenuMounted] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  // Focus goes back to the trigger when the menu closes (Esc, Tab, Clear) so keyboard users keep
  // their place, but that is not a new keyboard step, so the focus ring stays hidden until the
  // trigger is used from the keyboard again or loses focus.
  const [isFocusRingSuppressed, setIsFocusRingSuppressed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const isActive = isSidebarTaskFilterActive(filter);
  const hasAttentionTasks = hasSidebarTaskAttention(statusCounts);
  const hasPendingPermission = statusCounts.pendingPermission > 0;
  const tooltipContent = getSidebarTaskFilterTooltip(label, filter, statusCounts);

  const statusOptions: MenuOption[] = SIDEBAR_TASK_STATUS_FILTER_OPTIONS.map((status) => {
    const { hasAttention, badge } = renderStatusOptionBadge(status, statusCounts);
    return {
      key: `status:${status}`,
      label: getSidebarTaskStatusFilterLabel(status),
      isSelected: filter.status === status,
      hasAttention,
      badge,
      next: { ...filter, status },
    };
  });
  const timeOptions: MenuOption[] = SIDEBAR_TASK_TIME_FILTER_OPTIONS.map(time => ({
    key: `time:${time}`,
    label: getSidebarTaskTimeFilterLabel(time),
    isSelected: filter.time === time,
    next: { ...filter, time },
  }));
  const allOptions = [...statusOptions, ...timeOptions];
  const allOptionsRef = useRef(allOptions);
  allOptionsRef.current = allOptions;

  useEffect(() => {
    if (isOpen) {
      setIsMenuMounted(true);
      return undefined;
    }
    const timer = setTimeout(() => setIsMenuMounted(false), MENU_EXIT_DURATION);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current;
    setPosition({
      top: Math.max(MENU_EDGE_GAP, Math.min(
        trigger.bottom + MENU_TRIGGER_GAP,
        window.innerHeight - menu.offsetHeight - MENU_EDGE_GAP,
      )),
      left: Math.max(MENU_EDGE_GAP, Math.min(
        trigger.left,
        window.innerWidth - menu.offsetWidth - MENU_EDGE_GAP,
      )),
    });
    // Focus the selected status only when the menu opens, not on every selection inside it.
    itemRefs.current.find((_, index) => allOptionsRef.current[index]?.isSelected)?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const dismissOutside = (event: Event) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const dismissMenu = () => setIsOpen(false);
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    window.addEventListener('blur', dismissMenu);
    window.addEventListener('resize', dismissMenu);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      window.removeEventListener('blur', dismissMenu);
      window.removeEventListener('resize', dismissMenu);
    };
  }, [isOpen]);

  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    setIsFocusRingSuppressed(true);
    triggerRef.current?.focus();
  };

  const renderGroup = (heading: string, options: MenuOption[], offset: number) => (
    <div role="group" aria-label={heading}>
      <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-secondary/70">{heading}</div>
      {options.map((option, index) => (
        <button
          key={option.key}
          ref={(node) => { itemRefs.current[offset + index] = node; }}
          type="button"
          role="menuitemradio"
          aria-checked={option.isSelected}
          tabIndex={-1}
          className={menuItemClassName}
          onClick={() => {
            onChange(option.next);
            closeAndFocusTrigger();
          }}
        >
          <span className={`min-w-0 flex-1 truncate ${option.hasAttention ? 'font-medium' : ''}`}>
            {option.label}
          </span>
          {option.badge}
          {option.isSelected && <CheckIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {/* Hidden while the menu is open so the bubble never covers it. */}
      <Tooltip
        className={`shrink-0 ${className}`}
        position={TooltipPosition.Bottom}
        align={tooltipAlign}
        delay={300}
        bubbleClassName={SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME}
        content={tooltipContent}
        disabled={isOpen}
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setIsOpen(open => !open)}
          onBlur={() => setIsFocusRingSuppressed(false)}
          onKeyDown={(event) => {
            setIsFocusRingSuppressed(false);
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIsOpen(true);
            } else if (event.key === 'Escape') {
              setIsOpen(false);
            }
          }}
          // Matches the size, colour, and hover of the sibling Create Agent button.
          className={`sidebar-filter-button relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            isActive
              ? 'bg-primary/10 text-primary'
              : isOpen
                ? 'bg-[var(--lobster-sidebar-item-hover)] text-foreground'
                : 'text-secondary hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground'
          } ${isFocusRingSuppressed ? 'focus:outline-none' : SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME} ${className}`}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-controls={isOpen ? menuId : undefined}
        >
          <SidebarFilterIcon className="h-4 w-4" isActive={isActive} />
          {hasAttentionTasks && (
            <span
              className={`absolute right-[3px] top-[3px] h-[6px] w-[6px] rounded-full bg-primary ${
                hasPendingPermission ? 'animate-pulse' : ''
              }`}
              aria-hidden="true"
            />
          )}
        </button>
      </Tooltip>
      {(isOpen || isMenuMounted) && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          aria-hidden={!isOpen}
          data-state={isOpen ? 'open' : 'closed'}
          className="sidebar-task-filter-menu non-draggable fixed z-[9999] w-52 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-surface p-1 text-foreground shadow-popover"
          style={position}
          onKeyDown={(event) => {
            const count = isActive ? allOptions.length + 1 : allOptions.length;
            const index = itemRefs.current.slice(0, count).findIndex(item => item === document.activeElement);
            let nextIndex: number;
            if (event.key === 'ArrowDown') nextIndex = index < 0 ? 0 : (index + 1) % count;
            else if (event.key === 'ArrowUp') nextIndex = index < 0 ? count - 1 : (index - 1 + count) % count;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = count - 1;
            else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocusTrigger();
              return;
            } else if (event.key === 'Tab') {
              closeAndFocusTrigger();
              return;
            } else return;
            event.preventDefault();
            itemRefs.current[nextIndex]?.focus();
          }}
        >
          {renderGroup(i18nService.t('sidebarFilterStatusHeading'), statusOptions, 0)}
          <div className="mx-1 my-1 border-t border-border" role="separator" />
          {renderGroup(i18nService.t('sidebarFilterTimeHeading'), timeOptions, statusOptions.length)}
          {isActive && (
            <>
              <div className="mx-1 my-1 border-t border-border" role="separator" />
              <button
                ref={(node) => { itemRefs.current[allOptions.length] = node; }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${menuItemClassName} text-secondary`}
                onClick={() => {
                  onChange(DEFAULT_SIDEBAR_TASK_FILTER);
                  closeAndFocusTrigger();
                }}
              >
                {i18nService.t('sidebarFilterClear')}
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
};

export default SidebarTaskFilterButton;
