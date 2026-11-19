import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import ExpertUpdateAction from '../experts/ExpertUpdateAction';

export default function ExpertUpdateBadge({ agentId, name, revision, focusRow }: {
  agentId: string; name: string; revision: number; focusRow: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const button = trigger.current;
    const menu = panel.current;
    if (!button || !menu) return;
    // Native light dismissal, Escape, and an implicit CSS anchor work outside the scrollable tree.
    menu.popover = 'auto';
    button.popoverTargetElement = menu;
    const sync = () => setOpen(menu.matches(':popover-open'));
    menu.addEventListener('toggle', sync);
    return () => { menu.removeEventListener('toggle', sync); button.popoverTargetElement = null; };
  }, []);

  const label = `${i18nService.t('expertUpdateAvailable')} · ${name}`;
  return <>
    <button type="button" ref={trigger} aria-label={label} title={label} aria-expanded={open} aria-controls={id}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary">
      <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
    <div ref={panel} id={id} role="group" aria-label={label}
      className="fixed inset-auto z-50 m-0 mt-1 w-44 rounded-xl border border-border bg-surface p-3 text-foreground shadow-lg [position-area:bottom] [position-try-fallbacks:flip-block,flip-inline] [&:not(:popover-open)]:hidden">
      <ExpertUpdateAction agentId={agentId} revision={revision} active={open} onDismiss={focusRow} />
    </div>
  </>;
}
