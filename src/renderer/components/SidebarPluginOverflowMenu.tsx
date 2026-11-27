import { CheckIcon, ChevronRightIcon, PuzzlePieceIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../services/i18n';
import { MainView } from '../types/navigation';
import {
  getDshPluginPanelKey,
  type SidebarPluginPanelItem,
} from './dsh/pluginViewModel';
import SidebarPluginsMoreIcon from './icons/SidebarPluginsMoreIcon';

const MENU_EDGE_GAP = 8;
// Keep in sync with the exit animation of `.sidebar-capabilities-menu` in index.css.
const MENU_EXIT_DURATION = 120;
const menuItemClassName =
  'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[length:var(--lobster-text-sidebarCompact)] text-foreground transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40';
const selectedMenuItemClassName = `${menuItemClassName} bg-surface-raised font-medium`;

interface SidebarPluginOverflowMenuProps {
  panels: readonly SidebarPluginPanelItem[];
  activeView: MainView;
  activePluginPanelKey?: string | null;
  isCollapsed: boolean;
  onSelect: (panel: SidebarPluginPanelItem) => void;
  className: string;
  activeClassName: string;
  iconClassName: string;
  activeIconClassName?: string;
}

const SidebarPluginOverflowMenu: React.FC<SidebarPluginOverflowMenuProps> = ({
  panels,
  activeView,
  activePluginPanelKey,
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
  const focusItemOnOpenRef = useRef(false);
  const menuId = useId();
  const selectedIndex =
    activeView === MainView.PluginPanel && activePluginPanelKey
      ? panels.findIndex((panel) => getDshPluginPanelKey(panel) === activePluginPanelKey)
      : -1;
  const isActive = selectedIndex !== -1;

  itemRefs.current.length = panels.length;

  useEffect(() => {
    if (isCollapsed || panels.length === 0) {
      setIsOpen(false);
    }
  }, [isCollapsed, panels.length]);

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
    if (focusItemOnOpenRef.current) {
      focusItemOnOpenRef.current = false;
      itemRefs.current[Math.max(0, selectedIndex)]?.focus();
    } else {
      menu.focus({ preventScroll: true });
    }
  }, [isOpen, panels.length, selectedIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const isInsideMenu = (target: EventTarget | null) => (
      target instanceof Node
      && (Boolean(triggerRef.current?.contains(target)) || Boolean(menuRef.current?.contains(target)))
    );
    const dismissOutside = (event: Event) => {
      if (isInsideMenu(event.target)) return;
      setIsOpen(false);
    };
    const dismissOnExternalScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setIsOpen(false);
    };
    const dismissMenu = () => setIsOpen(false);
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    window.addEventListener('blur', dismissMenu);
    window.addEventListener('resize', dismissMenu);
    window.addEventListener('scroll', dismissOnExternalScroll, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      window.removeEventListener('blur', dismissMenu);
      window.removeEventListener('resize', dismissMenu);
      window.removeEventListener('scroll', dismissOnExternalScroll, true);
    };
  }, [isOpen]);

  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const openMenuForKeyboard = () => {
    focusItemOnOpenRef.current = true;
    setIsOpen(true);
    if (isOpen) {
      itemRefs.current[Math.max(0, selectedIndex)]?.focus();
    }
  };

  const moreLabel = i18nService.t('more');
  const morePluginsLabel = i18nService.t('sidebarMorePlugins');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-current={isActive ? 'page' : undefined}
        title={morePluginsLabel}
        className={isActive || isOpen ? activeClassName : className}
        onClick={() => {
          focusItemOnOpenRef.current = false;
          setIsOpen((prev) => !prev);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault();
            openMenuForKeyboard();
          } else if (event.key === 'Escape') {
            setIsOpen(false);
          }
        }}
      >
        <SidebarPluginsMoreIcon
          className={isActive || isOpen ? (activeIconClassName ?? iconClassName) : iconClassName}
        />
        <span className="min-w-0 flex-1 truncate">{moreLabel}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-secondary transition-all duration-150 ${
            isOpen
              ? 'translate-x-0.5 opacity-100'
              : 'opacity-0 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100'
          }`}
        />
      </button>
      {(isOpen || isMenuMounted) && !isCollapsed && panels.length > 0 && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={morePluginsLabel}
          aria-hidden={!isOpen}
          data-state={isOpen ? 'open' : 'closed'}
          className="sidebar-capabilities-menu non-draggable fixed z-[9999] max-h-[min(320px,calc(100vh-16px))] w-56 max-w-[calc(100vw-16px)] space-y-0.5 overflow-y-auto rounded-xl border border-border bg-surface p-1 text-foreground shadow-popover focus:outline-none"
          style={position}
          onKeyDown={(event) => {
            if (panels.length === 0) return;
            const index = itemRefs.current.findIndex((item) => item === document.activeElement);
            let nextIndex: number;
            if (event.key === 'ArrowDown') {
              nextIndex = index === -1 ? 0 : (index + 1) % panels.length;
            } else if (event.key === 'ArrowUp') {
              nextIndex = index === -1 ? panels.length - 1 : (index - 1 + panels.length) % panels.length;
            } else if (event.key === 'Home') {
              nextIndex = 0;
            } else if (event.key === 'End') {
              nextIndex = panels.length - 1;
            } else if (event.key === 'Escape' || event.key === 'ArrowLeft') {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocusTrigger();
              return;
            } else if (event.key === 'Tab') {
              // Resume the sidebar's natural tab order across the portal.
              closeAndFocusTrigger();
              return;
            } else {
              return;
            }
            event.preventDefault();
            itemRefs.current[nextIndex]?.focus();
          }}
        >
          {panels.map((panel, index) => {
            const panelKey = getDshPluginPanelKey(panel);
            const isSelected = activeView === MainView.PluginPanel && activePluginPanelKey === panelKey;
            return (
              <button
                key={panelKey}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                tabIndex={-1}
                title={panel.title}
                onClick={() => {
                  setIsOpen(false);
                  onSelect(panel);
                }}
                className={isSelected ? selectedMenuItemClassName : menuItemClassName}
              >
                {panel.icon ? (
                  <img
                    src={panel.icon}
                    alt=""
                    className="h-[17px] w-[17px] shrink-0 rounded object-contain"
                  />
                ) : (
                  <PuzzlePieceIcon
                    className={isSelected ? (activeIconClassName ?? iconClassName) : iconClassName}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{panel.title}</span>
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

export default SidebarPluginOverflowMenu;
