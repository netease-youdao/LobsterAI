import {
  encodeAgentAvatarIcon,
  parseAgentAvatarImageUrl,
} from '@shared/agent/avatar';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import { isDismissEscapeEvent } from '../common/modalEscape';
import PencilIcon from '../icons/PencilIcon';
import Tooltip, { TooltipPosition } from '../ui/Tooltip';
import AgentAvatarIcon, {
  AGENT_AVATAR_SVG_OPTIONS,
} from './AgentAvatarIcon';
import {
  AgentAvatarPickerAlign,
  AgentAvatarPickerVariant,
  AVATAR_PICKER_ESTIMATED_HEIGHT_PX,
  AVATAR_PICKER_POPOVER_WIDTH_PX,
  type AvatarPopoverPosition,
  computeAvatarPopoverPosition,
  resolveSelectedAvatarSvg,
} from './agentAvatarPickerHelpers';

export { AgentAvatarPickerAlign, AgentAvatarPickerVariant };

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface AgentAvatarPickerProps {
  value: string;
  onChange: (value: string) => void;
  expertFallback?: boolean;
  variant?: AgentAvatarPickerVariant;
  align?: AgentAvatarPickerAlign;
  closeOnSelect?: boolean;
  tooltip?: string;
  ariaLabel?: string;
}

const AgentAvatarPicker: React.FC<AgentAvatarPickerProps> = ({
  value,
  onChange,
  expertFallback,
  variant = AgentAvatarPickerVariant.Compact,
  align,
  closeOnSelect,
  tooltip,
  ariaLabel,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<AvatarPopoverPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const isHero = variant === AgentAvatarPickerVariant.Hero;
  const resolvedAlign = align ?? (isHero ? AgentAvatarPickerAlign.Center : AgentAvatarPickerAlign.Start);
  const resolvedCloseOnSelect = closeOnSelect ?? isHero;
  const hasImageAvatar = Boolean(parseAgentAvatarImageUrl(value)) || Boolean(expertFallback);
  const triggerLabel = ariaLabel ?? i18nService.t('agentAvatarPickerTitle');

  const selectedSvg = useMemo(
    () => resolveSelectedAvatarSvg(value, expertFallback),
    [expertFallback, value],
  );

  const updatePopoverPosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const measuredHeight = popoverRef.current?.offsetHeight || AVATAR_PICKER_ESTIMATED_HEIGHT_PX;
    setPopoverPosition(computeAvatarPopoverPosition({
      anchorRect: rect,
      popoverWidth: AVATAR_PICKER_POPOVER_WIDTH_PX,
      popoverHeight: measuredHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      align: resolvedAlign,
    }));
  }, [resolvedAlign]);

  useIsomorphicLayoutEffect(() => {
    if (!isOpen) {
      setPopoverPosition(null);
      return;
    }
    updatePopoverPosition();
  }, [isOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current?.contains(target)
        || popoverRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isDismissEscapeEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    const handleScroll = (event: Event) => {
      if (popoverRef.current && event.target instanceof Node && popoverRef.current.contains(event.target)) {
        return;
      }
      setIsOpen(false);
    };

    const handleResize = () => {
      updatePopoverPosition();
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, updatePopoverPosition]);

  const handleSelectSvg = (svg: (typeof AGENT_AVATAR_SVG_OPTIONS)[number]['svg']) => {
    onChange(encodeAgentAvatarIcon({ svg }));
    if (resolvedCloseOnSelect) {
      setIsOpen(false);
    }
  };

  const triggerButton = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setIsOpen((prev) => !prev)}
      title={tooltip ? undefined : triggerLabel}
      aria-label={triggerLabel}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      className={isHero
        ? `group relative flex h-14 w-14 cursor-pointer items-center justify-center rounded-full transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
            hasImageAvatar
              ? isOpen
                ? 'ring-2 ring-foreground/25'
                : 'hover:ring-2 hover:ring-foreground/15'
              : isOpen
                ? 'border border-border bg-surface-raised/70 shadow-[0_4px_12px_rgba(0,0,0,0.08)] ring-2 ring-foreground/15'
                : 'border border-border/70 bg-surface shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:border-border hover:bg-surface-raised/60 hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)]'
          }`
        : `relative flex rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 ${
            isOpen ? 'bg-secondary/15 ring-2 ring-foreground/25' : 'bg-surface-raised hover:bg-secondary/15'
          }`}
    >
      <AgentAvatarIcon
        value={value}
        expertFallback={expertFallback}
        className={isHero ? 'h-full w-full' : 'h-11 w-11'}
        iconClassName={isHero ? 'h-7 w-7' : 'h-[22px] w-[22px]'}
      />
      <span
        aria-hidden="true"
        className={isHero
          ? `pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-surface ring-2 ring-surface transition-all duration-150 ${
              isOpen
                ? 'scale-100 opacity-100'
                : 'scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100'
            }`
          : 'absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-foreground text-surface ring-2 ring-surface'}
      >
        <PencilIcon className="h-2.5 w-2.5" />
      </span>
    </button>
  );

  const popover = isOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={triggerLabel}
        style={
          popoverPosition
            ? { top: popoverPosition.top, left: popoverPosition.left, width: AVATAR_PICKER_POPOVER_WIDTH_PX }
            : { top: -9999, left: -9999, width: AVATAR_PICKER_POPOVER_WIDTH_PX, visibility: 'hidden' }
        }
        className="fixed z-[60] overflow-hidden rounded-2xl border border-border bg-surface shadow-popover"
      >
        {resolvedCloseOnSelect && (
          <div className="px-4 pt-3.5 pb-1 text-left text-xs font-medium text-secondary">
            {triggerLabel}
          </div>
        )}
        <div
          className={`grid max-h-[min(360px,calc(100vh-16px))] grid-cols-6 gap-2.5 overflow-y-auto px-4 ${
            resolvedCloseOnSelect ? 'pt-2 pb-4' : 'py-4'
          }`}
        >
          {AGENT_AVATAR_SVG_OPTIONS.map((option) => {
            const optionValue = encodeAgentAvatarIcon({ svg: option.svg });
            const isSelected = selectedSvg === option.svg;

            return (
              <button
                key={option.svg}
                type="button"
                onClick={() => handleSelectSvg(option.svg)}
                title={i18nService.t(option.labelKey)}
                aria-label={i18nService.t(option.labelKey)}
                aria-pressed={isSelected}
                className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-foreground/30 ${
                  isSelected
                    ? 'bg-surface-raised text-foreground shadow-sm ring-1 ring-border'
                    : 'text-foreground hover:bg-secondary/10'
                }`}
              >
                <AgentAvatarIcon
                  value={optionValue}
                  className="h-10 w-10"
                  iconClassName="h-6 w-6"
                />
              </button>
            );
          })}
        </div>

        {!resolvedCloseOnSelect && (
          <div className="border-t border-border px-5 py-3.5">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-sm font-medium text-foreground transition-opacity hover:opacity-75"
            >
              {i18nService.t('agentAvatarPickerDone')}
            </button>
          </div>
        )}
      </div>,
      document.body,
    )
    : null;

  return (
    <div ref={containerRef} className="relative shrink-0">
      {tooltip ? (
        <Tooltip content={tooltip} position={TooltipPosition.Top} disabled={isOpen}>
          {triggerButton}
        </Tooltip>
      ) : triggerButton}
      {popover}
    </div>
  );
};

export default AgentAvatarPicker;
