import {
  Bars3Icon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  EyeSlashIcon,
  InformationCircleIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { numfmt, WorksheetHiddenState } from '@univerjs/core';
import {
  CopySheetCommand,
  InsertSheetCommand,
  SetTabColorCommand,
  SetWorksheetHideCommand,
  SetWorksheetNameCommand,
  SetWorksheetOrderCommand,
  SetWorksheetShowCommand,
} from '@univerjs/sheets';
import { RemoveSheetConfirmCommand } from '@univerjs/sheets-ui';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import type { SheetEditorSession } from '@/services/office/sheet/sheetEditorSession';
import {
  resolveSheetOrderIndex,
  resolveSheetTabBarCompact,
  resolveSheetTabBarHideZoom,
  SHEET_ZOOM_PRESETS,
  SheetStatisticFunc,
  SheetTabNameError,
  validateSheetTabName,
} from '@/services/office/sheet/sheetToolbarLayout';

import { clampOfficeZoom, OfficeZoom } from '../common/OfficeZoomControls';

const t = (key: string) => i18nService.t(key);
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

const ALL_SHEETS_MENU_WIDTH = 210;
const TAB_CONTEXT_MENU_WIDTH = 188;
const STAT_MENU_WIDTH = 196;
const ZOOM_MENU_WIDTH = 160;
const HIDDEN_INFO_WIDTH = 260;
const SCROLL_STEP_PX = 140;

const STAT_LABEL_KEYS: Record<string, string> = {
  [SheetStatisticFunc.Sum]: 'sheetStatSum',
  [SheetStatisticFunc.Average]: 'sheetStatAverage',
  [SheetStatisticFunc.Count]: 'sheetStatCount',
  [SheetStatisticFunc.CountA]: 'sheetStatCountA',
  [SheetStatisticFunc.Min]: 'sheetStatMin',
  [SheetStatisticFunc.Max]: 'sheetStatMax',
};
const PATTERN_STAT_FUNCS = new Set<string>([
  SheetStatisticFunc.Sum,
  SheetStatisticFunc.Average,
  SheetStatisticFunc.Min,
  SheetStatisticFunc.Max,
]);

const TAB_COLOR_SWATCHES = [
  '#217346',
  '#2563eb',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#64748b',
] as const;

const RENAME_ERROR_KEYS: Record<SheetTabNameError, string> = {
  [SheetTabNameError.Empty]: 'sheetTabNameEmpty',
  [SheetTabNameError.InvalidChars]: 'sheetTabNameInvalidChars',
  [SheetTabNameError.TooLong]: 'sheetTabNameTooLong',
  [SheetTabNameError.Duplicate]: 'sheetTabNameDuplicate',
};

interface UpwardAnchor {
  left: number;
  bottom: number;
}

interface UpwardPopover {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  anchor?: UpwardAnchor;
  trigger: React.RefObject<HTMLButtonElement>;
  panel: React.RefObject<HTMLDivElement>;
}

function useUpwardPopover(width: number, alignEnd = false): UpwardPopover {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<UpwardAnchor>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const rawLeft = alignEnd ? rect.right - width : rect.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - width - 8));
    const bottom = Math.max(8, Math.round(window.innerHeight - rect.top + 6));
    setAnchor({ left, bottom });
  }, [open, width, alignEnd]);

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  return { open, setOpen, anchor, trigger, panel };
}

function UpwardPopoverPanel({
  popover,
  label,
  width,
  children,
}: {
  popover: UpwardPopover;
  label: string;
  width: number;
  children: React.ReactNode;
}): React.ReactElement | null {
  if (!popover.open || !popover.anchor) return null;
  return createPortal(
    <div
      ref={popover.panel}
      className="lobster-office-popover lobster-sheet-upward-popover"
      role="dialog"
      aria-label={label}
      style={{ left: popover.anchor.left, bottom: popover.anchor.bottom, width }}
    >
      {children}
    </div>,
    document.body,
  );
}

function formatStatValue(func: string, value: number, pattern: string | null): string {
  if (pattern && PATTERN_STAT_FUNCS.has(func)) {
    try {
      return numfmt.format(pattern, value, { throws: false });
    } catch {
      // Fall back to locale formatting if a custom pattern cannot be rendered.
    }
  }
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(value);
}

interface SheetItemInfo {
  id: string;
  name: string;
  hidden: boolean;
  veryHidden: boolean;
  active: boolean;
  tabColor?: string;
}

interface TabContextMenuState {
  sheetId: string;
  left: number;
  bottom: number;
}

interface DragIndicatorState {
  targetIndex: number;
}

export interface SheetTabBarProps {
  session: SheetEditorSession;
  disabled: boolean;
  readOnly: boolean;
  hiddenContentNotice?: string;
}

/**
 * Excel-native bottom worksheet tab bar (32px):
 * left sheet-list / overflow arrows -> primary horizontal sheet tabs + trailing `+` button ->
 * compact selection statistic & zoom trigger on the right so tabs are never starved in split panes.
 */
export function SheetTabBar({
  session,
  disabled,
  readOnly,
  hiddenContentNotice,
}: SheetTabBarProps): React.ReactElement | null {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const barRef = useRef<HTMLDivElement>(null);
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const [barWidth, setBarWidth] = useState(0);
  const [scrollState, setScrollState] = useState({ hasOverflow: false, canLeft: false, canRight: false });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DragIndicatorState | null>(null);
  const [selectedStatFunc, setSelectedStatFunc] = useState<string>(SheetStatisticFunc.Sum);

  const allSheetsPopover = useUpwardPopover(ALL_SHEETS_MENU_WIDTH, false);
  const statPopover = useUpwardPopover(STAT_MENU_WIDTH, true);
  const zoomPopover = useUpwardPopover(ZOOM_MENU_WIDTH, true);
  const hiddenInfoPopover = useUpwardPopover(HIDDEN_INFO_WIDTH, true);

  const workbook = session.workbook;
  const rawWorkbook = workbook?.getWorkbook();
  const activeSheetId = workbook?.getActiveSheet()?.getSheetId() ?? '';

  const allSheets: SheetItemInfo[] = rawWorkbook
    ? rawWorkbook.getSheets().map(sheet => {
      const hiddenState = sheet.getHiddenState();
      const color = sheet.getConfig().tabColor ?? undefined;
      return {
        id: sheet.getSheetId(),
        name: sheet.getName(),
        hidden: hiddenState !== WorksheetHiddenState.VISIBLE,
        veryHidden: hiddenState === WorksheetHiddenState.VERY_HIDDEN,
        active: sheet.getSheetId() === activeSheetId,
        tabColor: color || undefined,
      };
    })
    : [];

  const menuSheets = allSheets.filter(sheet => !sheet.veryHidden);
  const visibleSheets = allSheets.filter(sheet => !sheet.hidden);

  useEffect(() => {
    const element = barRef.current;
    if (!element) return undefined;
    setBarWidth(element.clientWidth);
    const observer = new ResizeObserver(entries => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? element.clientWidth);
      setBarWidth(prev => (prev === nextWidth ? prev : nextWidth));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const updateScrollState = useCallback(() => {
    const scroller = tabsScrollRef.current;
    if (!scroller) return;
    const hasOverflow = scroller.scrollWidth - scroller.clientWidth > 2;
    const canLeft = scroller.scrollLeft > 2;
    const canRight = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 2;
    setScrollState(prev => (
      prev.hasOverflow === hasOverflow && prev.canLeft === canLeft && prev.canRight === canRight
        ? prev
        : { hasOverflow, canLeft, canRight }
    ));
  }, []);

  useEffect(() => {
    updateScrollState();
    const scroller = tabsScrollRef.current;
    if (!scroller) return undefined;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(scroller);
    scroller.addEventListener('scroll', updateScrollState, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', updateScrollState);
    };
  }, [updateScrollState, visibleSheets.length, barWidth]);

  // Keep the active sheet tab scrolled into view when switching tabs or adding a sheet.
  useEffect(() => {
    if (!activeSheetId || !tabsScrollRef.current) return;
    const tab = tabsScrollRef.current.querySelector<HTMLElement>(`[data-sheet-tab-id="${CSS.escape(activeSheetId)}"]`);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateScrollState();
  }, [activeSheetId, visibleSheets.length, updateScrollState]);

  useEffect(() => {
    if (!renamingId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const onOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!contextMenuRef.current?.contains(target)) setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setContextMenu(null);
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [contextMenu]);

  if (!workbook || !rawWorkbook) return null;

  const unitId = workbook.getId();
  const editable = !readOnly && !disabled;
  const isCompact = resolveSheetTabBarCompact(barWidth);
  const hideZoom = resolveSheetTabBarHideZoom(barWidth);
  const zoom = workbook.getActiveSheet()?.getZoom() ?? 1;
  const zoomPercent = Math.round(zoom * 100);

  const setZoom = (nextZoom: number) => {
    workbook.getActiveSheet()?.zoom(clampOfficeZoom(nextZoom));
  };

  const activateSheet = (sheetId: string) => {
    if (sheetId === activeSheetId) return;
    const target = allSheets.find(sheet => sheet.id === sheetId);
    if (!target) return;
    if (target.hidden) {
      void session.api?.executeCommand(SetWorksheetShowCommand.id, { unitId, subUnitId: sheetId });
    } else {
      workbook.setActiveSheet(sheetId);
    }
  };

  const handleAddSheet = () => {
    if (!editable) return;
    void session.api?.executeCommand(InsertSheetCommand.id, {
      unitId,
      sheet: { columnCount: 26 },
    }).catch(error => console.warn('[SheetTabBar] Could not add worksheet:', error));
  };

  const startRename = (sheet: SheetItemInfo) => {
    if (!editable) return;
    setContextMenu(null);
    setRenameError(null);
    setRenamingId(sheet.id);
    setRenameDraft(sheet.name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft('');
    setRenameError(null);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const target = allSheets.find(sheet => sheet.id === renamingId);
    if (!target) {
      cancelRename();
      return;
    }
    const trimmed = renameDraft.trim();
    if (trimmed === target.name) {
      cancelRename();
      return;
    }
    const validationError = validateSheetTabName(
      trimmed,
      allSheets.map(sheet => sheet.name),
      target.name,
    );
    if (validationError) {
      setRenameError(t(RENAME_ERROR_KEYS[validationError]));
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
      return;
    }
    setRenamingId(null);
    setRenameDraft('');
    setRenameError(null);
    void session.api?.executeCommand(SetWorksheetNameCommand.id, {
      unitId,
      subUnitId: target.id,
      name: trimmed,
    }).catch(error => console.warn('[SheetTabBar] Could not rename worksheet:', error));
  };

  const handleDuplicate = (sheetId: string) => {
    setContextMenu(null);
    if (!editable) return;
    void session.api?.executeCommand(CopySheetCommand.id, { unitId, subUnitId: sheetId })
      .catch(error => console.warn('[SheetTabBar] Could not duplicate worksheet:', error));
  };

  const handleHide = (sheetId: string) => {
    setContextMenu(null);
    if (!editable || visibleSheets.length <= 1) return;
    void session.api?.executeCommand(SetWorksheetHideCommand.id, { unitId, subUnitId: sheetId })
      .catch(error => console.warn('[SheetTabBar] Could not hide worksheet:', error));
  };

  const handleDelete = (sheetId: string) => {
    setContextMenu(null);
    if (!editable || visibleSheets.length <= 1) return;
    void session.api?.executeCommand(RemoveSheetConfirmCommand.id, { unitId, subUnitId: sheetId })
      .catch(error => console.warn('[SheetTabBar] Could not remove worksheet:', error));
  };

  const handleSetTabColor = (sheetId: string, color: string) => {
    setContextMenu(null);
    if (!editable) return;
    void session.api?.executeCommand(SetTabColorCommand.id, { unitId, subUnitId: sheetId, value: color })
      .catch(error => console.warn('[SheetTabBar] Could not update worksheet tab color:', error));
  };

  const openContextMenu = (event: React.MouseEvent, sheetId: string) => {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    activateSheet(sheetId);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - TAB_CONTEXT_MENU_WIDTH - 8));
    const bottom = Math.max(8, Math.round(window.innerHeight - rect.top + 6));
    setContextMenu({ sheetId, left, bottom });
  };

  const handleTabDragStart = (event: React.DragEvent, sheetId: string) => {
    if (!editable || visibleSheets.length <= 1 || renamingId) {
      event.preventDefault();
      return;
    }
    setDraggedId(sheetId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', sheetId);
  };

  const handleTabDragOver = (event: React.DragEvent, visibleIndex: number) => {
    if (!draggedId || !editable) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    const rawTarget = after ? visibleIndex + 1 : visibleIndex;
    const draggedVisibleIndex = visibleSheets.findIndex(sheet => sheet.id === draggedId);
    const adjusted = draggedVisibleIndex >= 0 && rawTarget > draggedVisibleIndex ? rawTarget - 1 : rawTarget;
    setDropIndicator(prev => (prev?.targetIndex === adjusted ? prev : { targetIndex: adjusted }));
  };

  const handleTabDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const sourceId = draggedId;
    const targetVisibleIndex = dropIndicator?.targetIndex;
    setDraggedId(null);
    setDropIndicator(null);
    if (!sourceId || targetVisibleIndex === undefined || !editable) return;
    const allIds = rawWorkbook.getSheetOrders();
    const visibleIds = visibleSheets.map(sheet => sheet.id);
    const toOrder = resolveSheetOrderIndex(allIds, visibleIds, sourceId, targetVisibleIndex);
    if (toOrder === null) return;
    void session.api?.executeCommand(SetWorksheetOrderCommand.id, {
      unitId,
      subUnitId: sourceId,
      order: toOrder,
    }).catch(error => console.warn('[SheetTabBar] Could not reorder worksheet:', error));
  };

  const handleTabDragEnd = () => {
    setDraggedId(null);
    setDropIndicator(null);
  };

  const scrollTabsBy = (delta: number) => {
    tabsScrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  // Selection statistics from Univer's StatusBarService.
  const statValues = session.statusBarState?.values ?? [];
  const statPattern = session.statusBarState?.pattern ?? null;
  const availableStats = statValues
    .filter(item => typeof item.value === 'number' && Number.isFinite(item.value))
    .map(item => ({ func: String(item.func), value: item.value }));
  const activeStat = availableStats.find(item => item.func === selectedStatFunc)
    ?? availableStats.find(item => item.func === SheetStatisticFunc.Sum)
    ?? availableStats[0];

  const formatStatEntry = (func: string, value: number) => {
    const labelKey = STAT_LABEL_KEYS[func];
    const label = labelKey ? t(labelKey) : func;
    return `${label}: ${formatStatValue(func, value, statPattern)}`;
  };

  const contextSheet = contextMenu ? allSheets.find(sheet => sheet.id === contextMenu.sheetId) : undefined;

  return (
    <div ref={barRef} className="lobster-sheet-tabbar" role="region" aria-label={t('sheetTabsRegion')}>
      {/* Left: Excel-style overflow arrows (only when tabs overflow) + all-sheets picker */}
      <div className="lobster-sheet-tabbar-nav">
        {scrollState.hasOverflow && (
          <>
            <button
              type="button"
              className="lobster-sheet-tabbar-icon-btn"
              title={t('sheetTabsScrollLeft')}
              aria-label={t('sheetTabsScrollLeft')}
              disabled={!scrollState.canLeft}
              onMouseDown={keepFocus}
              onContextMenu={event => {
                event.preventDefault();
                allSheetsPopover.setOpen(true);
              }}
              onClick={() => scrollTabsBy(-SCROLL_STEP_PX)}
            >
              <ChevronLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="lobster-sheet-tabbar-icon-btn"
              title={t('sheetTabsScrollRight')}
              aria-label={t('sheetTabsScrollRight')}
              disabled={!scrollState.canRight}
              onMouseDown={keepFocus}
              onContextMenu={event => {
                event.preventDefault();
                allSheetsPopover.setOpen(true);
              }}
              onClick={() => scrollTabsBy(SCROLL_STEP_PX)}
            >
              <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </>
        )}

        <button
          ref={allSheetsPopover.trigger}
          type="button"
          className={`lobster-sheet-tabbar-icon-btn${allSheetsPopover.open ? ' is-active' : ''}`}
          title={t('sheetAllSheets')}
          aria-label={t('sheetAllSheets')}
          aria-haspopup="menu"
          aria-expanded={allSheetsPopover.open}
          onMouseDown={keepFocus}
          onClick={() => allSheetsPopover.setOpen(open => !open)}
        >
          <Bars3Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <UpwardPopoverPanel popover={allSheetsPopover} label={t('sheetAllSheets')} width={ALL_SHEETS_MENU_WIDTH}>
          {allSheetsPopover.open && (
            <div className="lobster-sheet-all-sheets-list">
              <span className="lobster-sheet-menu-heading">{t('sheetAllSheets')}</span>
              {menuSheets.map(sheet => (
                <button
                  key={sheet.id}
                  type="button"
                  className={`lobster-office-menu-item lobster-sheet-popover-item${sheet.active ? ' is-active' : ''}${sheet.hidden ? ' is-hidden-sheet' : ''}`}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    allSheetsPopover.setOpen(false);
                    activateSheet(sheet.id);
                  }}
                >
                  {sheet.hidden ? (
                    <EyeSlashIcon className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  ) : (
                    <CheckIcon className={`h-3.5 w-3.5 shrink-0${sheet.active ? '' : ' opacity-0'}`} aria-hidden="true" />
                  )}
                  <span className="truncate">{sheet.name}</span>
                  {sheet.tabColor && (
                    <span className="lobster-sheet-color-dot" style={{ backgroundColor: sheet.tabColor }} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          )}
        </UpwardPopoverPanel>
      </div>

      {/* Primary zone: Excel-style worksheet tabs + trailing '+' button right next to last tab */}
      <div className="lobster-sheet-tabs-track">
        <div
          ref={tabsScrollRef}
          className="lobster-sheet-tabs-scroll"
          role="tablist"
          aria-label={t('sheetTabsRegion')}
          onWheel={event => {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && tabsScrollRef.current) {
              tabsScrollRef.current.scrollLeft += event.deltaY;
            }
          }}
        >
          {visibleSheets.map((sheet, visibleIndex) => {
            const isRenaming = renamingId === sheet.id;
            const isDragged = draggedId === sheet.id;
            const draggedVisibleIndex = draggedId ? visibleSheets.findIndex(item => item.id === draggedId) : -1;
            const dropBefore = dropIndicator !== null && draggedVisibleIndex >= 0
              && ((draggedVisibleIndex > visibleIndex && dropIndicator.targetIndex === visibleIndex)
                || (draggedVisibleIndex < visibleIndex && dropIndicator.targetIndex === visibleIndex - 1));
            const dropAfter = dropIndicator !== null && draggedVisibleIndex >= 0
              && visibleIndex === visibleSheets.length - 1
              && dropIndicator.targetIndex === visibleSheets.length - 1
              && draggedVisibleIndex !== visibleIndex;

            return (
              <div
                key={sheet.id}
                data-sheet-tab-id={sheet.id}
                role="tab"
                tabIndex={sheet.active ? 0 : -1}
                aria-selected={sheet.active}
                draggable={editable && visibleSheets.length > 1 && !isRenaming}
                className={`lobster-sheet-tab${sheet.active ? ' is-active' : ''}${isDragged ? ' is-dragging' : ''}${dropBefore ? ' is-drop-before' : ''}${dropAfter ? ' is-drop-after' : ''}`}
                style={sheet.tabColor ? { '--lobster-sheet-tab-color': sheet.tabColor } as React.CSSProperties : undefined}
                title={sheet.name}
                onMouseDown={event => {
                  if (!isRenaming && event.button === 0) event.preventDefault();
                }}
                onClick={() => {
                  if (!isRenaming) activateSheet(sheet.id);
                }}
                onDoubleClick={() => startRename(sheet)}
                onContextMenu={event => openContextMenu(event, sheet.id)}
                onDragStart={event => handleTabDragStart(event, sheet.id)}
                onDragOver={event => handleTabDragOver(event, visibleIndex)}
                onDrop={handleTabDrop}
                onDragEnd={handleTabDragEnd}
                onKeyDown={event => {
                  if (isRenaming) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activateSheet(sheet.id);
                  } else if (event.key === 'ArrowRight' && visibleIndex < visibleSheets.length - 1) {
                    event.preventDefault();
                    activateSheet(visibleSheets[visibleIndex + 1].id);
                  } else if (event.key === 'ArrowLeft' && visibleIndex > 0) {
                    event.preventDefault();
                    activateSheet(visibleSheets[visibleIndex - 1].id);
                  }
                }}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    className={`lobster-sheet-tab-input${renameError ? ' is-invalid' : ''}`}
                    value={renameDraft}
                    maxLength={31}
                    title={renameError ?? undefined}
                    aria-label={t('sheetRenameTab')}
                    onChange={event => {
                      setRenameDraft(event.target.value);
                      if (renameError) setRenameError(null);
                    }}
                    onBlur={commitRename}
                    onKeyDown={event => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                ) : (
                  <span className="lobster-sheet-tab-label">{sheet.name}</span>
                )}
              </div>
            );
          })}

          {editable && (
            <button
              type="button"
              className="lobster-sheet-tabbar-add-btn"
              title={t('sheetAddTab')}
              aria-label={t('sheetAddTab')}
              onMouseDown={keepFocus}
              onClick={handleAddSheet}
            >
              <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Inline rename validation feedback */}
      {renameError && (
        <span className="lobster-sheet-rename-error" role="alert">
          {renameError}
        </span>
      )}

      {/* Right compact cluster: hidden-content badge, selection statistic, compact zoom trigger */}
      <div className="lobster-sheet-tabbar-end">
        {hiddenContentNotice && (
          <>
            <button
              ref={hiddenInfoPopover.trigger}
              type="button"
              className={`lobster-sheet-tabbar-icon-btn${hiddenInfoPopover.open ? ' is-active' : ''}`}
              title={hiddenContentNotice}
              aria-label={hiddenContentNotice}
              aria-expanded={hiddenInfoPopover.open}
              onMouseDown={keepFocus}
              onClick={() => hiddenInfoPopover.setOpen(open => !open)}
            >
              <InformationCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <UpwardPopoverPanel popover={hiddenInfoPopover} label={t('sheetPreservedNotice')} width={HIDDEN_INFO_WIDTH}>
              {hiddenInfoPopover.open && (
                <div className="lobster-sheet-hidden-info">{hiddenContentNotice}</div>
              )}
            </UpwardPopoverPanel>
          </>
        )}

        {!isCompact && activeStat && (
          <>
            <button
              ref={statPopover.trigger}
              type="button"
              className="lobster-sheet-tabbar-stat-btn"
              title={formatStatEntry(activeStat.func, activeStat.value)}
              aria-haspopup="menu"
              aria-expanded={statPopover.open}
              onMouseDown={keepFocus}
              onClick={() => statPopover.setOpen(open => !open)}
            >
              <span className="truncate">{formatStatEntry(activeStat.func, activeStat.value)}</span>
              <span className="lobster-sheet-tabbar-caret" aria-hidden="true">▾</span>
            </button>
            <UpwardPopoverPanel popover={statPopover} label={t('sheetStatSummary')} width={STAT_MENU_WIDTH}>
              {statPopover.open && availableStats.map(item => {
                const selected = item.func === activeStat.func;
                return (
                  <button
                    key={item.func}
                    type="button"
                    className={`lobster-office-menu-item lobster-sheet-popover-item${selected ? ' is-active' : ''}`}
                    onMouseDown={keepFocus}
                    onClick={() => {
                      setSelectedStatFunc(item.func);
                      statPopover.setOpen(false);
                    }}
                  >
                    <CheckIcon className={`h-3.5 w-3.5 shrink-0${selected ? '' : ' opacity-0'}`} aria-hidden="true" />
                    <span className="truncate">{formatStatEntry(item.func, item.value)}</span>
                  </button>
                );
              })}
            </UpwardPopoverPanel>
          </>
        )}

        {!hideZoom && (
          <>
            <button
              ref={zoomPopover.trigger}
              type="button"
              className="lobster-sheet-tabbar-zoom-btn"
              title={t('artifactBrowserZoom')}
              aria-label={t('artifactBrowserZoom')}
              aria-haspopup="menu"
              aria-expanded={zoomPopover.open}
              onMouseDown={keepFocus}
              onClick={() => zoomPopover.setOpen(open => !open)}
            >
              <span>{zoomPercent}%</span>
              <span className="lobster-sheet-tabbar-caret" aria-hidden="true">▾</span>
            </button>
            <UpwardPopoverPanel popover={zoomPopover} label={t('artifactBrowserZoom')} width={ZOOM_MENU_WIDTH}>
              {zoomPopover.open && (
                <>
                  <div className="lobster-sheet-zoom-stepper">
                    <button
                      type="button"
                      className="lobster-sheet-zoom-step-btn"
                      title={t('artifactBrowserZoomOut')}
                      aria-label={t('artifactBrowserZoomOut')}
                      disabled={zoom <= OfficeZoom.Min}
                      onMouseDown={keepFocus}
                      onClick={() => setZoom(zoom - OfficeZoom.Step)}
                    >
                      −
                    </button>
                    <span className="lobster-sheet-zoom-readout">{zoomPercent}%</span>
                    <button
                      type="button"
                      className="lobster-sheet-zoom-step-btn"
                      title={t('artifactBrowserZoomIn')}
                      aria-label={t('artifactBrowserZoomIn')}
                      disabled={zoom >= OfficeZoom.Max}
                      onMouseDown={keepFocus}
                      onClick={() => setZoom(zoom + OfficeZoom.Step)}
                    >
                      +
                    </button>
                  </div>
                  <span className="lobster-sheet-menu-divider" role="separator" />
                  {SHEET_ZOOM_PRESETS.map(preset => {
                    const active = Math.abs(zoom - preset) < 0.005;
                    return (
                      <button
                        key={preset}
                        type="button"
                        className={`lobster-office-menu-item lobster-sheet-popover-item${active ? ' is-active' : ''}`}
                        onMouseDown={keepFocus}
                        onClick={() => {
                          zoomPopover.setOpen(false);
                          setZoom(preset);
                        }}
                      >
                        <CheckIcon className={`h-3.5 w-3.5 shrink-0${active ? '' : ' opacity-0'}`} aria-hidden="true" />
                        <span>{Math.round(preset * 100)}%</span>
                      </button>
                    );
                  })}
                </>
              )}
            </UpwardPopoverPanel>
          </>
        )}
      </div>

      {/* Per-tab right-click context menu */}
      {contextMenu && contextSheet && editable && createPortal(
        <div
          ref={contextMenuRef}
          className="lobster-office-popover lobster-sheet-upward-popover"
          role="menu"
          aria-label={t('sheetTabActions')}
          style={{ left: contextMenu.left, bottom: contextMenu.bottom, width: TAB_CONTEXT_MENU_WIDTH }}
        >
          <button
            type="button"
            role="menuitem"
            className="lobster-office-menu-item lobster-sheet-popover-item"
            onMouseDown={keepFocus}
            onClick={() => startRename(contextSheet)}
          >
            <PencilSquareIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t('sheetRenameTab')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="lobster-office-menu-item lobster-sheet-popover-item"
            onMouseDown={keepFocus}
            onClick={() => handleDuplicate(contextSheet.id)}
          >
            <DocumentDuplicateIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t('sheetDuplicateTab')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="lobster-office-menu-item lobster-sheet-popover-item"
            disabled={visibleSheets.length <= 1}
            onMouseDown={keepFocus}
            onClick={() => handleHide(contextSheet.id)}
          >
            <EyeSlashIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t('sheetHideTab')}</span>
          </button>

          <span className="lobster-sheet-menu-divider" role="separator" />
          <span className="lobster-sheet-menu-heading">{t('sheetTabColor')}</span>
          <div className="lobster-sheet-tab-color-row">
            <button
              type="button"
              className="lobster-sheet-tab-color-swatch lobster-office-swatch-none"
              title={t('sheetTabColorClear')}
              aria-label={t('sheetTabColorClear')}
              onMouseDown={keepFocus}
              onClick={() => handleSetTabColor(contextSheet.id, '')}
            />
            {TAB_COLOR_SWATCHES.map(color => (
              <button
                key={color}
                type="button"
                className={`lobster-sheet-tab-color-swatch${contextSheet.tabColor?.toLowerCase() === color ? ' is-selected' : ''}`}
                style={{ backgroundColor: color }}
                title={color}
                aria-label={color}
                onMouseDown={keepFocus}
                onClick={() => handleSetTabColor(contextSheet.id, color)}
              />
            ))}
          </div>

          <span className="lobster-sheet-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="lobster-office-menu-item lobster-sheet-popover-item is-danger"
            disabled={visibleSheets.length <= 1}
            onMouseDown={keepFocus}
            onClick={() => handleDelete(contextSheet.id)}
          >
            <TrashIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t('sheetDeleteTab')}</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
