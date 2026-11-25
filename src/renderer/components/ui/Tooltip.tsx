import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  computePortalTooltipPosition,
  type PortalTooltipPosition,
  TooltipAlign,
  TooltipPosition,
} from './tooltipPosition';

export { TooltipAlign, TooltipPosition };

const TOOLTIP_SHOW_EVENT = 'lobster:tooltip-show';

export const TOOLTIP_DARK_BUBBLE_CLASS_NAME =
  'bg-[#262626] text-white dark:border dark:border-white/10 dark:bg-[#3a3a3a]';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  position?: TooltipPosition;
  align?: TooltipAlign;
  delay?: number;
  maxWidth?: string;
  disabled?: boolean;
  multiline?: boolean;
  portal?: boolean;
  // Replaces the default border, background and text colour of the bubble.
  bubbleClassName?: string;
}

const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  className = '',
  position = TooltipPosition.Bottom,
  align = TooltipAlign.Center,
  delay = 400,
  maxWidth = '18rem',
  disabled = false,
  multiline = false,
  portal = false,
  bubbleClassName = 'border border-border bg-surface-overlay text-foreground',
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [portalPosition, setPortalPosition] = useState<PortalTooltipPosition | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const showContent = isVisible && !disabled && Boolean(content);

  const positionClassName = position === TooltipPosition.Top
    ? 'bottom-full mb-2'
    : 'top-full mt-2';
  const alignClassName = align === TooltipAlign.Start
    ? 'left-0'
    : align === TooltipAlign.End
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2';

  const showTooltip = useCallback(() => {
    if (disabled) return;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      window.dispatchEvent(new CustomEvent(TOOLTIP_SHOW_EVENT, { detail: tooltipId }));
      setIsVisible(true);
    }, delay);
  }, [delay, disabled, tooltipId]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  useEffect(() => {
    if (disabled) hideTooltip();
  }, [disabled, hideTooltip]);

  useEffect(() => {
    const onTooltipShow = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== tooltipId) hideTooltip();
    };
    window.addEventListener(TOOLTIP_SHOW_EVENT, onTooltipShow);
    return () => window.removeEventListener(TOOLTIP_SHOW_EVENT, onTooltipShow);
  }, [hideTooltip, tooltipId]);

  useEffect(() => {
    if (!isVisible) return undefined;
    window.addEventListener('blur', hideTooltip);
    return () => window.removeEventListener('blur', hideTooltip);
  }, [hideTooltip, isVisible]);

  useEffect(() => () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!portal || !showContent) {
      setPortalPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      const triggerEl = triggerRef.current;
      const bubbleEl = bubbleRef.current;
      if (!triggerEl || !bubbleEl) return;

      const anchorRect = triggerEl.getBoundingClientRect();
      if (anchorRect.width === 0 && anchorRect.height === 0) {
        hideTooltip();
        return;
      }

      const bubbleRect = bubbleEl.getBoundingClientRect();
      const next = computePortalTooltipPosition({
        anchorRect,
        bubbleSize: { width: bubbleRect.width, height: bubbleRect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        position,
        align,
      });
      setPortalPosition((prev) => (
        prev
          && prev.left === next.left
          && prev.top === next.top
          && prev.placement === next.placement
          ? prev
          : next
      ));
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [align, content, hideTooltip, maxWidth, multiline, portal, position, showContent]);

  const bubbleCommonClassName = `pointer-events-none rounded-md ${bubbleClassName}
    px-2 py-1 text-[11px] leading-4 shadow-lg
    ${multiline ? 'w-max whitespace-pre-wrap break-words text-left' : 'whitespace-nowrap'}
    backdrop-blur-sm`;

  return (
    <div
      ref={triggerRef}
      className={`relative ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocusCapture={showTooltip}
      onBlurCapture={hideTooltip}
      onPointerDownCapture={hideTooltip}
      onClickCapture={hideTooltip}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && showContent) {
          event.preventDefault();
          event.stopPropagation();
          hideTooltip();
        }
      }}
    >
      {showContent && React.isValidElement<{ 'aria-describedby'?: string }>(children)
        ? React.cloneElement(children, {
          'aria-describedby': [children.props['aria-describedby'], tooltipId].filter(Boolean).join(' '),
        })
        : children}
      {showContent && (
        portal && typeof document !== 'undefined'
          ? createPortal(
              <div
                ref={bubbleRef}
                id={tooltipId}
                role="tooltip"
                style={portalPosition
                  ? { left: portalPosition.left, top: portalPosition.top, maxWidth }
                  : { left: 0, top: 0, maxWidth, visibility: 'hidden' }}
                className={`fixed z-[9999] ${bubbleCommonClassName}`}
              >
                {content}
              </div>,
              document.body,
            )
          : (
              <div
                id={tooltipId}
                role="tooltip"
                style={{ maxWidth }}
                className={`absolute z-[100] ${bubbleCommonClassName} ${positionClassName} ${alignClassName}`}
              >
                {content}
              </div>
            )
      )}
    </div>
  );
};

export default Tooltip;
