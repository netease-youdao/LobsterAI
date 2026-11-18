import { ArrowTopRightOnSquareIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import {
  createModalEscapeLayerId,
  isDismissEscapeEvent,
  isTopModalEscapeLayer,
  registerModalEscapeLayer,
  unregisterModalEscapeLayer,
} from '../common/modalEscape';
import { choosePopoverPlacement } from '../cowork/popoverPlacement';
import VipDiamondLineIcon from '../icons/VipDiamondLineIcon';

interface ModelAccessPromptPopoverProps {
  anchorRef: React.RefObject<HTMLElement>;
  title: string;
  description: string;
  primaryLabel: string;
  purchase: boolean;
  pending: boolean;
  onPrimary: () => void;
  onClose: () => void;
  onChooseModel?: () => void;
  children?: React.ReactNode;
}

const POPOVER_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

/** A non-modal prompt for transparent companion windows: only the card intercepts clicks. */
export default function ModelAccessPromptPopover({
  anchorRef, title, description, primaryLabel, purchase, pending,
  onPrimary, onClose, onChooseModel, children,
}: ModelAccessPromptPopoverProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [layerId] = useState(createModalEscapeLayerId);
  const [position, setPosition] = useState<React.CSSProperties>({ opacity: 0 });
  const titleId = React.useId();
  const descriptionId = React.useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    // Clear the whole input card, so the prompt never covers the user's draft.
    const anchor = anchorRef.current?.closest('[data-model-access-anchor]') ?? anchorRef.current;
    const updatePosition = () => {
      const card = cardRef.current;
      if (!anchor || !card) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      const height = card.getBoundingClientRect().height;
      const placement = choosePopoverPlacement(rect,
        { top: VIEWPORT_MARGIN, bottom: window.innerHeight - VIEWPORT_MARGIN },
        { left: VIEWPORT_MARGIN, right: window.innerWidth - VIEWPORT_MARGIN },
        { preferredAlign: 'right', estimatedHeight: height + ANCHOR_GAP, desiredWidth: width });
      const left = placement.alignSide === 'right' ? rect.right - width : rect.left;
      const top = placement.direction === 'up' ? rect.top - height - ANCHOR_GAP : rect.bottom + ANCHOR_GAP;
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - height - VIEWPORT_MARGIN)),
      });
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (cardRef.current) observer.observe(cardRef.current);
    if (anchor) observer.observe(anchor);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const card = cardRef.current;
    const trigger = anchorRef.current?.querySelector('button');
    registerModalEscapeLayer(layerId);
    card?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isDismissEscapeEvent(event) || !isTopModalEscapeLayer(layerId)) return;
      event.preventDefault();
      closeRef.current();
    };
    const handleOutside = (event: Event) => {
      if (event.target instanceof Node && !card?.contains(event.target)) closeRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('focusin', handleOutside);
    return () => {
      unregisterModalEscapeLayer(layerId);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handleOutside, true);
      document.removeEventListener('focusin', handleOutside);
      if (trigger?.isConnected && (card?.contains(document.activeElement) || document.activeElement === document.body)) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [anchorRef, layerId]);

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      style={{ ...position, width: POPOVER_WIDTH, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)' }}
      className="non-draggable fixed z-[10050] cursor-default overflow-y-auto rounded-2xl border border-border bg-surface p-4 text-foreground shadow-popover outline-none"
    >
      <div className="flex items-center gap-2.5">
        {purchase && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300" aria-hidden="true">
            <VipDiamondLineIcon className="h-[18px] w-[18px]" />
          </span>
        )}
        <h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold leading-5">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={i18nService.t('close')}
          className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
      <p id={descriptionId} className="mt-3 text-[13px] leading-5 text-secondary">{description}</p>
      {children}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {onChooseModel && (
          <button type="button" onClick={onChooseModel} className="rounded-lg px-3 py-2 text-[13px] font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            {i18nService.t('modelSelectorChooseAnother')}
          </button>
        )}
        <button
          type="button"
          onClick={onPrimary}
          disabled={pending}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-wait disabled:opacity-50"
        >
          {primaryLabel}
          {purchase && <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>
    </div>,
    document.body,
  );
}
