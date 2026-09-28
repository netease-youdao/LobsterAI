import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, Bars3BottomLeftIcon, Bars3BottomRightIcon, Bars3CenterLeftIcon, BoldIcon, ChartBarIcon,
  ItalicIcon, PaintBrushIcon, PhotoIcon, StrikethroughIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import { BorderStyleTypes, BorderType, HorizontalAlign, type IStyleData, WrapStrategy } from '@univerjs/core';
import type { FRange } from '@univerjs/sheets/facade';
import React, { useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { type ChartKind, chartKind } from '@/services/sheet/sheetChartSpec';
import type { SheetEditorSession } from '@/services/sheet/sheetEditorSession';

import { CHART_KINDS, SheetChartSettings } from './SheetChartSettings';

const t = (key: string) => i18nService.t(key);
/** Excel's own family names; the renderer falls back to an installed face when one is missing. */
const COMMON_FONTS = ['宋体', '黑体', '微软雅黑', '等线', '楷体', '仿宋', 'Calibri', 'Arial', 'Times New Roman', 'Courier New'];
const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
const NUMBER_FORMATS = [
  { label: 'sheetFormatGeneral', pattern: 'General' },
  { label: 'sheetFormatNumber', pattern: '0.00' },
  { label: 'sheetFormatThousands', pattern: '#,##0.00' },
  { label: 'sheetFormatPercent', pattern: '0.00%' },
  { label: 'sheetFormatCurrency', pattern: '¥#,##0.00' },
  { label: 'sheetFormatDate', pattern: 'yyyy-mm-dd' },
  { label: 'sheetFormatText', pattern: '@' },
] as const;
/** Excel's border menu: which edges, and the line for them. */
const BORDERS = [
  { label: 'sheetBorderBottom', type: BorderType.BOTTOM, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderTop', type: BorderType.TOP, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderLeft', type: BorderType.LEFT, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderRight', type: BorderType.RIGHT, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderNone', type: BorderType.NONE, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderAll', type: BorderType.ALL, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderOutside', type: BorderType.OUTSIDE, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderInside', type: BorderType.INSIDE, style: BorderStyleTypes.THIN },
  { label: 'sheetBorderThickOutside', type: BorderType.OUTSIDE, style: BorderStyleTypes.THICK },
  { label: 'sheetBorderDoubleBottom', type: BorderType.BOTTOM, style: BorderStyleTypes.DOUBLE },
  { label: 'sheetBorderThickBottom', type: BorderType.BOTTOM, style: BorderStyleTypes.THICK },
] as const;
/** Univer's format painter (a double click keeps it on) and decimal place commands. */
const FormatCommand = {
  PainterOnce: 'sheet.command.set-once-format-painter',
  PainterKeep: 'sheet.command.set-infinite-format-painter',
  MoreDecimals: 'sheet.command.numfmt.add.decimal.command',
  FewerDecimals: 'sheet.command.numfmt.subtract.decimal.command',
} as const;
/** Univer's command that picks a picture file and floats it over the selected cell. */
const INSERT_PICTURE = 'sheet.command.insert-float-image';
/** Univer's facade names right alignment 'normal'. */
const FACADE_RIGHT = 'normal';
/** Toggle commands act on the whole selection exactly like Univer's own toolbar buttons. */
const ToggleCommand = {
  Bold: 'sheet.command.set-range-bold',
  Italic: 'sheet.command.set-range-italic',
  Underline: 'sheet.command.set-range-underline',
  Strike: 'sheet.command.set-range-stroke',
} as const;

function ToolbarButton({ label, active, disabled, onClick, onDoubleClick, children }: {
  label: string; active?: boolean; disabled?: boolean; onClick: () => void; onDoubleClick?: () => void; children: React.ReactNode;
}): React.ReactElement {
  return (
    <button type="button" title={t(label)} aria-label={t(label)} aria-pressed={active} disabled={disabled}
      onMouseDown={event => event.preventDefault()} onClick={onClick} onDoubleClick={onDoubleClick}>
      {children}
    </button>
  );
}

export function SheetToolbar({ session, disabled }: { session: SheetEditorSession; disabled: boolean }): React.ReactElement {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const range: FRange | null | undefined = session.workbook?.getActiveRange();
  // The cell's own format, as Excel's ribbon shows it: not what conditional formats or validation draw.
  const sheet = session.workbook?.getActiveSheet().getSheet();
  const style: IStyleData = (range && sheet
    ? sheet.getComposedCellStyleByCellData(range.getRow(), range.getColumn(), sheet.getCellRaw(range.getRow(), range.getColumn()))
    : undefined) ?? {};
  const merged = Boolean(range?.isPartOfMerge());
  // Cells without a font of their own use the workbook's, as Excel's ribbon shows.
  const fontName = style.ff ?? session.defaultFont.name;
  const fontSize = style.fs ?? session.defaultFont.size;
  const apply = (operation: (target: FRange) => unknown) => {
    const target = session.workbook?.getActiveRange();
    if (!target || disabled) return;
    try {
      operation(target);
    } catch (error) {
      console.warn('[SheetToolbar] Formatting was refused:', error);
    }
  };
  const format = range?.getNumberFormat() ?? '';
  const toggle = (command: string) => {
    if (disabled) return;
    void session.api?.executeCommand(command).catch(error => { console.warn('[SheetToolbar] Formatting was refused:', error); });
  };
  const settingsOpen = session.chartSettingsOpen;
  const chart = session.focusedChart();
  const chartSpec = chart?.data?.spec;
  const editable = Boolean(chart && chartSpec && !chartSpec.unsupported && chartKind(chartSpec));
  return (
    <div className="lobster-sheet-toolbar" role="toolbar" aria-label={t('sheetToolbar')}>
      <ToolbarButton label="sheetUndo" disabled={disabled} onClick={() => { void session.api?.undo(); }}><ArrowUturnLeftIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetRedo" disabled={disabled} onClick={() => { void session.api?.redo(); }}><ArrowUturnRightIcon className="h-4 w-4" /></ToolbarButton>
      <span className="lobster-sheet-toolbar-divider" />
      <select aria-label={t('sheetFont')} title={t('sheetFont')} value={fontName ?? ''} disabled={disabled}
        onChange={event => apply(target => target.setFontFamily(event.target.value))}>
        <option value="" disabled>{t('sheetFont')}</option>
        {[...new Set([fontName, ...COMMON_FONTS])].filter((font): font is string => Boolean(font)).map(font => (
          <option key={font} value={font}>{font}</option>
        ))}
      </select>
      <select aria-label={t('sheetFontSize')} title={t('sheetFontSize')} value={fontSize ?? ''} disabled={disabled}
        onChange={event => apply(target => target.setFontSize(Number(event.target.value)))}>
        <option value="" disabled>{t('sheetFontSize')}</option>
        {[...new Set([fontSize, ...FONT_SIZES])].filter((size): size is number => typeof size === 'number').sort((a, b) => a - b).map(size => (
          <option key={size} value={size}>{size}</option>
        ))}
      </select>
      <ToolbarButton label="sheetBold" active={style.bl === 1} disabled={disabled}
        onClick={() => toggle(ToggleCommand.Bold)}><BoldIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetItalic" active={style.it === 1} disabled={disabled}
        onClick={() => toggle(ToggleCommand.Italic)}><ItalicIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetUnderline" active={style.ul?.s === 1} disabled={disabled}
        onClick={() => toggle(ToggleCommand.Underline)}><UnderlineIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetStrike" active={style.st?.s === 1} disabled={disabled}
        onClick={() => toggle(ToggleCommand.Strike)}><StrikethroughIcon className="h-4 w-4" /></ToolbarButton>
      <label className="lobster-sheet-color" title={t('sheetFontColor')}>
        <span style={{ borderBottomColor: style.cl?.rgb ?? '#000000' }}>A</span>
        <input type="color" aria-label={t('sheetFontColor')} disabled={disabled} value={toHex(style.cl?.rgb, '#000000')}
          onChange={event => apply(target => target.setFontColor(event.target.value))} />
      </label>
      <label className="lobster-sheet-color" title={t('sheetFillColor')}>
        <span className="lobster-sheet-fill" style={{ background: style.bg?.rgb ?? 'transparent' }} />
        <input type="color" aria-label={t('sheetFillColor')} disabled={disabled} value={toHex(style.bg?.rgb, '#ffffff')}
          onChange={event => apply(target => target.setBackgroundColor(event.target.value))} />
      </label>
      <span className="lobster-sheet-toolbar-divider" />
      <ToolbarButton label="sheetAlignLeft" active={style.ht === HorizontalAlign.LEFT} disabled={disabled}
        onClick={() => apply(target => target.setHorizontalAlignment('left'))}><Bars3BottomLeftIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetAlignCenter" active={style.ht === HorizontalAlign.CENTER} disabled={disabled}
        onClick={() => apply(target => target.setHorizontalAlignment('center'))}><Bars3CenterLeftIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetAlignRight" active={style.ht === HorizontalAlign.RIGHT} disabled={disabled}
        onClick={() => apply(target => target.setHorizontalAlignment(FACADE_RIGHT))}><Bars3BottomRightIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetWrap" active={style.tb === WrapStrategy.WRAP} disabled={disabled}
        onClick={() => apply(target => target.setWrap(style.tb !== WrapStrategy.WRAP))}><span className="text-[11px] font-medium">⏎</span></ToolbarButton>
      <ToolbarButton label={merged ? 'sheetUnmerge' : 'sheetMerge'} active={merged} disabled={disabled}
        onClick={() => apply(target => (merged ? target.breakApart() : target.merge()))}><span className="text-[11px] font-medium">⊞</span></ToolbarButton>
      <select aria-label={t('sheetBorders')} title={t('sheetBorders')} value="" disabled={disabled}
        onChange={event => {
          const border = BORDERS[Number(event.target.value)];
          if (border) apply(target => target.setBorder(border.type, border.style, '#000000'));
        }}>
        <option value="" disabled>{t('sheetBorders')}</option>
        {BORDERS.map((border, index) => <option key={border.label} value={index}>{t(border.label)}</option>)}
      </select>
      <ToolbarButton label="sheetFormatPainter" active={session.formatPainterActive} disabled={disabled}
        onClick={() => toggle(FormatCommand.PainterOnce)} onDoubleClick={() => toggle(FormatCommand.PainterKeep)}>
        <PaintBrushIcon className="h-4 w-4" />
      </ToolbarButton>
      <select aria-label={t('sheetNumberFormat')} title={t('sheetNumberFormat')} disabled={disabled}
        value={NUMBER_FORMATS.find(item => item.pattern === format)?.pattern ?? ''}
        onChange={event => apply(target => target.setNumberFormat(event.target.value))}>
        <option value="" disabled>{t('sheetNumberFormat')}</option>
        {NUMBER_FORMATS.map(item => <option key={item.pattern} value={item.pattern}>{t(item.label)}</option>)}
      </select>
      <ToolbarButton label="sheetMoreDecimals" disabled={disabled} onClick={() => toggle(FormatCommand.MoreDecimals)}>
        <span className="text-[11px] font-medium">.0+</span>
      </ToolbarButton>
      <ToolbarButton label="sheetFewerDecimals" disabled={disabled} onClick={() => toggle(FormatCommand.FewerDecimals)}>
        <span className="text-[11px] font-medium">.0−</span>
      </ToolbarButton>
      <span className="lobster-sheet-toolbar-divider" />
      <ToolbarButton label="sheetInsertImage" disabled={disabled} onClick={() => toggle(INSERT_PICTURE)}><PhotoIcon className="h-4 w-4" /></ToolbarButton>
      <select aria-label={t('sheetInsertChart')} title={t('sheetInsertChart')} value="" disabled={disabled}
        onChange={event => { if (event.target.value) session.insertChart(event.target.value as ChartKind); }}>
        <option value="" disabled>{t('sheetInsertChart')}</option>
        {CHART_KINDS.map(item => <option key={item.kind} value={item.kind}>{t(item.label)}</option>)}
      </select>
      {editable && (
        <ToolbarButton label="sheetChartSettings" active={settingsOpen} disabled={disabled}
          onClick={() => session.showChartSettings(!settingsOpen)}><ChartBarIcon className="h-4 w-4" /></ToolbarButton>
      )}
      {editable && settingsOpen && chart && (
        <SheetChartSettings session={session} chart={chart} disabled={disabled} onClose={() => session.showChartSettings(false)} />
      )}
    </div>
  );
}

function toHex(color: unknown, fallback: string): string {
  if (typeof color !== 'string' || !color) return fallback;
  if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color);
  if (short) return `#${short.slice(1).map(char => char + char).join('')}`.toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
  return rgb ? `#${rgb.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('')}` : fallback;
}
