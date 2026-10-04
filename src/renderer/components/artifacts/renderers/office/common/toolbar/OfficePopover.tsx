import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A toolbar menu that opens under its button, above the editor and its own popups: it closes when
 * the pointer goes down elsewhere or on Escape. Its items keep the focus in the editor.
 */
export interface ToolbarPopover {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  anchor?: { left: number; top: number };
  trigger: React.RefObject<HTMLButtonElement>;
  panel: React.RefObject<HTMLDivElement>;
}

export function useToolbarPopover(width: number): ToolbarPopover {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: Math.max(8, Math.min(rect.right - 28, window.innerWidth - width - 8)), top: Math.round(rect.bottom + 4) });
  }, [open, width]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      const element = event.target as Node;
      if (!panel.current?.contains(element) && !trigger.current?.contains(element)) setOpen(false);
    };
    // Escape closes only the menu, not the dialog or the edit under it.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return { open, setOpen, anchor, trigger, panel };
}

export function ToolbarPopoverPanel({ popover, label, width, children }: {
  popover: ToolbarPopover; label: string; width: number; children: React.ReactNode;
}): React.ReactElement | null {
  if (!popover.open || !popover.anchor) return null;
  return createPortal(
    <div ref={popover.panel} className="lobster-office-popover" role="dialog" aria-label={label} style={{ left: popover.anchor.left, top: popover.anchor.top, width }}>
      {children}
    </div>,
    document.body,
  );
}

export interface SplitMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

/**
 * Office's split buttons: the button repeats the usual action, the arrow lists the others.
 */
export function OfficeSplitButton({ label, menuLabel, active, disabled, onClick, items, width = 180, children }: {
  label: string; menuLabel: string; active?: boolean; disabled: boolean; onClick: () => void; items: SplitMenuItem[]; width?: number; children: React.ReactNode;
}): React.ReactElement {
  const popover = useToolbarPopover(width);
  return (
    <span className="lobster-office-split">
      <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</button>
      <button ref={popover.trigger} type="button" className="lobster-office-split-arrow" title={menuLabel} aria-label={menuLabel} aria-expanded={popover.open}
        disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => popover.setOpen(value => !value)}>▾</button>
      <ToolbarPopoverPanel popover={popover} label={menuLabel} width={width}>
        {items.map(item => (
          <button key={item.key} type="button" className="lobster-office-menu-item" onMouseDown={event => event.preventDefault()}
            onClick={() => { popover.setOpen(false); item.onSelect(); }}>{item.label}</button>
        ))}
      </ToolbarPopoverPanel>
    </span>
  );
}
