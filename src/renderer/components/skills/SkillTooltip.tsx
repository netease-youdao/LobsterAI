import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { i18nService } from '../../services/i18n';
import PuzzleIcon from '../icons/PuzzleIcon';

interface TooltipPosition {
  top: number;
  left: number;
  placement: 'right' | 'left' | 'top' | 'bottom';
}

interface SkillTooltipProps {
  /** Tooltip 触发的子元素 */
  children: React.ReactElement;
  /** 技能名称 */
  skillName: string;
  /** 技能完整描述 */
  description: string;
  /** 是否为官方技能 */
  isOfficial?: boolean;
  /** 延迟显示 ms，默认 300 */
  delay?: number;
  /** 优先方向，默认 'right' */
  preferredPlacement?: 'right' | 'left' | 'top' | 'bottom';
}

const TOOLTIP_WIDTH = 260;
const TOOLTIP_PADDING = 8; // 距离触发元素的间距
const VIEWPORT_MARGIN = 12; // 距离视窗边缘的安全距离

function computePosition(
  triggerRect: DOMRect,
  tooltipHeight: number,
  preferredPlacement: 'right' | 'left' | 'top' | 'bottom'
): TooltipPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceRight = vw - triggerRect.right - TOOLTIP_PADDING;
  const spaceLeft = triggerRect.left - TOOLTIP_PADDING;
  const spaceTop = triggerRect.top - TOOLTIP_PADDING;
  const spaceBottom = vh - triggerRect.bottom - TOOLTIP_PADDING;

  // 候选顺序：优先用传入的方向，然后依次尝试其余方向
  const order: Array<'right' | 'left' | 'top' | 'bottom'> = [
    preferredPlacement,
    'right',
    'left',
    'top',
    'bottom',
  ].filter((v, i, arr) => arr.indexOf(v) === i) as Array<'right' | 'left' | 'top' | 'bottom'>;

  for (const placement of order) {
    if (placement === 'right' && spaceRight >= TOOLTIP_WIDTH + VIEWPORT_MARGIN) {
      const top = Math.min(
        Math.max(VIEWPORT_MARGIN, triggerRect.top),
        vh - tooltipHeight - VIEWPORT_MARGIN
      );
      return { top, left: triggerRect.right + TOOLTIP_PADDING, placement: 'right' };
    }
    if (placement === 'left' && spaceLeft >= TOOLTIP_WIDTH + VIEWPORT_MARGIN) {
      const top = Math.min(
        Math.max(VIEWPORT_MARGIN, triggerRect.top),
        vh - tooltipHeight - VIEWPORT_MARGIN
      );
      return { top, left: triggerRect.left - TOOLTIP_PADDING - TOOLTIP_WIDTH, placement: 'left' };
    }
    if (placement === 'top' && spaceTop >= tooltipHeight + VIEWPORT_MARGIN) {
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, triggerRect.left + triggerRect.width / 2 - TOOLTIP_WIDTH / 2),
        vw - TOOLTIP_WIDTH - VIEWPORT_MARGIN
      );
      return { top: triggerRect.top - TOOLTIP_PADDING - tooltipHeight, left, placement: 'top' };
    }
    if (placement === 'bottom' && spaceBottom >= tooltipHeight + VIEWPORT_MARGIN) {
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, triggerRect.left + triggerRect.width / 2 - TOOLTIP_WIDTH / 2),
        vw - TOOLTIP_WIDTH - VIEWPORT_MARGIN
      );
      return { top: triggerRect.bottom + TOOLTIP_PADDING, left, placement: 'bottom' };
    }
  }

  // 兜底：右侧（可能超出，已是最大可用空间）
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, triggerRect.top),
    vh - tooltipHeight - VIEWPORT_MARGIN
  );
  return { top, left: triggerRect.right + TOOLTIP_PADDING, placement: 'right' };
}

const SkillTooltip: React.FC<SkillTooltipProps> = ({
  children,
  skillName,
  description,
  isOfficial = false,
  delay = 300,
  preferredPlacement = 'right',
}) => {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ top: 0, left: 0, placement: 'right' });
  const [tooltipHeight, setTooltipHeight] = useState(100);

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible) {
      // 等 tooltip DOM 渲染后再测量高度并修正位置
      requestAnimationFrame(() => {
        if (tooltipRef.current) {
          const h = tooltipRef.current.offsetHeight;
          setTooltipHeight(h);
          if (triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            setPosition(computePosition(rect, h, preferredPlacement));
          }
        }
      });
    }
  }, [visible, preferredPlacement]);

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    triggerRef.current = e.currentTarget as HTMLElement;
    showTimerRef.current = setTimeout(() => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition(computePosition(rect, tooltipHeight, preferredPlacement));
      setVisible(true);
    }, delay);
  }, [delay, tooltipHeight, preferredPlacement]);

  const handleMouseLeave = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    setVisible(false);
  }, []);

  useEffect(() => {
    return () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
    };
  }, []);

  const child = React.cloneElement(children, {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
  });

  // 箭头方向
  const arrowClass: Record<string, string> = {
    right: 'right-full top-4 border-r-[var(--color-tooltip-bg,#1e2030)] border-y-transparent border-l-transparent border-[6px]',
    left:  'left-full top-4 border-l-[var(--color-tooltip-bg,#1e2030)] border-y-transparent border-r-transparent border-[6px]',
    top:   'top-full left-1/2 -translate-x-1/2 border-t-[var(--color-tooltip-bg,#1e2030)] border-x-transparent border-b-transparent border-[6px]',
    bottom:'bottom-full left-1/2 -translate-x-1/2 border-b-[var(--color-tooltip-bg,#1e2030)] border-x-transparent border-t-transparent border-[6px]',
  };

  const tooltip = visible ? (
    <div
      ref={tooltipRef}
      role="tooltip"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: TOOLTIP_WIDTH,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
      className="animate-in fade-in zoom-in-95 duration-150"
      onMouseEnter={handleMouseLeave}
    >
      {/* Card */}
      <div className="relative rounded-xl border border-border bg-surface shadow-2xl overflow-hidden">
        {/* Arrow */}
        <span
          className={`absolute w-0 h-0 ${arrowClass[position.placement]}`}
          style={{ display: 'block' }}
        />

        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <PuzzleIcon className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground truncate flex-1">{skillName}</span>
          {isOfficial && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/10 text-primary flex-shrink-0">
              {i18nService.t('official')}
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="mx-4 h-px bg-border" />

        {/* Description */}
        <div className="px-4 py-3">
          <p className="text-xs leading-relaxed text-secondary whitespace-pre-wrap break-words">
            {description || i18nService.t('noDescription')}
          </p>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      {child}
      {typeof document !== 'undefined' && createPortal(tooltip, document.body)}
    </>
  );
};

export default SkillTooltip;
