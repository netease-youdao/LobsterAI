import {
  ArrowPathIcon,
  ChevronRightIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { AccountMenuMoreItemKind } from '@shared/accountMenuMore/constants';
import React, {
  type FocusEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { resolveEnterpriseMenuFlyoutPosition } from '../features/enterpriseAccount/enterpriseMenuPosition';
import type {
  AccountMenuMoreGroup,
  AccountMenuMoreLink,
  AccountMenuMoreNode,
} from '../services/accountMenuMore';

const FLYOUT_CLOSE_DELAY_MS = 120;
// Wide enough that the trailing link and chevron icons read as their own column.
const flyoutRowClassName = 'flex w-full cursor-pointer items-center gap-12 rounded-lg px-2 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-surface-raised';

/** Rounded square open at the top-right with an arrow leaving it: marks links that open in the browser. */
const ExternalLinkIcon: React.FC = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5 shrink-0 text-secondary"
    aria-hidden="true"
  >
    <path d="M13 9v3.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12.5v-8A1.5 1.5 0 0 1 3.5 3H7" />
    <path d="M8 8l6-6" />
    <path d="M10 2h4v4" />
  </svg>
);

/**
 * Hover/click flyout anchored beside its trigger. Nested flyouts are React
 * descendants (through portals) of their parent flyout, so moving into a child
 * flyout does not fire mouseleave on the parent.
 */
function useAnchoredFlyout(contentKey: string) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const show = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  const hide = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
    setPosition(null);
  }, [clearCloseTimer]);

  const scheduleHide = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setPosition(null);
    }, FLYOUT_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const flyout = flyoutRef.current;
    if (!trigger || !flyout) return;
    const next = resolveEnterpriseMenuFlyoutPosition(
      trigger.getBoundingClientRect(),
      flyout.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition(previous => (
      previous && previous.left === next.left && previous.top === next.top ? previous : next
    ));
  }, []);

  // Content can change size while open (spinner -> links), so re-anchor on every change.
  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [contentKey, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const handleBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (
      next instanceof Node
      && (event.currentTarget.contains(next) || flyoutRef.current?.contains(next) || triggerRef.current?.contains(next))
    ) {
      return;
    }
    scheduleHide();
  }, [scheduleHide]);

  return { open, position, triggerRef, flyoutRef, show, hide, scheduleHide, handleBlur };
}

type AnchoredFlyout = ReturnType<typeof useAnchoredFlyout>;

const FlyoutPanel: React.FC<{ flyout: AnchoredFlyout; label: string; children: ReactNode }> = ({
  flyout,
  label,
  children,
}) => createPortal(
  <div
    ref={flyout.flyoutRef}
    data-account-menu-flyout="true"
    role="menu"
    aria-label={label}
    onMouseEnter={flyout.show}
    onMouseLeave={flyout.scheduleHide}
    onFocus={flyout.show}
    onBlur={flyout.handleBlur}
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      // Keyboard events bubble through portals; close only the innermost level.
      event.stopPropagation();
      flyout.hide();
      flyout.triggerRef.current?.focus();
    }}
    // Sized to the longest label (as Claude's submenu is), so the trailing icons sit close to the text.
    className="fixed z-[60] w-max min-w-[9rem] max-w-[min(16rem,calc(100vw-1rem))] rounded-xl border border-border bg-surface p-1.5 shadow-popover popover-enter"
    style={{
      left: flyout.position?.left ?? 0,
      top: flyout.position?.top ?? 0,
      visibility: flyout.position ? 'visible' : 'hidden',
    }}
  >
    {children}
  </div>,
  document.body,
);

const LinkRow: React.FC<{
  link: AccountMenuMoreLink;
  onOpenLink: (link: AccountMenuMoreLink) => void | Promise<void>;
}> = ({ link, onOpenLink }) => (
  <button
    type="button"
    role="menuitem"
    onClick={() => void onOpenLink(link)}
    className={flyoutRowClassName}
  >
    <span className="min-w-0 flex-1 truncate">{link.label}</span>
    <ExternalLinkIcon />
  </button>
);

const GroupRow: React.FC<{
  group: AccountMenuMoreGroup;
  onOpenLink: (link: AccountMenuMoreLink) => void | Promise<void>;
}> = ({ group, onOpenLink }) => {
  const flyout = useAnchoredFlyout(String(group.links.length));
  return (
    <>
      <button
        ref={flyout.triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={flyout.open}
        onMouseEnter={flyout.show}
        onMouseLeave={flyout.scheduleHide}
        onBlur={flyout.handleBlur}
        onClick={flyout.show}
        onKeyDown={event => {
          if (event.key === 'ArrowRight') flyout.show();
        }}
        className={`${flyoutRowClassName} ${flyout.open ? 'bg-surface-raised' : ''}`}
      >
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-secondary" aria-hidden="true" />
      </button>
      {flyout.open && (
        <FlyoutPanel flyout={flyout} label={group.label}>
          {group.links.map(link => (
            <LinkRow key={link.key} link={link} onOpenLink={onOpenLink} />
          ))}
        </FlyoutPanel>
      )}
    </>
  );
};

interface AccountMenuMoreEntryProps {
  title: string;
  emptyText: string;
  nodes: AccountMenuMoreNode[];
  /** True until the first lookup settles; shows a spinner rather than the empty text. */
  loading: boolean;
  onOpenLink: (link: AccountMenuMoreLink) => void | Promise<void>;
}

/**
 * Fixed "More" row in the account menu; hovering or clicking it opens a flyout of
 * server-configured web links, where a group row opens one further level.
 */
export const AccountMenuMoreEntry: React.FC<AccountMenuMoreEntryProps> = ({
  title,
  emptyText,
  nodes,
  loading,
  onOpenLink,
}) => {
  const flyout = useAnchoredFlyout(`${loading}:${nodes.length}`);

  let flyoutContent: ReactNode;
  if (nodes.length > 0) {
    flyoutContent = nodes.map(node => (
      node.kind === AccountMenuMoreItemKind.Group
        ? <GroupRow key={node.key} group={node} onOpenLink={onOpenLink} />
        : <LinkRow key={node.key} link={node} onOpenLink={onOpenLink} />
    ));
  } else if (loading) {
    flyoutContent = (
      <div className="flex justify-center px-2 py-2" aria-busy="true">
        <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-secondary" aria-hidden="true" />
      </div>
    );
  } else {
    flyoutContent = (
      <div className="px-2 py-2 text-[13px] text-secondary">{emptyText}</div>
    );
  }

  return (
    <>
      <button
        ref={flyout.triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={flyout.open}
        onMouseEnter={flyout.show}
        onMouseLeave={flyout.scheduleHide}
        onBlur={flyout.handleBlur}
        // Hover already opened it, so a click keeps it open instead of toggling it shut.
        onClick={flyout.show}
        onKeyDown={event => {
          if (event.key === 'ArrowRight') flyout.show();
          if (event.key === 'Escape') flyout.hide();
        }}
        className={`mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-surface-raised ${
          flyout.open ? 'bg-surface-raised' : ''
        }`}
      >
        <InformationCircleIcon className="h-4 w-4 shrink-0 text-[#111111] dark:text-white" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-secondary" aria-hidden="true" />
      </button>
      {flyout.open && typeof document !== 'undefined' && (
        <FlyoutPanel flyout={flyout} label={title}>
          {flyoutContent}
        </FlyoutPanel>
      )}
    </>
  );
};

export default AccountMenuMoreEntry;
