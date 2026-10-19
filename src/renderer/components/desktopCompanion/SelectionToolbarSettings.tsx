import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TrashIcon, XMarkIcon } from '@heroicons/react/20/solid';
import { NoSymbolIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import type { DesktopCompanionPreferences } from '../../../shared/desktopCompanion/constants';
import { type CompanionSelectionApp, companionSelectionAppFallback } from '../../../shared/desktopCompanion/selectionApps';
import {
  COMPANION_TOOLBAR_VISIBLE_COUNT,
  type CompanionToolbarItem,
  DEFAULT_COMPANION_TOOLBAR_ORDER,
  normalizeCompanionToolbarOrder,
} from '../../../shared/desktopCompanion/selectionToolbar';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import { COMPANION_TOOLBAR_PRESENTATION } from './selectionToolbarPresentation';

const t = (key: string) => i18nService.t(key);
const toolLabel = (item: CompanionToolbarItem) => t(COMPANION_TOOLBAR_PRESENTATION[item].labelKey);

function SortableTool({ item, disabled }: {
  item: CompanionToolbarItem;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item, disabled });
  const { icon: Icon } = COMPANION_TOOLBAR_PRESENTATION[item];
  return (
    <li
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={'relative flex items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 ' + (isDragging ? 'z-10 border-primary shadow-lg' : 'border-border')}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('desktopCompanionToolbarDrag').replace('{name}', toolLabel(item))}
        aria-disabled={disabled}
        className="grid h-7 w-5 shrink-0 touch-none cursor-grab place-items-center rounded text-secondary hover:text-foreground focus-visible:outline-primary active:cursor-grabbing aria-disabled:opacity-40"
      >
        <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
          {[3, 9, 15].map(y => <g key={y}><circle cx="3" cy={y} r="1.5" /><circle cx="9" cy={y} r="1.5" /></g>)}
        </svg>
      </button>
      <Icon className="h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{toolLabel(item)}</span>
    </li>
  );
}

export default function SelectionToolbarSettings({ preferences, saving, error, onUpdate, onClose }: {
  preferences: DesktopCompanionPreferences;
  saving: boolean;
  error: string;
  onUpdate(patch: Partial<DesktopCompanionPreferences>): Promise<void>;
  onClose(): void;
}) {
  const [apps, setApps] = useState<CompanionSelectionApp[]>([]);
  const [dragging, setDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const order = normalizeCompanionToolbarOrder(preferences.selectionToolbarOrder);
  const excluded = preferences.selectionExcludedApps;
  const excludedKey = JSON.stringify(excluded);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    let active = true;
    void window.electron.desktopCompanion.getSelectionExcludedApps().then(result => {
      if (active) setApps(result);
    }).catch(() => { if (active) setApps([]); });
    return () => { active = false; };
  }, [excludedKey]);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const move = (from: number, to: number) => {
    if (saving || from < 0 || to < 0 || from === to) return;
    void onUpdate({ selectionToolbarOrder: arrayMove(order, from, to) });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (over) move(order.indexOf(active.id as CompanionToolbarItem), order.indexOf(over.id as CompanionToolbarItem));
  };
  const positionAnnouncement = (id: string | number, overId?: string | number) => t('desktopCompanionToolbarPosition')
    .replace('{name}', toolLabel(id as CompanionToolbarItem))
    .replace('{position}', String(order.indexOf((overId ?? id) as CompanionToolbarItem) + 1));

  return (
    <Modal onClose={onClose} onEscape={dragging ? undefined : onClose}
      className="mx-4 flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="selection-toolbar-settings-title" className="flex min-h-0 flex-col"
        onKeyDown={event => {
          if (event.key !== 'Tab') return;
          const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          if (!buttons?.length) return;
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h3 id="selection-toolbar-settings-title" className="text-base font-semibold text-foreground">{t('desktopCompanionSelection')}</h3>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t('close')} className="rounded-lg p-1.5 text-secondary hover:bg-secondary/10 hover:text-foreground">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 space-y-6 overflow-y-auto p-6">
          <section aria-labelledby="selection-toolbar-order-title">
            <div className="flex items-center justify-between gap-3">
              <h4 id="selection-toolbar-order-title" className="text-sm font-semibold text-foreground">{t('desktopCompanionToolbarOrder')}</h4>
              <button type="button" disabled={saving || order.every((item, index) => item === DEFAULT_COMPANION_TOOLBAR_ORDER[index])}
                className="text-xs text-primary disabled:text-secondary disabled:opacity-50"
                onClick={() => { void onUpdate({ selectionToolbarOrder: [...DEFAULT_COMPANION_TOOLBAR_ORDER] }); }}>
                {t('desktopCompanionToolbarReset')}
              </button>
            </div>
            <p className="mb-3 mt-1 text-xs leading-5 text-secondary">{t('desktopCompanionToolbarOrderDescription').replace('{count}', String(COMPANION_TOOLBAR_VISIBLE_COUNT))}</p>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => setDragging(true)} onDragCancel={() => setDragging(false)} onDragEnd={onDragEnd}
              accessibility={{
                screenReaderInstructions: { draggable: t('desktopCompanionToolbarKeyboard') },
                announcements: {
                  onDragStart: ({ active }) => positionAnnouncement(active.id),
                  onDragOver: ({ active, over }) => positionAnnouncement(active.id, over?.id),
                  onDragEnd: ({ active, over }) => positionAnnouncement(active.id, over?.id),
                  onDragCancel: () => t('desktopCompanionToolbarDragCancelled'),
                },
              }}>
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <ol className="space-y-2">
                  {order.map(item => <SortableTool key={item} item={item} disabled={saving} />)}
                </ol>
              </SortableContext>
            </DndContext>
          </section>
          <section aria-labelledby="selection-excluded-apps-title">
            <h4 id="selection-excluded-apps-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              {t('desktopCompanionExcludedApps')}
              <span className="rounded-md bg-secondary/10 px-1.5 py-0.5 text-xs font-normal text-secondary">{excluded.length}</span>
            </h4>
            <p className="mb-3 mt-1 text-xs leading-5 text-secondary">{t('desktopCompanionExcludedAppsDescription')}</p>
            {excluded.length ? (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {excluded.map(id => {
                  const app = apps.find(item => item.id === id) ?? companionSelectionAppFallback(id);
                  return (
                    <li key={id} title={id} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-secondary/5">
                        {app.icon ? <img src={app.icon} alt="" className="h-8 w-8 object-contain" /> : <Squares2X2Icon className="h-5 w-5 text-secondary" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{app.name}</span>
                      <button type="button" disabled={saving} title={t('desktopCompanionRemoveExcludedApp')}
                        aria-label={`${t('desktopCompanionRemoveExcludedApp')} · ${app.name}`}
                        className="shrink-0 rounded-md p-1.5 text-secondary hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                        onClick={() => { void onUpdate({ selectionExcludedApps: excluded.filter(item => item !== id) }); }}>
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-4 text-sm text-secondary">
                <NoSymbolIcon className="h-5 w-5 shrink-0" />{t('desktopCompanionExcludedAppsNone')}
              </div>
            )}
          </section>
        </div>
        {error && (
          <footer className="shrink-0 border-t border-border px-6 py-3 text-xs text-red-500" role="alert">
            {error}
          </footer>
        )}
      </div>
    </Modal>
  );
}
