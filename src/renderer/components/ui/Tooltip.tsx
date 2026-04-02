import React, { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  maxWidth?: string;
  disabled?: boolean;
}

const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  className = '',
  position = 'top',
  delay = 300,
  maxWidth = '280px',
  disabled = false,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const showTooltip = useCallback(() => {
    if (disabled) return;
    timeoutRef.current = setTimeout(() => {
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

  const updatePosition = useCallback(() => {
    if (!wrapperRef.current || !tooltipRef.current) return;
    const anchorRect = wrapperRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 8;
    type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

    const positions = {
      top: {
        top: anchorRect.top - tooltipRect.height - margin,
        left: anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      },
      bottom: {
        top: anchorRect.bottom + margin,
        left: anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      },
      left: {
        top: anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2,
        left: anchorRect.left - tooltipRect.width - margin,
      },
      right: {
        top: anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2,
        left: anchorRect.right + margin,
      },
    };

    const fits = (pos: { top: number; left: number }) =>
      pos.top >= margin &&
      pos.left >= margin &&
      pos.top + tooltipRect.height <= viewportHeight - margin &&
      pos.left + tooltipRect.width <= viewportWidth - margin;

    const fallbackOrderMap: Record<TooltipPosition, TooltipPosition[]> = {
      top: ['top', 'bottom', 'right', 'left'],
      bottom: ['bottom', 'top', 'right', 'left'],
      left: ['left', 'right', 'top', 'bottom'],
      right: ['right', 'left', 'top', 'bottom'],
    };
    const fallbackOrder = fallbackOrderMap[position];

    let chosen = positions[fallbackOrder[0]];
    for (const key of fallbackOrder) {
      const candidate = positions[key];
      if (fits(candidate)) {
        chosen = candidate;
        break;
      }
    }

    const clampedLeft = Math.min(
      Math.max(chosen.left, margin),
      viewportWidth - tooltipRect.width - margin
    );
    const clampedTop = Math.min(
      Math.max(chosen.top, margin),
      viewportHeight - tooltipRect.height - margin
    );

    setTooltipStyle({
      position: 'fixed',
      top: Math.round(clampedTop),
      left: Math.round(clampedLeft),
      maxWidth,
      width: 'max-content',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    });
  }, [maxWidth, position]);

  useLayoutEffect(() => {
    if (!isVisible) return;
    updatePosition();
  }, [isVisible, updatePosition, content]);

  useEffect(() => {
    if (!isVisible) return;
    const handleUpdate = () => updatePosition();
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);
    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [isVisible, updatePosition]);

  return (
    <div
      ref={wrapperRef}
      className={`relative inline-block ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
    >
      {children}
      {isVisible && content && (
        <div
          ref={tooltipRef}
          className={`absolute z-[100] px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl shadow-xl
            bg-background
            text-foreground
            border-border border`}
          style={tooltipStyle ?? { maxWidth }}
        >
          {content}
        </div>
      )}
    </div>
  );
};

export default Tooltip;
