import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { DEFAULT_PALETTE, seriesColor } from '@/services/sheet/sheetChartOption';
import {
  axisTitle, canStack, ChartAxisKind, ChartKind, chartKind, chartSeriesList, ChartStacking, chartStacking, hasAxes, hasDataLabels, hasGridlines,
  hasSeriesColors, LegendPosition, legendPosition, withAxisTitle, withChartKind, withChartTitle, withDataLabels, withGridlines, withLegend,
  withSeriesColor, withStacking,
} from '@/services/sheet/sheetChartSpec';
import type { ChartDrawing, SheetEditorSession } from '@/services/sheet/sheetEditorSession';
import type { ChartSpec } from '@/services/sheet/xlsxCharts';

const t = (key: string) => i18nService.t(key);

export const CHART_KINDS = [
  { kind: ChartKind.Column, label: 'sheetChartKindColumn' },
  { kind: ChartKind.Bar, label: 'sheetChartKindBar' },
  { kind: ChartKind.Line, label: 'sheetChartKindLine' },
  { kind: ChartKind.Area, label: 'sheetChartKindArea' },
  { kind: ChartKind.Pie, label: 'sheetChartKindPie' },
  { kind: ChartKind.Doughnut, label: 'sheetChartKindDoughnut' },
  { kind: ChartKind.Scatter, label: 'sheetChartKindScatter' },
] as const;
const STACKINGS = [
  { stacking: ChartStacking.Standard, label: 'sheetChartStackingNone' },
  { stacking: ChartStacking.Stacked, label: 'sheetChartStackingStacked' },
  { stacking: ChartStacking.Percent, label: 'sheetChartStackingPercent' },
] as const;
const LEGEND_POSITIONS = [
  { position: LegendPosition.Right, label: 'sheetChartLegendRight' },
  { position: LegendPosition.Bottom, label: 'sheetChartLegendBottom' },
  { position: LegendPosition.Top, label: 'sheetChartLegendTop' },
  { position: LegendPosition.Left, label: 'sheetChartLegendLeft' },
  { position: LegendPosition.None, label: 'sheetChartLegendNone' },
] as const;

/** A text setting: applied on Enter or when it loses focus, restored on Escape or when it is refused. */
function TextSetting({ label, value, placeholder, disabled, onCommit }: {
  label: string; value: string; placeholder?: string; disabled: boolean; onCommit: (text: string) => boolean | void;
}): React.ReactElement {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text !== value && onCommit(text) === false) setText(value); };
  return (
    <label>
      <span>{t(label)}</span>
      <input type="text" value={text} placeholder={placeholder ?? t(label)} disabled={disabled} onChange={event => setText(event.target.value)} onBlur={commit}
        onKeyDown={event => {
          // Keys typed here are for the field, not the grid's shortcuts (Backspace would delete the chart).
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          if (event.key === 'Escape') setText(value);
        }} />
    </label>
  );
}

/** A series color: applied when the color picker closes, so one pick is one undo step. */
function ColorSetting({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit: (color: string) => void }): React.ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const element = input.current;
    if (!element) return undefined;
    const onChange = () => commit.current(element.value.toUpperCase());
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, []);
  return (
    <label className="lobster-sheet-chart-color">
      <input ref={input} type="color" defaultValue={value.toLowerCase()} key={value} disabled={disabled} aria-label={label} />
      <span title={label}>{label}</span>
    </label>
  );
}

/**
 * The selected chart's settings, like Excel's chart elements and styles: type and stacking, title,
 * legend, data labels, gridlines, axis titles and series colors. Each change is one undo step.
 */
export function SheetChartSettings({ session, chart, disabled, onClose, style }: {
  session: SheetEditorSession; chart: ChartDrawing; disabled: boolean; onClose: () => void; style?: React.CSSProperties;
}): React.ReactElement | null {
  const spec = chart.data?.spec;
  if (!spec) return null;
  const change = (update: (spec: ChartSpec) => ChartSpec) => {
    if (disabled) return;
    session.updateChart(chart.drawingId, update).catch(error => { console.warn('[SheetChartSettings] The chart change was refused:', error); });
  };
  const palette = spec.palette?.length ? spec.palette : DEFAULT_PALETTE;
  const names = session.chartSeriesNames(chart.drawingId);
  return (
    <div className="lobster-sheet-chart-settings" role="dialog" aria-label={t('sheetChartSettings')} style={style}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <div className="lobster-sheet-chart-settings-header">
        <span>{t('sheetChartSettings')}</span>
        <button type="button" aria-label={t('close')} title={t('close')} onClick={onClose}>×</button>
      </div>
      <label>
        <span>{t('sheetChartType')}</span>
        <select value={chartKind(spec) ?? ''} disabled={disabled} onChange={event => change(current => withChartKind(current, event.target.value as ChartKind))}>
          {CHART_KINDS.map(item => <option key={item.kind} value={item.kind}>{t(item.label)}</option>)}
        </select>
      </label>
      {spec.plots.length === 1 && (
        <TextSetting label="sheetChartDataRange" value={session.chartDataRange(chart.drawingId) ?? ''} disabled={disabled}
          onCommit={text => !disabled && session.setChartDataRange(chart.drawingId, text)} />
      )}
      {canStack(spec) && (
        <label>
          <span>{t('sheetChartStacking')}</span>
          <select value={chartStacking(spec)} disabled={disabled} onChange={event => change(current => withStacking(current, event.target.value as ChartStacking))}>
            {STACKINGS.map(item => <option key={item.stacking} value={item.stacking}>{t(item.label)}</option>)}
          </select>
        </label>
      )}
      <TextSetting label="sheetChartTitle" value={session.chartTitle(chart.drawingId) ?? ''} disabled={disabled}
        placeholder={spec.title ? t('sheetChartPlaceholderTitle') : undefined} onCommit={text => change(current => withChartTitle(current, text))} />
      <label>
        <span>{t('sheetChartLegend')}</span>
        <select value={legendPosition(spec)} disabled={disabled} onChange={event => change(current => withLegend(current, event.target.value as LegendPosition))}>
          {LEGEND_POSITIONS.map(item => <option key={item.position} value={item.position}>{t(item.label)}</option>)}
        </select>
      </label>
      <label className="lobster-sheet-chart-check">
        <input type="checkbox" checked={hasDataLabels(spec)} disabled={disabled} onChange={event => change(current => withDataLabels(current, event.target.checked))} />
        <span>{t('sheetChartDataLabels')}</span>
      </label>
      {hasAxes(spec) && (
        <>
          <label className="lobster-sheet-chart-check">
            <input type="checkbox" checked={hasGridlines(spec)} disabled={disabled} onChange={event => change(current => withGridlines(current, event.target.checked))} />
            <span>{t('sheetChartGridlines')}</span>
          </label>
          <TextSetting label="sheetChartCategoryAxisTitle" value={axisTitle(spec, ChartAxisKind.Category)} disabled={disabled}
            onCommit={text => change(current => withAxisTitle(current, ChartAxisKind.Category, text))} />
          <TextSetting label="sheetChartValueAxisTitle" value={axisTitle(spec, ChartAxisKind.Value)} disabled={disabled}
            onCommit={text => change(current => withAxisTitle(current, ChartAxisKind.Value, text))} />
        </>
      )}
      {hasSeriesColors(spec) && (
        <div className="lobster-sheet-chart-series">
          <span>{t('sheetChartSeriesColors')}</span>
          {chartSeriesList(spec).map((series, index) => (
            <ColorSetting key={index} label={names[index] ?? t('sheetChartSeries').replace('{n}', String(index + 1))} disabled={disabled}
              value={series.color ?? seriesColor(palette, index)} onCommit={color => change(current => withSeriesColor(current, index, color))} />
          ))}
        </div>
      )}
    </div>
  );
}
