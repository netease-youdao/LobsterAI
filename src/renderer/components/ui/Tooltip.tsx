import React, { useCallback, useEffect, useRef, useState } from 'react';

export const TooltipPosition = {
  Top: 'top',
  Bottom: 'bottom',
} as const;
export type TooltipPosition = typeof TooltipPosition[keyof typeof TooltipPosition];

export const TooltipAlign = {
  Start: 'start',
  Center: 'center',
  End: 'end',
} as const;
export type TooltipAlign = typeof TooltipAlign[keyof typeof TooltipAlign];

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
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

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
      setIsVisible(true);
    }, delay);
  }, [delay, disabled]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  useEffect(() => () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
  }, []);

  return (
    <div
      className={`relative ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocusCapture={showTooltip}
      onBlurCapture={hideTooltip}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          hideTooltip();
        }
      }}
    >
      {children}
      {isVisible && content && (
        <div
          role="tooltip"
          style={{ maxWidth }}
          className={`absolute z-[100] pointer-events-none rounded-md border border-border
            bg-surface-overlay px-2 py-1 text-[11px] leading-4 text-foreground shadow-lg
            ${multiline ? 'w-max whitespace-pre-wrap break-words text-left' : 'whitespace-nowrap'}
            backdrop-blur-sm ${positionClassName} ${alignClassName}`}
        >
          {content}
        </div>
      )}
    </div>
  );
};

export default Tooltip;
