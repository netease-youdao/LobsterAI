import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { type CSSProperties, type RefObject, useEffect, useId, useRef, useState } from 'react';

import type { ModelContextWindowState } from '../../../shared/providers/modelContextWindow';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { Model } from '../../store/slices/modelSlice';
import { buildContextWindowSliderStops, contextWindowSliderIndex, formatContextWindow } from './contextWindowSlider';

const SliderKey = {
  Cancel: 'Escape',
  Confirm: 'Enter',
  Space: ' ',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Down: 'ArrowDown',
  Up: 'ArrowUp',
  First: 'Home',
  Last: 'End',
} as const;
const SLIDER_COMMIT_KEYS = new Set<string>(Object.values(SliderKey).filter(key => key !== SliderKey.Cancel));

export default function ModelContextWindowControl({ model, sessionId, isSelected, disabled, isOpen, opensLeft, menuStyle, menuRef, onOpen, onSelectModel, onInteract }: {
  model: Model;
  sessionId?: string;
  isSelected: boolean;
  disabled: boolean;
  isOpen: boolean;
  opensLeft: boolean;
  menuStyle: CSSProperties;
  menuRef: RefObject<HTMLDivElement>;
  onOpen: (trigger: HTMLElement) => void;
  onSelectModel: () => void;
  onInteract: () => void;
}) {
  const [state, setState] = useState<ModelContextWindowState | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const activeRequest = useRef(0);
  const pointerSelecting = useRef(false);
  const keyboardSelecting = useRef(false);
  const hintId = useId();
  const panelId = useId();
  const requestSessionId = isSelected ? sessionId : undefined;
  const optionsKey = model.contextWindowOptions?.join(',');

  useEffect(() => {
    const revision = ++activeRequest.current;
    setState(null);
    setDraftIndex(null);
    setSaving(false);
    pointerSelecting.current = false;
    keyboardSelecting.current = false;
    void window.electron.modelContextWindows.get({ modelId: model.id, presetId: model.presetId, sessionId: requestSessionId })
      .then(result => { if (revision === activeRequest.current && result.success && result.data) setState(result.data); })
      .catch(() => { /* Missing metadata leaves the ordinary model selector available. */ });
    return () => { activeRequest.current = revision + 1; };
  }, [model.id, model.presetId, model.contextWindow, requestSessionId, optionsKey]);

  useEffect(() => {
    if (isOpen) return;
    setDraftIndex(null);
    pointerSelecting.current = false;
    keyboardSelecting.current = false;
  }, [isOpen]);

  if (!state?.options.length) return null;
  const stops = buildContextWindowSliderStops(state.options, state.defaultWindow);
  if (!stops.length) return null;
  const selectedIndex = contextWindowSliderIndex(stops, state.override, state.defaultWindow);
  const index = draftIndex ?? selectedIndex;
  const stop = stops[index];
  const position = stops.length > 1 ? index / (stops.length - 1) : 0.5;
  const previewOverride = draftIndex === null ? state.override : stop.selection;
  const defaultLabel = state.defaultWindow
    ? i18nService.t('modelContextWindowDefaultValue').replace('{window}', formatContextWindow(state.defaultWindow))
    : i18nService.t('modelContextWindowDefault');
  const valueLabel = previewOverride === null ? defaultLabel : formatContextWindow(previewOverride);
  const currentValueLabel = state.override !== null ? formatContextWindow(state.override)
    : state.defaultWindow
      ? i18nService.t('modelContextWindowDefaultShort').replace('{window}', formatContextWindow(state.defaultWindow))
      : i18nService.t('modelContextWindowDefault');
  const blocked = disabled || saving;
  const select = async (tokens: number | null) => {
    if (blocked) return;
    if (tokens === state.override) { setDraftIndex(null); return; }
    const revision = activeRequest.current;
    setSaving(true);
    try {
      const result = await window.electron.modelContextWindows.set({ modelId: model.id, presetId: model.presetId, sessionId: requestSessionId }, tokens);
      if (revision !== activeRequest.current) return;
      if (!result.success || !result.data) throw new Error(result.error || i18nService.t('modelContextWindowSaveFailed'));
      setState(result.data);
      if (!isSelected) onSelectModel();
      else if (sessionId) void coworkService.refreshContextUsage(sessionId, { notifyCompaction: false });
    } catch (error) {
      if (revision !== activeRequest.current) return;
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: error instanceof Error ? error.message : i18nService.t('modelContextWindowSaveFailed'),
      }));
    } finally {
      if (revision === activeRequest.current) { setSaving(false); setDraftIndex(null); }
    }
  };
  const commit = (value: string) => {
    const next = Math.max(0, Math.min(stops.length - 1, Math.round(Number(value))));
    if (Number.isFinite(next)) void select(stops[next].selection);
  };
  return (
    <>
      <button type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={event => onOpen(event.currentTarget)}
        onMouseEnter={event => onOpen(event.currentTarget)}
        onFocus={event => onOpen(event.currentTarget)}
        className={`-mx-1.5 mt-1.5 flex w-[calc(100%+12px)] items-center justify-between gap-2 rounded-lg px-1.5 py-2 text-left text-[12px] transition-colors ${
          disabled ? 'cursor-not-allowed text-secondary opacity-60'
            : `text-foreground ${isOpen ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`
        }`}>
        <span className="shrink-0">{i18nService.t('modelContextWindow')}</span>
        <span className="flex min-w-0 items-center gap-1 font-medium">
          <span className="truncate" title={state.override === null ? defaultLabel : undefined}>{currentValueLabel}</span>
          <ChevronRightIcon className={`h-3.5 w-3.5 shrink-0 text-secondary ${opensLeft ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {isOpen && <div ref={menuRef} id={panelId} role="dialog" aria-label={i18nService.t('modelContextWindow')}
        style={menuStyle} className="rounded-xl border border-border bg-surface p-3 shadow-popover" aria-busy={saving}
        onMouseEnter={onInteract} onFocus={onInteract}>
        <div className="flex items-center justify-between gap-2 text-[12px] text-foreground">
          <span>{i18nService.t('modelContextWindow')}</span>
          <button type="button" disabled={blocked || state.override === null} title={i18nService.t('modelContextWindowReset')}
            aria-label={i18nService.t('modelContextWindowReset')}
            onClick={() => { onInteract(); void select(null); }}
            className="-mr-1 flex h-6 w-6 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground disabled:cursor-default disabled:opacity-35">
            <ArrowPathIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-0.5 text-center text-[13px] font-semibold leading-5 text-foreground" aria-live="polite">{valueLabel}</div>
        <div className={`relative mt-1 h-8 ${blocked ? 'opacity-50' : ''}`}>
          <input type="range" min={0} max={stops.length - 1} step={1} value={index} disabled={blocked}
            aria-label={i18nService.t('modelContextWindow')} aria-valuetext={valueLabel} aria-describedby={hintId}
            onFocus={onInteract}
            onChange={event => {
              if (pointerSelecting.current || keyboardSelecting.current) setDraftIndex(Number(event.currentTarget.value));
            }}
            onPointerDown={event => { pointerSelecting.current = true; onInteract(); event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerUp={event => {
              if (pointerSelecting.current) { pointerSelecting.current = false; commit(event.currentTarget.value); }
            }}
            onPointerCancel={() => { pointerSelecting.current = false; setDraftIndex(null); }}
            onKeyDown={event => {
              if (event.key === SliderKey.Cancel) {
                if (pointerSelecting.current || keyboardSelecting.current || draftIndex !== null) event.stopPropagation();
                pointerSelecting.current = false; keyboardSelecting.current = false; setDraftIndex(null);
              }
              if (SLIDER_COMMIT_KEYS.has(event.key)) keyboardSelecting.current = true;
              if (event.key === SliderKey.Confirm || event.key === SliderKey.Space) event.preventDefault();
            }}
            onKeyUp={event => {
              if (keyboardSelecting.current && SLIDER_COMMIT_KEYS.has(event.key)) {
                keyboardSelecting.current = false; event.stopPropagation(); commit(event.currentTarget.value);
              }
            }}
            onBlur={() => { pointerSelecting.current = false; keyboardSelecting.current = false; if (!saving) setDraftIndex(null); }}
            className="peer absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-default [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none"
            style={{ touchAction: 'none' }} />
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-5 -translate-y-1/2 rounded-full bg-border peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface">
            <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-600 dark:bg-emerald-400" style={{ width: index === 0 ? 0 : `calc(12px + (100% - 24px) * ${position})` }} />
            <div className="absolute inset-x-3 top-1/2">
              {stops.map((item, stopIndex) => (
                <span key={item.tokens} className={`absolute h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${stopIndex <= index ? 'bg-white/60 dark:bg-black/40' : 'bg-foreground/30'}`}
                  style={{ left: `${stops.length > 1 ? stopIndex / (stops.length - 1) * 100 : 50}%` }} />
              ))}
              <span className="absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/10 bg-white shadow-sm"
                style={{ left: `${position * 100}%` }} />
            </div>
          </div>
        </div>
        <div aria-hidden="true" className="relative mx-3 h-5 text-[10px] leading-4 text-secondary">
          {stops.map((item, stopIndex) => (stops.length <= 4 || stopIndex === 0 || stopIndex === stops.length - 1) && (
            <span key={item.tokens} className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${stops.length > 1 ? stopIndex / (stops.length - 1) * 100 : 50}%` }}>
              {formatContextWindow(item.tokens)}{item.selection === null ? ` · ${i18nService.t('modelContextWindowDefaultMark')}` : ''}
            </span>
          ))}
        </div>
        <p id={hintId} className="sr-only">{i18nService.t('modelContextWindowSliderHint')}</p>
        <p className="mt-1 text-[11px] leading-4 text-secondary">{i18nService.t('modelContextWindowCostHint')}</p>
      </div>}
    </>
  );
}
