import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';

interface ArtifactPreviewTabMenuProps {
  position: { x: number; y: number };
  onDismiss: () => void;
  onCloseTab: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
}

export default function ArtifactPreviewTabMenu({ position, onDismiss, onCloseTab, onCloseOthers, onCloseToRight }: ArtifactPreviewTabMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(position);
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setOffset({
      x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8)),
    });
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [position]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
    };
  }, [onDismiss]);
  return createPortal(<div ref={ref} role="menu" aria-label={i18nService.t('artifactTabActions')}
    className="fixed z-[10000] min-w-48 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-surface-raised p-1.5 shadow-popover"
    style={{ left: offset.x, top: offset.y }}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Tab') { event.preventDefault(); onDismiss(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
    {[
      { label: 'artifactCloseTab', action: onCloseTab },
      { label: 'artifactCloseOtherTabs', action: onCloseOthers },
      { label: 'artifactCloseTabsToRight', action: onCloseToRight },
    ].map(({ label, action }) => <button key={label} role="menuitem" type="button" disabled={!action}
      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-primary/10 focus:bg-primary/10 focus:outline-none disabled:cursor-default disabled:opacity-35"
      onClick={() => { onDismiss(); action?.(); }}>{i18nService.t(label)}</button>)}
  </div>, document.body);
}
