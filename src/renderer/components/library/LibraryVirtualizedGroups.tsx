import './libraryDisclosure.css';

import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { useVirtualizer } from '@tanstack/react-virtual';
import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { LibraryGridLimits, LibraryViewMode } from '../../../shared/library/constants';
import type { LibraryItem, LibrarySessionRef } from '../../../shared/library/types';
import { i18nService } from '../../services/i18n';
import {
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';
import {
  clampLibraryScrollTop,
  getLibrarySessionAnchorKey,
  LibraryScrollLimits,
  type LibraryScrollRestoration,
} from './libraryScrollAnchor';

export interface LibrarySessionDisclosure {
  expanded: boolean;
  matchedFileCount: number;
  loading: boolean;
  disabled?: boolean;
  error?: string;
  onExpand: () => void;
  onLoadMore: () => void;
  onCollapse: () => void;
  onRetry?: () => void;
}

export interface LibrarySessionGroup {
  key: string;
  title: string;
  sortTime: number;
  session?: LibrarySessionRef;
  items: LibraryItem[];
  disclosure?: LibrarySessionDisclosure;
}

export interface LibraryDateGroup {
  key: string;
  title: string;
  sessionGroups: LibrarySessionGroup[];
}

const LibraryVirtualRowKind = {
  DateHeader: 'date-header',
  SessionHeader: 'session-header',
  Items: 'items',
  SessionControls: 'session-controls',
} as const;

type LibraryVirtualRow =
  | {
      kind: typeof LibraryVirtualRowKind.DateHeader;
      key: string;
      title: string;
      first: boolean;
    }
  | {
      kind: typeof LibraryVirtualRowKind.SessionHeader;
      key: string;
      group: LibrarySessionGroup;
    }
  | {
      kind: typeof LibraryVirtualRowKind.Items;
      key: string;
      groupKey: string;
      items: LibraryItem[];
      first: boolean;
      last: boolean;
      hasDisclosure: boolean;
    }
  | {
      kind: typeof LibraryVirtualRowKind.SessionControls;
      key: string;
      group: LibrarySessionGroup;
    };

const GRID_MIN_CARD_WIDTH_PX = 240;
const GRID_GAP_PX = 12;

export const getLibraryGridColumnCount = (width: number): number => Math.max(
  1,
  Math.floor((Math.max(0, width) + GRID_GAP_PX) / (GRID_MIN_CARD_WIDTH_PX + GRID_GAP_PX)),
);

export const createVirtualRows = (
  dateGroups: LibraryDateGroup[],
  viewMode: LibraryViewMode,
  gridColumnCount: number,
): LibraryVirtualRow[] => dateGroups.flatMap((dateGroup, dateIndex) => {
  const rows: LibraryVirtualRow[] = [{
    kind: LibraryVirtualRowKind.DateHeader,
    key: `date:${dateGroup.key}`,
    title: dateGroup.title,
    first: dateIndex === 0,
  }];
  for (const group of dateGroup.sessionGroups) {
    const hasDisclosure = viewMode === LibraryViewMode.Grid
      && (group.disclosure?.matchedFileCount ?? 0) > LibraryGridLimits.PreviewCount;
    rows.push({
      kind: LibraryVirtualRowKind.SessionHeader,
      key: `session:${group.key}`,
      group,
    });
    const chunkSize = viewMode === LibraryViewMode.Grid ? gridColumnCount : 1;
    for (let index = 0; index < group.items.length; index += chunkSize) {
      rows.push({
        kind: LibraryVirtualRowKind.Items,
        key: `items:${viewMode}:${gridColumnCount}:${group.key}:${index}`,
        groupKey: group.key,
        items: group.items.slice(index, index + chunkSize),
        first: index === 0,
        last: index + chunkSize >= group.items.length,
        hasDisclosure,
      });
    }
    if (hasDisclosure) {
      rows.push({
        kind: LibraryVirtualRowKind.SessionControls,
        key: `controls:${group.key}`,
        group,
      });
    }
  }
  return rows;
});

export const getLibraryItemRowIndices = (rows: readonly LibraryVirtualRow[]): Map<string, number> => {
  const indices = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind !== LibraryVirtualRowKind.Items) return;
    for (const item of row.items) indices.set(`${item.itemKind}:${item.itemId}`, index);
  });
  return indices;
};

export const getLibraryAnchorRowIndices = (rows: readonly LibraryVirtualRow[]): Map<string, number> => {
  const indices = getLibraryItemRowIndices(rows);
  rows.forEach((row, index) => {
    if (row.kind === LibraryVirtualRowKind.SessionHeader && row.group.session) {
      indices.set(getLibrarySessionAnchorKey(row.group.session.sessionId), index);
    }
  });
  return indices;
};

const getEstimatedRowHeight = (
  row: LibraryVirtualRow,
  viewMode: LibraryViewMode,
): number => {
  if (row.kind === LibraryVirtualRowKind.DateHeader) return row.first ? 44 : 84;
  if (row.kind === LibraryVirtualRowKind.SessionHeader) return 34;
  if (row.kind === LibraryVirtualRowKind.SessionControls) return row.group.disclosure?.error ? 88 : 56;
  if (viewMode === LibraryViewMode.List) return row.last ? 84 : 56;
  return row.last && !row.hasDisclosure ? 288 : 260;
};

const GRID_STYLE: React.CSSProperties = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 264px))',
};

const DISCLOSURE_BUTTON_CLASS = 'library-disclosure-button inline-flex min-h-8 items-center justify-center gap-[7px] rounded-[9px] border px-[11px] py-[5px] text-xs disabled:cursor-not-allowed disabled:opacity-60';

export const LibrarySessionDisclosureControls: React.FC<{
  group: LibrarySessionGroup;
  contentId: string;
  header?: boolean;
}> = ({ group, contentId, header = false }) => {
  const disclosure = group.disclosure;
  if (!disclosure || disclosure.matchedFileCount <= LibraryGridLimits.PreviewCount) return null;
  const remaining = Math.max(0, disclosure.matchedFileCount - group.items.length);
  const canCollapse = disclosure.expanded || disclosure.loading;
  const collapse = canCollapse ? (
    <button
      type="button"
      className={`${DISCLOSURE_BUTTON_CLASS} library-disclosure-button-secondary${header ? ' library-disclosure-scope library-disclosure-button-header' : ''}`}
      aria-expanded={disclosure.expanded}
      aria-controls={contentId}
      aria-label={`${i18nService.t('libraryGridCollapse')} ${group.title}`}
      onClick={disclosure.onCollapse}
    >
      {i18nService.t('libraryGridCollapse')}
      <ChevronUpIcon aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  ) : null;
  if (header) return collapse;
  return (
    <div className="library-disclosure-scope pb-7" data-library-disclosure-key={group.session?.sessionId}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" aria-busy={disclosure.loading}>
        <div className="flex flex-wrap items-center gap-2">
          {!disclosure.error && (remaining > 0 || disclosure.loading) && (
            <button
              type="button"
              className={DISCLOSURE_BUTTON_CLASS}
              disabled={disclosure.loading || disclosure.disabled}
              aria-expanded={disclosure.expanded}
              aria-controls={contentId}
              onClick={disclosure.expanded ? disclosure.onLoadMore : disclosure.onExpand}
            >
              {disclosure.loading && <span className="library-disclosure-spinner" aria-hidden="true" />}
              {disclosure.loading
                ? i18nService.t('libraryGridLoading')
                : disclosure.expanded
                  ? i18nService.t('libraryGridLoadMore')
                    .replace('{count}', String(Math.min(LibraryGridLimits.ItemPageSize, remaining)))
                  : i18nService.t('libraryGridMoreFiles').replace('{count}', String(remaining))}
              {!disclosure.loading && <ChevronDownIcon aria-hidden="true" className="h-3.5 w-3.5" />}
            </button>
          )}
          {disclosure.error && (
            <button
              type="button"
              className={DISCLOSURE_BUTTON_CLASS}
              disabled={disclosure.loading || disclosure.disabled}
              onClick={disclosure.onRetry ?? (disclosure.expanded ? disclosure.onLoadMore : disclosure.onExpand)}
            >
              {i18nService.t('libraryGridRetry')}
            </button>
          )}
          {collapse}
        </div>
        {disclosure.expanded && remaining > 0 && !disclosure.loading && !disclosure.error && (
          <span className="library-disclosure-remaining text-xs">
            {i18nService.t('libraryGridRemainingFiles').replace('{count}', String(remaining))}
          </span>
        )}
      </div>
      {disclosure.error && <p role="alert" className="library-disclosure-error mt-2 text-xs">{disclosure.error}</p>}
    </div>
  );
};

const LibraryVirtualizedGroups: React.FC<{
  dateGroups: LibraryDateGroup[];
  viewMode: LibraryViewMode;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  onOpenSession: (session: LibrarySessionRef) => void;
  formatSessionTime: (value: number) => string;
  renderItem: (item: LibraryItem) => React.ReactNode;
  restoration?: LibraryScrollRestoration;
  onRestored?: (id: number, degraded: boolean) => void;
}> = ({
  dateGroups,
  viewMode,
  scrollContainerRef,
  onOpenSession,
  formatSessionTime,
  renderItem,
  restoration,
  onRestored,
}) => {
  const contentId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const correctionProgressRef = useRef({ id: -1, count: 0 });
  const [listWidth, setListWidth] = useState(1);
  const [scrollMargin, setScrollMargin] = useState(0);
  const gridColumnCount = getLibraryGridColumnCount(listWidth);
  const rows = useMemo(() => createVirtualRows(
    dateGroups,
    viewMode,
    gridColumnCount,
  ), [dateGroups, gridColumnCount, viewMode]);
  const anchorRowIndices = useMemo(() => getLibraryAnchorRowIndices(rows), [rows]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!list || !scrollContainer) return undefined;
    const updateMeasurements = (): void => {
      setListWidth(list.clientWidth);
      setScrollMargin(list.offsetTop);
    };
    updateMeasurements();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateMeasurements);
    observer.observe(list);
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, [scrollContainerRef]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: index => getEstimatedRowHeight(rows[index]!, viewMode),
    getItemKey: index => rows[index]?.key ?? index,
    overscan: 3,
    scrollMargin,
  });

  useLayoutEffect(() => {
    const root = scrollContainerRef.current;
    if (!restoration || !root) return undefined;
    if (correctionProgressRef.current.id !== restoration.id) {
      correctionProgressRef.current = { id: restoration.id, count: 0 };
    }
    if (!restoration.isCurrent()) {
      onRestored?.(restoration.id, false);
      return undefined;
    }
    const target = restoration.candidates.find(candidate => anchorRowIndices.has(candidate.itemKey));
    const restoreTop = !restoration.preferTarget && restoration.scrollTop <= LibraryScrollLimits.TopThresholdPx;
    if (restoreTop || !target) {
      root.scrollTop = restoreTop
        ? 0
        : clampLibraryScrollTop(restoration.scrollTop, root);
      onRestored?.(restoration.id, !target && restoration.scrollTop > LibraryScrollLimits.TopThresholdPx);
      return undefined;
    }
    rowVirtualizer.scrollToIndex(anchorRowIndices.get(target.itemKey)!, { align: 'start' });
    let frame: number;
    const correct = (): void => {
      if (!restoration.isCurrent()) {
        onRestored?.(restoration.id, false);
        return;
      }
      const element = [...root.querySelectorAll<HTMLElement>('[data-library-item-key], [data-library-anchor-key]')]
        .find(candidate => (candidate.dataset.libraryItemKey ?? candidate.dataset.libraryAnchorKey) === target.itemKey);
      if (element && correctionProgressRef.current.count < LibraryScrollLimits.Corrections) {
        // Switch from index tracking to an absolute offset: the virtualizer's
        // asynchronous index reconciliation must not undo our pixel correction.
        rowVirtualizer.scrollToOffset(root.scrollTop + element.getBoundingClientRect().top
          - root.getBoundingClientRect().top - target.offsetTop);
      }
      correctionProgressRef.current.count += 1;
      if (correctionProgressRef.current.count < LibraryScrollLimits.Corrections) frame = requestAnimationFrame(correct);
      else {
        if (restoration.preferTarget && root.ownerDocument.activeElement === root.ownerDocument.body) {
          element?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
        }
        onRestored?.(restoration.id, !element);
      }
    };
    frame = requestAnimationFrame(correct);
    return () => {
      cancelAnimationFrame(frame);
      // Also cancel outstanding index tracking when the user takes control.
      rowVirtualizer.scrollToOffset(root.scrollTop);
    };
  }, [anchorRowIndices, onRestored, restoration, rowVirtualizer, scrollContainerRef]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const controlledRowIds = new Map<string, string[]>();
  for (const virtualRow of virtualRows) {
    const row = rows[virtualRow.index];
    if (row?.kind !== LibraryVirtualRowKind.Items) continue;
    const ids = controlledRowIds.get(row.groupKey) ?? [];
    ids.push(`${contentId}-row-${virtualRow.index}`);
    controlledRowIds.set(row.groupKey, ids);
  }

  return (
    <div
      ref={listRef}
      id={contentId}
      className="relative mt-6 w-full"
      style={{ height: rowVirtualizer.getTotalSize() }}
    >
      {virtualRows.map(virtualRow => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        return (
          <div
            key={row.key}
            ref={rowVirtualizer.measureElement}
            id={row.kind === LibraryVirtualRowKind.Items ? `${contentId}-row-${virtualRow.index}` : undefined}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {row.kind === LibraryVirtualRowKind.DateHeader && (
              <div className={`${row.first ? '' : 'pt-10'} mb-5 flex items-center gap-3`}>
                <h2 className={`shrink-0 ${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground`}>
                  {row.title}
                </h2>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            {row.kind === LibraryVirtualRowKind.SessionHeader && (
              <div
                className="mb-2.5 flex items-center justify-between gap-6"
                data-library-anchor-key={row.group.session
                  ? getLibrarySessionAnchorKey(row.group.session.sessionId)
                  : undefined}
              >
                {row.group.session ? (
                  <button
                    type="button"
                    onClick={() => onOpenSession(row.group.session!)}
                    title={row.group.title}
                    className={`min-w-0 max-w-xl truncate text-left ${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground hover:text-primary`}
                  >
                    {row.group.title}
                  </button>
                ) : (
                  <h3
                    title={row.group.title}
                    className={`min-w-0 max-w-xl truncate ${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground`}
                  >
                    {row.group.title}
                  </h3>
                )}
                <div className="flex shrink-0 items-center gap-3">
                  {viewMode === LibraryViewMode.Grid && (
                    <LibrarySessionDisclosureControls
                      group={row.group}
                      contentId={controlledRowIds.get(row.group.key)?.join(' ') || contentId}
                      header
                    />
                  )}
                  <time
                    dateTime={new Date(row.group.sortTime).toISOString()}
                    className="shrink-0 text-xs text-secondary"
                  >
                    {formatSessionTime(row.group.sortTime)}
                  </time>
                </div>
              </div>
            )}
            {row.kind === LibraryVirtualRowKind.Items && (
              <div className={row.last && !row.hasDisclosure ? 'pb-7' : viewMode === LibraryViewMode.Grid ? 'pb-3' : ''}>
                <div
                  className={viewMode === LibraryViewMode.List
                    ? `border-b border-border ${row.first ? 'border-t' : ''}`
                    : 'grid justify-start gap-3'}
                  style={viewMode === LibraryViewMode.Grid ? GRID_STYLE : undefined}
                >
                  {row.items.map(renderItem)}
                </div>
              </div>
            )}
            {row.kind === LibraryVirtualRowKind.SessionControls && (
              <LibrarySessionDisclosureControls
                group={row.group}
                contentId={controlledRowIds.get(row.group.key)?.join(' ') || contentId}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default LibraryVirtualizedGroups;
