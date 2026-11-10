import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import SidebarFilterIcon from '../icons/SidebarFilterIcon';
import {
  DEFAULT_SIDEBAR_TASK_FILTER,
  isSidebarTaskFilterActive,
  SIDEBAR_TASK_STATUS_FILTER_OPTIONS,
  SIDEBAR_TASK_TIME_FILTER_OPTIONS,
  type SidebarTaskFilter,
} from './taskFilter';
import { getSidebarTaskStatusFilterLabel, getSidebarTaskTimeFilterLabel } from './taskFilterLabels';

// Shows the filter entry in both the macOS sidebar header and the Windows title bar.
export const SIDEBAR_TASK_FILTER_ENABLED: boolean = true;

const MENU_EDGE_GAP = 8;
const MENU_TRIGGER_GAP = 6;
// Keep in sync with the exit animation of `.sidebar-task-filter-menu` in index.css.
const MENU_EXIT_DURATION = 120;

const menuItemClassName =
  'flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 dark:hover:bg-white/[0.06]';

interface SidebarTaskFilterButtonProps {
  filter: SidebarTaskFilter;
  onChange: (filter: SidebarTaskFilter) => void;
  hasUnreadCompletedTasks: boolean;
  label: string;
  className?: string;
}

interface MenuOption {
  key: string;
  label: string;
  isSelected: boolean;
  next: SidebarTaskFilter;
}

const SidebarTaskFilterButton: React.FC<SidebarTaskFilterButtonProps> = ({
  filter,
  onChange,
  hasUnreadCompletedTasks,
  label,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  // Stays true briefly after closing so the menu can play its exit animation.
  const [isMenuMounted, setIsMenuMounted] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const isActive = isSidebarTaskFilterActive(filter);

  const statusOptions: MenuOption[] = SIDEBAR_TASK_STATUS_FILTER_OPTIONS.map(status => ({
    key: `status:${status}`,
    label: getSidebarTaskStatusFilterLabel(status),
    isSelected: filter.status === status,
    next: { ...filter, status },
  }));
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
          onClick={() => onChange(option.next)}
        >
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.isSelected && <CheckIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(open => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIsOpen(true);
          } else if (event.key === 'Escape') {
            setIsOpen(false);
          }
        }}
        className={`relative inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
          isActive || isOpen
            ? 'bg-blue-500/10 text-blue-500'
            : 'text-secondary hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
        } ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        title={label}
      >
        <SidebarFilterIcon className="h-4 w-4" />
        {hasUnreadCompletedTasks && (
          <span
            className="absolute right-1 top-1 h-[7px] w-[7px] rounded-full bg-blue-500"
            aria-hidden="true"
          />
        )}
      </button>
      {(isOpen || isMenuMounted) && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          aria-hidden={!isOpen}
          data-state={isOpen ? 'open' : 'closed'}
          className="sidebar-task-filter-menu non-draggable fixed z-[9999] w-48 max-w-[calc(100vw-16px)] rounded-2xl border border-border bg-surface p-1.5 text-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.16),0_4px_12px_-4px_rgba(0,0,0,0.06)]"
          style={position}
          onKeyDown={(event) => {
            const index = itemRefs.current.findIndex(item => item === document.activeElement);
            const count = allOptions.length;
            let nextIndex: number;
            if (event.key === 'ArrowDown') nextIndex = (index + 1) % count;
            else if (event.key === 'ArrowUp') nextIndex = (index - 1 + count) % count;
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
