import React from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkContextUsage } from '../../types/cowork';
import { formatTokenCount } from '../../utils/tokenFormat';

interface ContextUsageIndicatorProps {
  usage?: CoworkContextUsage;
  compacting?: boolean;
  disabled?: boolean;
  onCompact?: () => void;
  className?: string;
  showTooltip?: boolean;
  active?: boolean;
}

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const formatTooltip = (usage: CoworkContextUsage | undefined, showActionHint: boolean): string => {
  if (!usage || typeof usage.percent !== 'number') {
    return i18nService.t('coworkContextUsageUnknown');
  }
  const lines = [
    i18nService.t('coworkContextUsagePercent').replace('{percent}', String(usage.percent)),
  ];
  if (typeof usage.usedTokens === 'number' && typeof usage.contextTokens === 'number') {
    lines.push(
      i18nService.t('coworkContextUsageTokens')
        .replace('{used}', formatTokenCount(usage.usedTokens))
        .replace('{total}', formatTokenCount(usage.contextTokens)),
    );
  }
  if (showActionHint) {
    lines.push(i18nService.t('coworkContextUsageCompactHint'));
  }
  return lines.join('\n');
};

const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({
  usage,
  compacting = false,
  disabled = false,
  onCompact,
  className = '',
  showTooltip = true,
  active = false,
}) => {
  const percent = typeof usage?.percent === 'number' ? usage.percent : undefined;
  if (!compacting && percent === undefined) {
    return null;
  }
  const offset = percent === undefined
    ? CIRCUMFERENCE
    : CIRCUMFERENCE * (1 - Math.min(Math.max(percent, 0), 100) / 100);
  const isDisabled = disabled || compacting || !onCompact;
  const tooltip = compacting ? i18nService.t('coworkContextCompacting') : formatTooltip(usage, !isDisabled);
  const tooltipLines = tooltip.split('\n');

  return (
    <span className={`group relative inline-flex flex-shrink-0 ${className}`}>
      <button
        type="button"
        onClick={onCompact}
        disabled={isDisabled}
        aria-label={tooltip}
        className={`relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
          isDisabled
            ? 'cursor-default text-secondary/70'
            : active
              ? 'bg-surface-raised text-foreground'
            : 'text-secondary hover:bg-surface-raised hover:text-foreground'
        }`}
      >
        <svg
          viewBox="0 0 20 20"
          className={`h-5 w-5 text-secondary ${compacting ? 'animate-spin' : ''}`}
          shapeRendering="geometricPrecision"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="0.42"
          />
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="1"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
      {showTooltip && (
        <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 hidden w-[260px] max-w-[calc(100vw-24px)] whitespace-normal break-words rounded-xl border border-border bg-surface px-3 py-2 text-left text-[12px] leading-5 text-foreground shadow-popover group-hover:block group-focus-within:block">
          {tooltipLines.map((line, index) => (
            <React.Fragment key={`${line}-${index}`}>
              <span className={index === tooltipLines.length - 1 && !isDisabled && !compacting ? 'text-secondary' : undefined}>
                {line}
              </span>
              {index < tooltipLines.length - 1 && <br />}
            </React.Fragment>
          ))}
        </span>
      )}
    </span>
  );
};

export default ContextUsageIndicator;
