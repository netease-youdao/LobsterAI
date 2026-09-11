import type { OwnershipTarget } from '@shared/ownership/types';
import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { ownershipService } from '../../services/ownership';
import OwnershipDetailContent from './OwnershipDetailContent';
import { OWNERSHIP_CLOSE_DELAY, OWNERSHIP_HOVER_DELAY, ownershipCardPosition } from './position';
import { useOwnershipDetail } from './useOwnershipDetail';

export function useOwnershipHover(target: OwnershipTarget, disabled: boolean) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const panel = useSyncExternalStore(ownershipService.subscribe, ownershipService.getSnapshot, ownershipService.getSnapshot);
  const revision = useSyncExternalStore(ownershipService.subscribeChange, ownershipService.getRevision, ownershipService.getRevision);
  const detail = useOwnershipDetail(target, !!anchor && !disabled && !panel);
  const clearTimer = () => { clearTimeout(timer.current); };
  const close = () => { clearTimer(); setAnchor(null); };
  const leave = () => { clearTimer(); timer.current = setTimeout(() => setAnchor(null), OWNERSHIP_CLOSE_DELAY); };
  const enter = (element: HTMLElement) => {
    clearTimer();
    if (disabled || panel) return;
    timer.current = setTimeout(() => setAnchor(element.getBoundingClientRect()), OWNERSHIP_HOVER_DELAY);
  };
  useEffect(() => {
    clearTimeout(timer.current);
    setAnchor(null);
  }, [disabled, panel, revision, target.id]);
  useEffect(() => {
    const dismiss = () => { clearTimeout(timer.current); setAnchor(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const visible = anchor && detail && !disabled && !panel;
  const position = anchor ? ownershipCardPosition(anchor, { width: window.innerWidth, height: window.innerHeight }, { width: 300, height: 290 }) : null;
  const card = visible ? createPortal(<div
    id={id} role="tooltip" className="fixed z-[70] max-h-[calc(100vh-16px)] overflow-auto rounded-xl border border-border bg-surface p-4 shadow-xl"
    style={{ ...position!, maxHeight: window.innerHeight - position!.top - 8 }}
    onMouseEnter={clearTimer} onMouseLeave={leave}
  ><OwnershipDetailContent detail={detail} compact /></div>, document.body) : null;
  return {
    card, close,
    handlers: {
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => enter(event.currentTarget),
      onMouseLeave: leave,
      onFocus: (event: React.FocusEvent<HTMLElement>) => { if (event.target === event.currentTarget) enter(event.currentTarget); },
      onBlur: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); },
      'aria-describedby': visible ? id : undefined,
    },
  };
}
