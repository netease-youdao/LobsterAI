import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import ComposeIcon from '../icons/ComposeIcon';
import {
  type ArtifactTabMenuShortcutEntry,
  resolveArtifactTabMenuShortcut,
} from './artifactTabActions';

export interface ArtifactPreviewTabMenuAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  onClick: () => void;
}

interface ArtifactPreviewTabMenuProps {
  position: { x: number; y: number };
  onDismiss: () => void;
  onRenameTab?: () => void;
  renameLabel?: string;
  extraActions?: ArtifactPreviewTabMenuAction[];
  onCloseTab: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
  onCloseAll?: () => void;
}

const MENU_ITEM_BASE_CLASSNAME =
  'flex w-full items-center gap-2.5 whitespace-nowrap rounded-[10px] px-2.5 py-1.5 text-left text-[13px] leading-5 transition-colors focus:outline-none disabled:cursor-default disabled:opacity-35';

const MENU_ITEM_NORMAL_CLASSNAME =
  `${MENU_ITEM_BASE_CLASSNAME} text-foreground enabled:hover:bg-surface-raised focus-visible:bg-surface-raised`;

const MENU_ITEM_DANGER_CLASSNAME =
  `${MENU_ITEM_BASE_CLASSNAME} text-destructive enabled:hover:bg-destructive/10 focus-visible:bg-destructive/10`;

const MENU_ICON_CLASSNAME = 'h-[15px] w-[15px] shrink-0 text-foreground/75';

const MENU_SHORTCUT_CLASSNAME = 'ml-auto pl-6 text-xs font-normal tracking-wide text-muted/80';

export default function ArtifactPreviewTabMenu({
  position,
  onDismiss,
  onRenameTab,
  renameLabel,
  extraActions,
  onCloseTab,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
}: ArtifactPreviewTabMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(position);
  const hasExtraActions = Boolean(extraActions && extraActions.length > 0);

  const shortcutEntries = useMemo<ArtifactTabMenuShortcutEntry[]>(() => {
    const entries: ArtifactTabMenuShortcutEntry[] = [];
    if (onRenameTab) {
      entries.push({ shortcut: 'R', onSelect: onRenameTab });
    }
    if (extraActions) {
      for (const item of extraActions) {
        if (item.shortcut) {
          entries.push({
            shortcut: item.shortcut,
            disabled: item.disabled,
            onSelect: item.onClick,
          });
        }
      }
    }
    entries.push({ shortcut: 'W', onSelect: onCloseTab });
    if (onCloseOthers) {
      entries.push({ shortcut: 'O', onSelect: onCloseOthers });
    }
    return entries;
  }, [extraActions, onCloseOthers, onCloseTab, onRenameTab]);

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      setOffset({
        x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8)),
      });
    }
    const previous = document.activeElement;
    // Focus the menu container instead of item 0 so mouse right-click opens cleanly
    // without a pre-selected highlight while keyboard navigation works immediately.
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [position]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const matched = resolveArtifactTabMenuShortcut(event.key, shortcutEntries);
      if (matched) {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        matched();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
    };
  }, [onDismiss, shortcutEntries]);

  const closeItems = [
    { labelKey: 'artifactCloseTab', shortcut: 'W', action: onCloseTab },
    { labelKey: 'artifactCloseOtherTabs', shortcut: 'O', action: onCloseOthers },
    { labelKey: 'artifactCloseTabsToRight', action: onCloseToRight },
    { labelKey: 'artifactCloseAllTabs', action: onCloseAll },
  ];

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={i18nService.t('artifactTabActions')}
      className="popover-enter fixed z-[10000] min-w-[200px] max-w-[calc(100vw-16px)] rounded-2xl border border-border bg-surface p-1.5 shadow-popover outline-none"
      style={{ left: offset.x, top: offset.y }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        if (items.length === 0) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Tab') {
          event.preventDefault();
          onDismiss();
          return;
        }
        if (event.key === 'Home') {
          event.preventDefault();
          items[0]?.focus();
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          items[items.length - 1]?.focus();
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          items[index < 0 ? 0 : (index + 1) % items.length]?.focus();
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          items[index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length]?.focus();
        }
      }}
    >
      {onRenameTab && (
        <button
          role="menuitem"
          type="button"
          className={MENU_ITEM_NORMAL_CLASSNAME}
          onClick={() => { onDismiss(); onRenameTab(); }}
        >
          <ComposeIcon className={MENU_ICON_CLASSNAME} />
          <span>{renameLabel || i18nService.t('artifactRenameFile')}</span>
          <span className={MENU_SHORTCUT_CLASSNAME} aria-hidden="true">R</span>
        </button>
      )}
      {onRenameTab && hasExtraActions && (
        <div className="my-1.5 border-t border-border/70" role="separator" />
      )}
      {hasExtraActions && extraActions?.map(item => (
        <button
          key={item.id}
          role="menuitem"
          type="button"
          disabled={item.disabled}
          title={item.title}
          className={item.danger ? MENU_ITEM_DANGER_CLASSNAME : MENU_ITEM_NORMAL_CLASSNAME}
          onClick={() => {
            if (item.disabled) return;
            onDismiss();
            item.onClick();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
          {item.shortcut && (
            <span className={MENU_SHORTCUT_CLASSNAME} aria-hidden="true">{item.shortcut}</span>
          )}
        </button>
      ))}
      {(onRenameTab || hasExtraActions) && (
        <div className="my-1.5 border-t border-border/70" role="separator" />
      )}
      {closeItems.map(({ labelKey, shortcut, action }) => (
        <button
          key={labelKey}
          role="menuitem"
          type="button"
          disabled={!action}
          className={MENU_ITEM_NORMAL_CLASSNAME}
          onClick={() => { onDismiss(); action?.(); }}
        >
          <XMarkIcon className={MENU_ICON_CLASSNAME} strokeWidth={1.7} aria-hidden="true" />
          <span>{i18nService.t(labelKey)}</span>
          {shortcut && (
            <span className={MENU_SHORTCUT_CLASSNAME} aria-hidden="true">{shortcut}</span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}
