import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CheckIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import { dismissAllTaskHoverCards } from './AgentTaskHoverCard';
import { AgentSidebarPageSize, PinnedTaskSortMode } from './constants';
import type { AgentSidebarActivityItem } from './taskFilter';

interface PinnedTasksSectionProps {
  items: AgentSidebarActivityItem[];
  isCollapsed: boolean;
  sortMode: PinnedTaskSortMode;
  isBatchMode?: boolean;
  onToggleCollapsed: () => void;
  onSortModeChange: (mode: PinnedTaskSortMode) => void;
  onReorder: (orderedSessionIds: string[]) => Promise<void>;
  renderTask: (item: AgentSidebarActivityItem) => React.ReactNode;
}

const ACTION_MENU_VIEWPORT_PADDING = 8;
const ACTION_MENU_VERTICAL_GAP = 4;
const ACTION_MENU_HEIGHT = 104;

const SORT_OPTIONS: readonly { mode: PinnedTaskSortMode; labelKey: string }[] = [
  { mode: PinnedTaskSortMode.UpdatedAt, labelKey: 'myAgentSidebarPinnedSortUpdated' },
  { mode: PinnedTaskSortMode.Manual, labelKey: 'myAgentSidebarPinnedSortManual' },
];

const SortablePinnedTaskItem: React.FC<{
  id: string;
  disabled: boolean;
  children: React.ReactNode;
}> = ({ id, disabled, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const verticalTransform = transform
    ? `translate3d(0, ${Math.round(transform.y)}px, 0)`
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: verticalTransform,
        transition,
      }}
      className={`${disabled ? '' : 'cursor-grab active:cursor-grabbing'} ${isDragging ? 'relative z-50 opacity-85' : ''}`}
      {...(disabled ? {} : attributes)}
      {...(disabled ? {} : listeners)}
    >
      {children}
    </div>
  );
};

const PinnedTasksSection: React.FC<PinnedTasksSectionProps> = ({
  items,
  isCollapsed,
  sortMode,
  isBatchMode = false,
  onToggleCollapsed,
  onSortModeChange,
  onReorder,
  renderTask,
}) => {
  const [isExpandedAll, setIsExpandedAll] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ right: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const isMenuOpen = menuPosition !== null;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const calculateMenuPosition = useCallback(() => {
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const right = Math.max(ACTION_MENU_VIEWPORT_PADDING, window.innerWidth - rect.right);
    const top = Math.max(
      ACTION_MENU_VIEWPORT_PADDING,
      Math.min(
        rect.bottom + ACTION_MENU_VERTICAL_GAP,
        window.innerHeight - ACTION_MENU_HEIGHT - ACTION_MENU_VIEWPORT_PADDING,
      ),
    );

    return { right, top };
  }, []);

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
  }, []);

  const toggleMenu = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isMenuOpen) {
      closeMenu();
      return;
    }
    const position = calculateMenuPosition();
    if (position) {
      setMenuPosition(position);
    }
  };

  useEffect(() => {
    if (!isMenuOpen) return;
    const focusTimer = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();
    });
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeMenu, isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const updateMenuPosition = () => {
      const position = calculateMenuPosition();
      if (position) {
        setMenuPosition(position);
      } else {
        closeMenu();
      }
    };
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [calculateMenuPosition, closeMenu, isMenuOpen]);

  useEffect(() => {
    if (isBatchMode) {
      closeMenu();
    }
  }, [closeMenu, isBatchMode]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (menuItems.length === 0) return;
    event.preventDefault();
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? menuItems.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + menuItems.length) % menuItems.length
          : (currentIndex - 1 + menuItems.length) % menuItems.length;
    menuItems[nextIndex]?.focus();
  };

  if (items.length === 0) {
    return null;
  }

  const hasOverflow = items.length > AgentSidebarPageSize.PinnedPreview;
  const visibleItems = hasOverflow && !isExpandedAll
    ? items.slice(0, AgentSidebarPageSize.PinnedPreview)
    : items;
  const isDragEnabled = sortMode === PinnedTaskSortMode.Manual && !isBatchMode && visibleItems.length > 1;
  const sortHeading = i18nService.t('myAgentSidebarPinnedSort');
  const menuItemClassName =
    'flex h-8 w-full items-center justify-between gap-3 whitespace-nowrap rounded-lg px-2.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40';

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over?.id ? String(event.over.id) : '';
    if (!overId || activeId === overId) return;

    const visibleIds = visibleItems.map((item) => item.task.id);
    const oldIndex = visibleIds.indexOf(activeId);
    const newIndex = visibleIds.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

    const reorderedVisibleIds = arrayMove(visibleIds, oldIndex, newIndex);
    const hiddenIds = items.slice(visibleItems.length).map((item) => item.task.id);
    void onReorder([...reorderedVisibleIds, ...hiddenIds]);
  };

  const sortMenu = menuPosition ? (
    <div
      ref={menuRef}
      className="fixed z-[60] w-max min-w-[144px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-popover"
      style={{ top: menuPosition.top, right: menuPosition.right }}
      role="menu"
      aria-label={sortHeading}
      onKeyDown={handleMenuKeyDown}
    >
      <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-secondary/70">
        {sortHeading}
      </div>
      {SORT_OPTIONS.map((option) => {
        const isSelected = sortMode === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="menuitemradio"
            aria-checked={isSelected}
            onClick={(event) => {
              event.stopPropagation();
              closeMenu();
              onSortModeChange(option.mode);
            }}
            className={menuItemClassName}
          >
            <span className={isSelected ? 'font-medium' : 'font-normal'}>
              {i18nService.t(option.labelKey)}
            </span>
            {isSelected && (
              <CheckIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <section
      className="group/pinned-section"
      aria-label={i18nService.t('myAgentSidebarPinned')}
    >
      <div className="group/pinned-header sticky top-0 z-30 -mx-2.5 h-9 bg-[var(--lobster-sidebar-bg)] px-2.5">
        <div className="flex h-full items-center justify-between gap-1 pl-2.5 pr-2">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
            aria-expanded={!isCollapsed}
          >
            <span className="truncate text-[length:var(--lobster-text-sidebarMeta)] font-medium tracking-[0.01em] text-secondary transition-colors group-hover/pinned-header:text-foreground">
              {i18nService.t('myAgentSidebarPinned')}
            </span>
            {isCollapsed && (
              <span className="shrink-0 text-[11px] font-normal tabular-nums text-secondary/65">
                {items.length}
              </span>
            )}
            <ChevronRightIcon
              className={`h-3 w-3 shrink-0 text-secondary/75 transition-[opacity,transform] duration-150 motion-reduce:transition-none ${
                isCollapsed ? '' : 'rotate-90'
              } ${
                isMenuOpen
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/pinned-header:opacity-100 group-focus-within/pinned-header:opacity-100'
              }`}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>

          {!isBatchMode && (
            <button
              ref={menuButtonRef}
              type="button"
              onClick={toggleMenu}
              className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-[opacity,colors] duration-150 hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground focus:outline-none focus-visible:opacity-100 ${
                isMenuOpen
                  ? 'bg-[var(--lobster-sidebar-item-hover)] text-foreground opacity-100'
                  : 'opacity-0 group-hover/pinned-section:opacity-100 group-focus-within/pinned-section:opacity-100'
              }`}
              aria-label={sortHeading}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              title={sortHeading}
            >
              <EllipsisHorizontalIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <div role="tree" aria-label={i18nService.t('myAgentSidebarPinned')} className="space-y-0.5">
          {isDragEnabled ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={dismissAllTaskHoverCards}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={visibleItems.map((item) => item.task.id)}
                strategy={verticalListSortingStrategy}
              >
                {visibleItems.map((item) => (
                  <SortablePinnedTaskItem
                    key={`pinned-sort:${item.task.id}`}
                    id={item.task.id}
                    disabled={false}
                  >
                    {renderTask(item)}
                  </SortablePinnedTaskItem>
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            visibleItems.map(renderTask)
          )}
          {hasOverflow && (
            <button
              type="button"
              onClick={() => setIsExpandedAll((previous) => !previous)}
              className="flex min-h-[28px] py-1 w-full items-center rounded-[9px] pl-2.5 pr-2 text-left text-[length:var(--lobster-text-sidebarMeta)] text-secondary/80 transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground"
            >
              {isExpandedAll
                ? i18nService.t('myAgentSidebarCollapse')
                : i18nService.t('myAgentSidebarExpandMore')}
            </button>
          )}
        </div>
      )}

      {sortMenu && (typeof document !== 'undefined' ? createPortal(sortMenu, document.body) : sortMenu)}

      <div className={isCollapsed ? 'pb-0.5' : 'pb-0.5 pt-2'}>
        <div className="mx-0.5 border-t border-border/60" role="separator" />
      </div>
    </section>
  );
};

export default PinnedTasksSection;
