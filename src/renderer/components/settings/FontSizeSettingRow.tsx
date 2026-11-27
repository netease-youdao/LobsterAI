import { MinusIcon, PlusIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { i18nService } from '../../services/i18n';
import {
  commitFontSizeDraft,
  parseFontSizeDraft,
  stepFontSize,
} from '../../services/typography';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_META_TEXT,
} from './settingsTypography';

export interface FontSizeSettingRowProps {
  id: string;
  title: string;
  description: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}

const FontSizeSettingRow: React.FC<FontSizeSettingRowProps> = ({
  id,
  title,
  description,
  value,
  defaultValue,
  min,
  max,
  onChange,
  onCommit,
}) => {
  const [draft, setDraft] = useState<string>(() => String(value));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setDraft(String(value));
    }
  }, [isFocused, value]);

  const hintId = `${id}-hint`;
  const rangeHint = i18nService
    .t('fontSizeRangeHint')
    .replace('{min}', String(min))
    .replace('{max}', String(max))
    .replace('{default}', String(defaultValue));

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextRaw = event.currentTarget.value;
    setDraft(nextRaw);
    const liveValue = parseFontSizeDraft(nextRaw, min, max);
    if (liveValue !== null && liveValue !== value) {
      onChange(liveValue);
    }
  };

  const commitDraft = (raw: string) => {
    const committed = commitFontSizeDraft(raw, value, min, max);
    setDraft(String(committed));
    if (committed !== value) {
      onChange(committed);
    }
    onCommit?.(committed);
  };

  const handleInputBlur = () => {
    setIsFocused(false);
    commitDraft(draft);
  };

  const handleStep = (delta: number) => {
    const base = parseFontSizeDraft(draft, min, max) ?? value;
    const next = stepFontSize(base, delta, min, max);
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  };

  const handleReset = () => {
    setDraft(String(defaultValue));
    if (defaultValue !== value) {
      onChange(defaultValue);
    }
    onCommit?.(defaultValue);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      handleStep(1);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      handleStep(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft(draft);
      return;
    }
    if (event.key === 'Escape' && draft !== String(value)) {
      event.preventDefault();
      event.stopPropagation();
      setDraft(String(value));
    }
  };

  const canDecrease = value > min;
  const canIncrease = value < max;
  const showReset = value !== defaultValue;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={`block ${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
          {title}
        </label>
        <p className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
          {description}
        </p>
        <p id={hintId} className={`mt-0.5 ${SETTINGS_META_TEXT} text-secondary/80`}>
          {rangeHint}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showReset && (
          <button
            type="button"
            onClick={handleReset}
            className={`rounded-md px-2 py-1 ${SETTINGS_META_TEXT} text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30`}
          >
            {i18nService.t('fontSizeResetDefault')}
          </button>
        )}
        <div className="inline-flex min-h-8 items-stretch overflow-hidden rounded-lg border border-border bg-surface transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <button
            type="button"
            onClick={() => handleStep(-1)}
            disabled={!canDecrease}
            aria-label={i18nService.t('fontSizeDecrease')}
            title={i18nService.t('fontSizeDecrease')}
            className="inline-flex w-8 shrink-0 items-center justify-center text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          >
            <MinusIcon className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <input
            id={id}
            type="text"
            inputMode="numeric"
            role="spinbutton"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-describedby={hintId}
            value={draft}
            onFocus={() => setIsFocused(true)}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onKeyDown={handleKeyDown}
            className={`min-h-8 w-12 border-x border-border bg-transparent px-1 py-0.5 text-center ${SETTINGS_ITEM_TITLE_TEXT} tabular-nums text-foreground outline-none`}
          />
          <button
            type="button"
            onClick={() => handleStep(1)}
            disabled={!canIncrease}
            aria-label={i18nService.t('fontSizeIncrease')}
            title={i18nService.t('fontSizeIncrease')}
            className="inline-flex w-8 shrink-0 items-center justify-center text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          >
            <PlusIcon className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
        <span className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>px</span>
      </div>
    </div>
  );
};

export default FontSizeSettingRow;
