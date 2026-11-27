import { CheckIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../services/i18n';
import { MainView } from '../types/navigation';
import SidebarKitsIcon from './icons/SidebarKitsIcon';
import SidebarMcpIcon from './icons/SidebarMcpIcon';
import SkillIcon from './icons/SkillIcon';

const menuItems = [
  { view: MainView.Kits, label: 'kits', Icon: SidebarKitsIcon },
  { view: MainView.Skills, label: 'skills', Icon: SkillIcon },
  { view: MainView.Connectors, label: 'connectors', Icon: SidebarMcpIcon },
] as const;
const MENU_EDGE_GAP = 8;
const HOVER_CLOSE_DELAY = 180;
// Keep in sync with the exit animation of `.sidebar-capabilities-menu` in index.css.
const MENU_EXIT_DURATION = 120;
const menuItemClassName =
  'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[length:var(--lobster-text-sidebarCompact)] text-foreground transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40';
const selectedMenuItemClassName = `${menuItemClassName} bg-surface-raised font-medium`;

type CapabilityView = typeof menuItems[number]['view'];

interface SidebarCapabilitiesMenuProps {
  activeView: MainView;
  isCollapsed: boolean;
  onSelect: (view: CapabilityView) => void;
  className: string;
  activeClassName: string;
  iconClassName: string;
  activeIconClassName?: string;
}

const SidebarCapabilitiesMenu: React.FC<SidebarCapabilitiesMenuProps> = ({
  activeView,
  isCollapsed,
  onSelect,
  className,
  activeClassName,
  iconClassName,
  activeIconClassName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  // Stays true briefly after closing so the menu can play its exit animation.
  const [isMenuMounted, setIsMenuMounted] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const selectedIndex = menuItems.findIndex(item => item.view === activeView);
  const isActive = selectedIndex !== -1;

  useEffect(() => {
    // Entering Kits from the sidebar should keep its newly opened menu visible.
    if (!isActive || isCollapsed) setIsOpen(false);
  }, [isActive, isCollapsed]);

  useEffect(() => {
    if (isOpen) {
      setIsMenuMounted(true);
      return;
    }
    const timer = setTimeout(() => setIsMenuMounted(false), MENU_EXIT_DURATION);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    // Layout sizes ignore the entry animation's transform.
    const menu = menuRef.current;
    const firstItem = itemRefs.current[0];
    // Line the first item up with the trigger so the menu reads as its continuation.
    const firstItemCenter = firstItem
      ? menu.clientTop + firstItem.offsetTop + firstItem.offsetHeight / 2
      : 0;
    setPosition({
      top: Math.max(MENU_EDGE_GAP, Math.min(
        trigger.top + trigger.height / 2 - firstItemCenter,
        window.innerHeight - menu.offsetHeight - MENU_EDGE_GAP,
      )),
      left: Math.max(MENU_EDGE_GAP, Math.min(
        trigger.right + MENU_EDGE_GAP,
        window.innerWidth - menu.offsetWidth - MENU_EDGE_GAP,
      )),
    });
    itemRefs.current[Math.max(0, selectedIndex)]?.focus();
  }, [isOpen, selectedIndex]);

  useEffect(() => {
    if (!isOpen) return;
    let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelHoverClose = () => {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    };
    const isInsideMenu = (target: Node) => (
      triggerRef.current?.contains(target) || menuRef.current?.contains(target)
    );
    const dismissOutside = (event: Event) => {
      if (isInsideMenu(event.target as Node)) return;
      setIsOpen(false);
    };
    const dismissOnPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (isInsideMenu(event.target as Node)) {
        cancelHoverClose();
      } else if (hoverCloseTimer === undefined) {
        // Allow crossing the gap between the trigger and its portaled menu.
        hoverCloseTimer = setTimeout(() => setIsOpen(false), HOVER_CLOSE_DELAY);
      }
    };
    const dismissMenu = () => setIsOpen(false);
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('pointermove', dismissOnPointerMove);
    document.addEventListener('pointerleave', dismissMenu);
    window.addEventListener('blur', dismissMenu);
    window.addEventListener('resize', dismissMenu);
    window.addEventListener('scroll', dismissMenu, true);
    return () => {
      cancelHoverClose();
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('pointermove', dismissOnPointerMove);
      document.removeEventListener('pointerleave', dismissMenu);
      window.removeEventListener('blur', dismissMenu);
      window.removeEventListener('resize', dismissMenu);
      window.removeEventListener('scroll', dismissMenu, true);
    };
  }, [isOpen]);

  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const openKitsMenu = () => {
    onSelect(MainView.Kits);
    setIsOpen(true);
    itemRefs.current[0]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-current={isActive ? 'page' : undefined}
        title={i18nService.t('skillsAndConnectors')}
        className={isActive || isOpen ? activeClassName : className}
        onClick={openKitsMenu}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault();
            openKitsMenu();
          } else if (event.key === 'Escape') {
            setIsOpen(false);
          }
        }}
      >
        <SidebarKitsIcon className={isActive || isOpen ? (activeIconClassName ?? iconClassName) : iconClassName} />
        <span className="min-w-0 flex-1 truncate">{i18nService.t('skillsAndConnectors')}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-secondary transition-all duration-150 ${
            isOpen
              ? 'translate-x-0.5 opacity-100'
              : 'opacity-0 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100'
          }`}
        />
      </button>
      {(isOpen || isMenuMounted) && !isCollapsed && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={i18nService.t('skillsAndConnectors')}
          aria-hidden={!isOpen}
          data-state={isOpen ? 'open' : 'closed'}
          className="sidebar-capabilities-menu non-draggable fixed z-[9999] w-44 max-w-[calc(100vw-16px)] space-y-0.5 rounded-xl border border-border bg-surface p-1 text-foreground shadow-popover"
          style={position}
          onKeyDown={(event) => {
            const index = itemRefs.current.findIndex(item => item === document.activeElement);
            let nextIndex: number;
            if (event.key === 'ArrowDown') nextIndex = (index + 1) % menuItems.length;
            else if (event.key === 'ArrowUp') nextIndex = (index - 1 + menuItems.length) % menuItems.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = menuItems.length - 1;
            else if (event.key === 'Escape' || event.key === 'ArrowLeft') {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocusTrigger();
              return;
            } else if (event.key === 'Tab') {
              // Resume the sidebar's natural tab order across the portal.
              closeAndFocusTrigger();
              return;
            } else return;
            event.preventDefault();
            itemRefs.current[nextIndex]?.focus();
          }}
        >
          {menuItems.map(({ view, label, Icon }, index) => {
            const isSelected = activeView === view;
            return (
              <button
                key={view}
                ref={(element) => { itemRefs.current[index] = element; }}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                tabIndex={-1}
                onClick={() => {
                  closeAndFocusTrigger();
                  onSelect(view);
                }}
                className={isSelected ? selectedMenuItemClassName : menuItemClassName}
              >
                <Icon className={iconClassName} />
                <span className="min-w-0 flex-1 truncate">{i18nService.t(label)}</span>
                <CheckIcon
                  aria-hidden="true"
                  className={`h-4 w-4 shrink-0 text-primary ${isSelected ? '' : 'invisible'}`}
                />
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
};

export default SidebarCapabilitiesMenu;
