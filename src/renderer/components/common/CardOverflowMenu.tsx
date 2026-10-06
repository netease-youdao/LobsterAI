import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import { MANAGEMENT_BODY_TEXT } from './managementTypography';

const MENU_WIDTH_PX = 152;
const MENU_EDGE_GAP_PX = 8;
const MENU_TRIGGER_GAP_PX = 4;
const MENU_ITEM_HEIGHT_PX = 36;
const SUBMENU_MAX_VISIBLE_ITEMS = 4;

export const CARD_OVERFLOW_MENU_SURFACE_CLASSNAME =
  'rounded-xl border border-border bg-surface py-1 shadow-popover';
export const CARD_OVERFLOW_MENU_ITEM_CLASSNAME =
  `flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left ${MANAGEMENT_BODY_TEXT} transition-colors hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-white/[0.05]`;
export const CARD_OVERFLOW_MENU_SUBMENU_CLASSNAME =
  'mx-2 mb-1 overflow-y-auto pl-2';
export const CARD_OVERFLOW_MENU_SUBITEM_CLASSNAME =
  `flex h-9 w-full items-center gap-2 whitespace-nowrap rounded-md px-2 text-left ${MANAGEMENT_BODY_TEXT} transition-colors hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-white/[0.05]`;
export const CARD_OVERFLOW_MENU_SUBMENU_MAX_HEIGHT_PX =
  SUBMENU_MAX_VISIBLE_ITEMS * MENU_ITEM_HEIGHT_PX;

export interface CardOverflowMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  trailing?: React.ReactNode;
  children?: CardOverflowMenuItem[];
  onSelect?: () => void;
}

interface CardOverflowMenuProps {
  items: CardOverflowMenuItem[];
  /** Extra classes for the trigger, e.g. to reveal it on card hover. */
  className?: string;
  /** Override for menus whose localized labels need more room. */
  menuWidthPx?: number;
  /** Called only when the menu changes from closed to open. */
  onOpen?: () => void;
}

/** Reusable overflow menu with an optional inline, one-level submenu. */
const CardOverflowMenu: React.FC<CardOverflowMenuProps> = ({
  items,
  className = '',
  menuWidthPx = MENU_WIDTH_PX,
  onOpen,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedItemKey, setExpandedItemKey] = useState<string>();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const expandedParent = expandedItemKey
    ? items.find(item => item.key === expandedItemKey && item.children)
    : undefined;
  const expandedChildCount = Math.min(
    expandedParent?.children?.length ?? 0,
    SUBMENU_MAX_VISIBLE_ITEMS,
  );
  const menuHeight = (items.length + expandedChildCount) * MENU_ITEM_HEIGHT_PX
    + 8;

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const maxLeft = window.innerWidth - menuWidthPx - MENU_EDGE_GAP_PX;
    const left = Math.max(MENU_EDGE_GAP_PX, Math.min(rect.right - menuWidthPx, maxLeft));
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < menuHeight + MENU_TRIGGER_GAP_PX && rect.top > spaceBelow;
    const preferredTop = openAbove
      ? rect.top - menuHeight - MENU_TRIGGER_GAP_PX
      : rect.bottom + MENU_TRIGGER_GAP_PX;
    const maxTop = window.innerHeight - menuHeight - MENU_EDGE_GAP_PX;
    setPosition({
      top: Math.max(MENU_EDGE_GAP_PX, Math.min(preferredTop, maxTop)),
      left,
    });
  }, [menuHeight, menuWidthPx]);

  useLayoutEffect(() => {
    if (isOpen) updatePosition();
    else {
      setPosition(null);
      setExpandedItemKey(undefined);
    }
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (expandedItemKey) setExpandedItemKey(undefined);
      else setIsOpen(false);
    };
    const handleReflow = () => setIsOpen(false);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleReflow);
    window.addEventListener('scroll', handleReflow, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleReflow);
      window.removeEventListener('scroll', handleReflow, true);
    };
  }, [expandedItemKey, isOpen]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={i18nService.t('moreActions')}
        title={i18nService.t('moreActions')}
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen(value => {
            if (!value) onOpen?.();
            return !value;
          });
        }}
        className={`inline-flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-raised hover:text-foreground ${
          isOpen ? 'bg-surface-raised text-foreground' : ''
        } ${className}`}
      >
        <EllipsisHorizontalIcon className="h-4 w-4" />
      </button>
      {isOpen && position && createPortal(
        <div
          ref={menuRef}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          style={{ top: position.top, left: position.left, width: menuWidthPx }}
          className={`fixed z-[9999] ${CARD_OVERFLOW_MENU_SURFACE_CLASSNAME}`}
        >
          {items.map(item => {
            const hasChildren = Boolean(item.children);
            const isExpanded = hasChildren && expandedItemKey === item.key;
            return (
              <div
                key={item.key}
                className={item.separatorBefore ? 'mt-1 border-t border-border pt-1' : ''}
              >
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup={hasChildren ? 'menu' : undefined}
                  aria-expanded={hasChildren ? isExpanded : undefined}
                  disabled={item.disabled}
                  onKeyDown={(event) => {
                    if (!hasChildren || item.disabled) return;
                    if (event.key === 'ArrowRight') {
                      event.preventDefault();
                      setExpandedItemKey(item.key);
                    } else if (event.key === 'ArrowLeft') {
                      event.preventDefault();
                      setExpandedItemKey(undefined);
                    }
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (item.disabled) return;
                    if (hasChildren) {
                      setExpandedItemKey(current => current === item.key ? undefined : item.key);
                      return;
                    }
                    setIsOpen(false);
                    item.onSelect?.();
                  }}
                  className={`${CARD_OVERFLOW_MENU_ITEM_CLASSNAME} ${
                    item.destructive ? 'text-red-500 dark:text-red-400' : 'text-foreground'
                  }`}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.trailing}
                  {hasChildren && (
                    <ChevronRightIcon
                      className={`h-3.5 w-3.5 shrink-0 text-tertiary transition-transform ${
                        isExpanded ? 'rotate-90' : ''
                      }`}
                    />
                  )}
                </button>
                {isExpanded && item.children && (
                  <div
                    role="group"
                    aria-label={item.label}
                    style={{ maxHeight: CARD_OVERFLOW_MENU_SUBMENU_MAX_HEIGHT_PX }}
                    className={CARD_OVERFLOW_MENU_SUBMENU_CLASSNAME}
                  >
                    {item.children.map(child => (
                      <button
                        key={child.key}
                        type="button"
                        role="menuitem"
                        disabled={child.disabled}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (child.disabled) return;
                          setIsOpen(false);
                          child.onSelect?.();
                        }}
                        className={`${CARD_OVERFLOW_MENU_SUBITEM_CLASSNAME} ${
                          child.destructive ? 'text-red-500 dark:text-red-400' : 'text-foreground'
                        }`}
                      >
                        {child.icon}
                        <span className="min-w-0 flex-1 truncate">{child.label}</span>
                        {child.trailing}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
};

export default CardOverflowMenu;
