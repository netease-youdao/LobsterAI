import { useSortable } from '@dnd-kit/sortable';
import React from 'react';

interface SortablePluginRowProps {
  id: string;
  showHandle: boolean;
  disabled: boolean;
  dragHandleLabel: string;
  children: (dragHandle: React.ReactNode) => React.ReactNode;
}

export const SortablePluginRow: React.FC<SortablePluginRowProps> = ({
  id,
  showHandle,
  disabled,
  dragHandleLabel,
  children,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const verticalTransform = transform
    ? `translate3d(0, ${Math.round(transform.y)}px, 0)`
    : undefined;

  const dragHandle = showHandle ? (
    <button
      ref={setActivatorNodeRef}
      type="button"
      disabled={disabled}
      {...(disabled ? {} : attributes)}
      {...(disabled ? {} : listeners)}
      title={dragHandleLabel}
      aria-label={dragHandleLabel}
      className="mt-1 grid h-7 w-5 shrink-0 touch-none cursor-grab place-items-center rounded text-secondary/60 transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
    >
      <svg width="10" height="16" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
        {[3, 9, 15].map((y) => (
          <g key={y}>
            <circle cx="3" cy={y} r="1.4" />
            <circle cx="9" cy={y} r="1.4" />
          </g>
        ))}
      </svg>
    </button>
  ) : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: verticalTransform,
        transition,
      }}
      className={`px-4 py-3.5 ${
        isDragging ? 'relative z-10 rounded-xl bg-surface shadow-lg ring-1 ring-primary/35' : ''
      }`}
    >
      {children(dragHandle)}
    </div>
  );
};
