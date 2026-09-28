import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, Bars3BottomLeftIcon, Bars3BottomRightIcon, Bars3CenterLeftIcon, BoldIcon, ChartBarIcon, FunnelIcon,
  ItalicIcon, PaintBrushIcon, PhotoIcon, StrikethroughIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import { BorderStyleTypes, BorderType, HorizontalAlign, type IStyleData, VerticalAlign, WrapStrategy } from '@univerjs/core';
import type { FRange } from '@univerjs/sheets/facade';
import { SheetsFilterService } from '@univerjs/sheets-filter';
import React, { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { type ChartKind, chartKind } from '@/services/sheet/sheetChartSpec';
import type { SheetEditorSession } from '@/services/sheet/sheetEditorSession';
import { MergeAction, mergeSelection } from '@/services/sheet/sheetMerge';
import { CURRENCY_FORMAT } from '@/services/sheet/sheetShortcuts';

import { CHART_KINDS, SheetChartSettings } from './SheetChartSettings';
import { ColorTarget, SheetColorButton } from './SheetColorButton';
import { SheetSplitButton } from './SheetPopover';

const t = (key: string) => i18nService.t(key);
/** Excel's own family names; the renderer falls back to an installed face when one is missing. */
const COMMON_FONTS = ['宋体', '黑体', '微软雅黑', '等线', '楷体', '仿宋', 'Calibri', 'Arial', 'Times New Roman', 'Courier New'];
const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
/** Excel's number format list; currency and the long date follow the interface language. */
const numberFormats = (language: string) => [
  { label: 'sheetFormatGeneral', pattern: 'General' },
  { label: 'sheetFormatNumber', pattern: '0.00' },
  { label: 'sheetFormatThousands', pattern: '#,##0.00' },
  { label: 'sheetFormatCurrency', pattern: CURRENCY_FORMAT[language === 'zh' ? 'zh' : 'en'] },
  { label: 'sheetFormatDate', pattern: 'yyyy-mm-dd' },
  { label: 'sheetFormatLongDate', pattern: language === 'zh' ? 'yyyy"年"m"月"d"日"' : 'mmmm d, yyyy' },
  { label: 'sheetFormatTime', pattern: 'h:mm:ss' },
  { label: 'sheetFormatPercent', pattern: '0.00%' },
  { label: 'sheetFormatFraction', pattern: '# ?/?' },
  { label: 'sheetFormatScientific', pattern: '0.00E+00' },
  { label: 'sheetFormatText', pattern: '@' },
];
/** The number format list's last entry opens Univer's number format panel (Excel's "More Number Formats"). */
const MORE_NUMBER_FORMATS = 'more';
const VERTICAL_ALIGNMENTS = [
  { label: 'sheetAlignTop', value: 'top', align: VerticalAlign.TOP },
  { label: 'sheetAlignMiddle', value: 'middle', align: VerticalAlign.MIDDLE },
  { label: 'sheetAlignBottom', value: 'bottom', align: VerticalAlign.BOTTOM },
] as const;
/** Excel's AutoSum menu: Univer's insert-function operation picks the range above or to the left. */
const AUTO_SUM_FUNCTIONS = [
  { label: 'sheetSum', name: 'SUM' },
  { label: 'sheetAverage', name: 'AVERAGE' },
  { label: 'sheetCount', name: 'COUNT' },
  { label: 'sheetMax', name: 'MAX' },
  { label: 'sheetMin', name: 'MIN' },
] as const;
/** Excel's merge menu. */
const MERGE_MENU = [
  { label: 'sheetMergeCenter', action: MergeAction.Center },
  { label: 'sheetMergeAcross', action: MergeAction.Across },
  { label: 'sheetMergeCells', action: MergeAction.Cells },
  { label: 'sheetUnmergeCells', action: MergeAction.Unmerge },
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
  NumberFormatPanel: 'sheet.operation.open.numfmt.panel',
} as const;
/** Univer's data commands behind Excel's AutoSum and filter buttons. */
const DataCommand = {
  InsertFunction: 'formula-ui.operation.insert-function',
  MoreFunctions: 'formula-ui.operation.more-functions',
  ToggleFilter: 'sheet.command.smart-toggle-filter',
} as const;
/** Univer's commands for Excel's "Automatic" font color and "No Fill". */
const ColorCommand = {
  Automatic: 'sheet.command.reset-text-color',
  NoFill: 'sheet.command.reset-background-color',
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

/** Excel's vertical alignment icons: the text lines sit against the top, the middle or the bottom. */
function VerticalAlignIcon({ at }: { at: typeof VERTICAL_ALIGNMENTS[number]['value'] }): React.ReactElement {
  const edge = at === 'top' ? 2.5 : at === 'middle' ? 8 : 13.5;
  const lines = at === 'top' ? [6, 9] : at === 'middle' ? [5, 11] : [7, 10];
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
      <line x1="2" x2="14" y1={edge} y2={edge} />
      <line x1="5" x2="11" y1={lines[0]} y2={lines[0]} />
      <line x1="5" x2="11" y1={lines[1]} y2={lines[1]} />
    </svg>
  );
}

type BorderChoice = typeof BORDERS[number];

/** The border button shows the border it applies: solid edges over a dotted cell outline. */
function BorderIcon({ border }: { border: BorderChoice }): React.ReactElement {
  const { type, style } = border;
  const width = style === BorderStyleTypes.THICK ? 2.2 : 1.2;
  const edges: Record<string, [number, number, number, number]> = { top: [2, 2, 14, 2], bottom: [2, 14, 14, 14], left: [2, 2, 2, 14], right: [14, 2, 14, 14] };
  const inner: [number, number, number, number][] = [[8, 2, 8, 14], [2, 8, 14, 8]];
  const solid: [number, number, number, number][] = type === BorderType.ALL ? [...Object.values(edges), ...inner]
    : type === BorderType.OUTSIDE ? Object.values(edges)
      : type === BorderType.INSIDE ? inner
        : type === BorderType.NONE ? [] : [edges[type as string]].filter(Boolean);
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" strokeWidth={1} strokeDasharray="1 1.5" opacity={0.45} />
      {solid.map(([x1, y1, x2, y2], index) => <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={width} />)}
      {style === BorderStyleTypes.DOUBLE && <line x1="2" y1="11.5" x2="14" y2="11.5" strokeWidth={1} />}
    </svg>
  );
}

/** Whether the active sheet has an AutoFilter (the filter button shows as pressed). */
function hasFilter(session: SheetEditorSession): boolean {
  const workbook = session.workbook;
  if (!workbook || !session.univer) return false;
  try {
    return Boolean(session.univer.__getInjector().get(SheetsFilterService).getFilterModel(workbook.getId(), workbook.getActiveSheet().getSheetId()));
  } catch {
    return false;
  }
}

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
  const formats = numberFormats(i18nService.getLanguage());
  // Excel aligns cells to the bottom unless they say otherwise.
  const verticalAlign = style.vt || VerticalAlign.BOTTOM;
  const filtered = hasFilter(session);
  // Excel's border button repeats the border picked last; it starts with a bottom border.
  const [lastBorder, setLastBorder] = useState<BorderChoice>(BORDERS[0]);
  const border = (choice: BorderChoice) => {
    setLastBorder(choice);
    apply(target => target.setBorder(choice.type, choice.style, '#000000'));
  };
  const merge = (action: MergeAction) => {
    if (disabled || !session.univer || !session.workbook) return;
    mergeSelection(session.univer, session.workbook, action).catch(error => { console.warn('[SheetToolbar] Merging was refused:', error); });
  };
  const toggle = (command: string, params?: object) => {
    if (disabled) return;
    void session.api?.executeCommand(command, params).catch(error => { console.warn('[SheetToolbar] Formatting was refused:', error); });
  };
  const settingsOpen = session.chartSettingsOpen;
  const chart = session.focusedChart();
  const chartSpec = chart?.data?.spec;
  const editable = Boolean(chart && chartSpec && !chartSpec.unsupported && chartKind(chartSpec));
  const showSettings = editable && settingsOpen && Boolean(chart);
  // The settings float above the grid and Univer's own popups (fixed on the page), under the toolbar's right end.
  const toolbar = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number }>();
  useLayoutEffect(() => {
    if (!showSettings) return undefined;
    const place = () => {
      const rect = toolbar.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: Math.round(rect.bottom + 4), right: Math.max(8, Math.round(window.innerWidth - rect.right + 10)) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (toolbar.current) observer.observe(toolbar.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [showSettings]);
  return (
    <div ref={toolbar} className="lobster-sheet-toolbar" role="toolbar" aria-label={t('sheetToolbar')}>
      <ToolbarButton label="sheetUndo" disabled={disabled} onClick={() => { void session.api?.undo(); }}><ArrowUturnLeftIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetRedo" disabled={disabled} onClick={() => { void session.api?.redo(); }}><ArrowUturnRightIcon className="h-4 w-4" /></ToolbarButton>
      <span className="lobster-sheet-toolbar-divider" />
      <select className="lobster-sheet-font" aria-label={t('sheetFont')} title={t('sheetFont')} value={fontName ?? ''} disabled={disabled}
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
      <SheetColorButton target={ColorTarget.Font} themeColors={session.themeColors} disabled={disabled}
        onPick={color => (color ? apply(target => target.setFontColor(color)) : toggle(ColorCommand.Automatic))} />
      <SheetColorButton target={ColorTarget.Fill} themeColors={session.themeColors} disabled={disabled}
        onPick={color => (color ? apply(target => target.setBackgroundColor(color)) : toggle(ColorCommand.NoFill))} />
      <span className="lobster-sheet-toolbar-divider" />
      <ToolbarButton label="sheetAlignLeft" active={style.ht === HorizontalAlign.LEFT} disabled={disabled}
        onClick={() => apply(target => target.setHorizontalAlignment('left'))}><Bars3BottomLeftIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetAlignCenter" active={style.ht === HorizontalAlign.CENTER} disabled={disabled}
        onClick={() => apply(target => target.setHorizontalAlignment('center'))}><Bars3CenterLeftIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton label="sheetAlignRight" active={style.ht === HorizontalAlign.RIGHT} disabled={disabled}
        onClick={() => apply(target => target.setHorizontalAlignment(FACADE_RIGHT))}><Bars3BottomRightIcon className="h-4 w-4" /></ToolbarButton>
      {VERTICAL_ALIGNMENTS.map(item => (
        <ToolbarButton key={item.value} label={item.label} active={verticalAlign === item.align} disabled={disabled}
          onClick={() => apply(target => target.setVerticalAlignment(item.value))}><VerticalAlignIcon at={item.value} /></ToolbarButton>
      ))}
      <ToolbarButton label="sheetWrap" active={style.tb === WrapStrategy.WRAP} disabled={disabled}
        onClick={() => apply(target => target.setWrap(style.tb !== WrapStrategy.WRAP))}><span className="text-[11px] font-medium">⏎</span></ToolbarButton>
      <SheetSplitButton label={t('sheetMergeCenter')} menuLabel={t('sheetMergeMenu')} active={merged} disabled={disabled}
        onClick={() => merge(merged ? MergeAction.Unmerge : MergeAction.Center)}
        items={MERGE_MENU.map(item => ({ key: item.action, label: t(item.label), onSelect: () => merge(item.action) }))}>
        <span className="text-[11px] font-medium">⊞</span>
      </SheetSplitButton>
      <SheetSplitButton label={t(lastBorder.label)} menuLabel={t('sheetBordersMenu')} disabled={disabled} onClick={() => border(lastBorder)}
        items={BORDERS.map(item => ({ key: item.label, label: t(item.label), onSelect: () => border(item) }))}>
        <BorderIcon border={lastBorder} />
      </SheetSplitButton>
      <ToolbarButton label="sheetFormatPainter" active={session.formatPainterActive} disabled={disabled}
        onClick={() => toggle(FormatCommand.PainterOnce)} onDoubleClick={() => toggle(FormatCommand.PainterKeep)}>
        <PaintBrushIcon className="h-4 w-4" />
      </ToolbarButton>
      <select className="lobster-sheet-compact" aria-label={t('sheetNumberFormat')} title={t('sheetNumberFormat')} disabled={disabled}
        value={formats.find(item => item.pattern === format)?.pattern ?? ''}
        onChange={event => {
          if (event.target.value === MORE_NUMBER_FORMATS) toggle(FormatCommand.NumberFormatPanel);
          else apply(target => target.setNumberFormat(event.target.value));
        }}>
        <option value="" disabled>{t('sheetNumberFormat')}</option>
        {formats.map(item => <option key={item.pattern} value={item.pattern}>{t(item.label)}</option>)}
        <option value={MORE_NUMBER_FORMATS}>{t('sheetMoreNumberFormats')}</option>
      </select>
      <ToolbarButton label="sheetMoreDecimals" disabled={disabled} onClick={() => toggle(FormatCommand.MoreDecimals)}>
        <span className="text-[11px] font-medium">.0+</span>
      </ToolbarButton>
      <ToolbarButton label="sheetFewerDecimals" disabled={disabled} onClick={() => toggle(FormatCommand.FewerDecimals)}>
        <span className="text-[11px] font-medium">.0−</span>
      </ToolbarButton>
      <span className="lobster-sheet-toolbar-divider" />
      <SheetSplitButton label={t('sheetAutoSum')} menuLabel={t('sheetAutoSumMenu')} disabled={disabled}
        onClick={() => toggle(DataCommand.InsertFunction, { value: AUTO_SUM_FUNCTIONS[0].name })}
        items={[
          ...AUTO_SUM_FUNCTIONS.map(item => ({ key: item.name, label: t(item.label), onSelect: () => toggle(DataCommand.InsertFunction, { value: item.name }) })),
          { key: 'more', label: t('sheetMoreFunctions'), onSelect: () => toggle(DataCommand.MoreFunctions) },
        ]}>
        <span className="text-[14px]">Σ</span>
      </SheetSplitButton>
      <ToolbarButton label="sheetFilter" active={filtered} disabled={disabled} onClick={() => toggle(DataCommand.ToggleFilter)}>
        <FunnelIcon className="h-4 w-4" />
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
      {showSettings && chart && anchor && createPortal(
        <SheetChartSettings session={session} chart={chart} disabled={disabled} onClose={() => session.showChartSettings(false)}
          style={{ position: 'fixed', top: anchor.top, right: anchor.right }} />,
        document.body,
      )}
    </div>
  );
}
