import {
  Bars3BottomLeftIcon, Bars3BottomRightIcon, Bars3CenterLeftIcon, BoldIcon, ChartBarIcon, CheckIcon, EllipsisHorizontalIcon, FunnelIcon,
  ItalicIcon, PaintBrushIcon, PhotoIcon, StrikethroughIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import { BorderStyleTypes, BorderType, HorizontalAlign, type IStyleData, VerticalAlign, WrapStrategy } from '@univerjs/core';
import type { FRange } from '@univerjs/sheets/facade';
import { SheetsFilterService } from '@univerjs/sheets-filter';
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { type ChartKind, chartKind } from '@/services/office/sheet/sheetChartSpec';
import type { SheetEditorSession } from '@/services/office/sheet/sheetEditorSession';
import { MergeAction, mergeSelection } from '@/services/office/sheet/sheetMerge';
import { CURRENCY_FORMAT } from '@/services/office/sheet/sheetShortcuts';
import { resolveSheetToolbarDensity, SheetToolbarDensity } from '@/services/office/sheet/sheetToolbarLayout';

import { ColorTarget, OfficeColorButton } from '../common/toolbar/OfficeColorButton';
import { OfficeSplitButton, ToolbarPopoverPanel, useToolbarPopover } from '../common/toolbar/OfficePopover';
import {
  OfficeFontSelect, OfficeFontSizeSelect, OfficeToolbar, OfficeToolbarButton, OfficeToolbarDivider,
} from '../common/toolbar/OfficeToolbar';
import { CHART_KINDS, SheetChartSettings } from './SheetChartSettings';

const t = (key: string) => i18nService.t(key);
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

const ALIGN_MENU_WIDTH = 156;
const CHART_MENU_WIDTH = 156;
const OVERFLOW_MENU_WIDTH = 220;

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
const HORIZONTAL_ALIGNMENTS = [
  { label: 'officeAlignLeft', value: 'left', align: HorizontalAlign.LEFT, icon: Bars3BottomLeftIcon },
  { label: 'officeAlignCenter', value: 'center', align: HorizontalAlign.CENTER, icon: Bars3CenterLeftIcon },
  { label: 'officeAlignRight', value: 'normal', align: HorizontalAlign.RIGHT, icon: Bars3BottomRightIcon },
] as const;
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
/** Compact border presets surfaced in the narrow overflow menu. */
const QUICK_BORDERS = [BORDERS[5], BORDERS[6], BORDERS[0], BORDERS[8], BORDERS[9], BORDERS[4]] as const;
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
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
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
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" aria-hidden="true">
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

export function SheetToolbar({ session, disabled }: { session: SheetEditorSession; disabled: boolean }): React.ReactElement {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const barWrapRef = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const alignPopover = useToolbarPopover(ALIGN_MENU_WIDTH);
  const chartPopover = useToolbarPopover(CHART_MENU_WIDTH);
  const morePopover = useToolbarPopover(OVERFLOW_MENU_WIDTH);

  useEffect(() => {
    const element = barWrapRef.current;
    if (!element) return undefined;
    setBarWidth(element.clientWidth);
    const observer = new ResizeObserver(entries => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? element.clientWidth);
      setBarWidth(prev => (prev === nextWidth ? prev : nextWidth));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const density = resolveSheetToolbarDensity(barWidth);
  const isFull = density === SheetToolbarDensity.Full;
  const isMinimal = density === SheetToolbarDensity.Minimal;

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
  const activeHAlign = HORIZONTAL_ALIGNMENTS.find(item => item.align === style.ht) ?? HORIZONTAL_ALIGNMENTS[0];
  const ActiveHAlignIcon = activeHAlign.icon;
  // Excel aligns cells to the bottom unless they say otherwise.
  const verticalAlign = style.vt || VerticalAlign.BOTTOM;
  const wrapped = style.tb === WrapStrategy.WRAP;
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
    <div ref={barWrapRef} className="lobster-sheet-format-bar">
      <OfficeToolbar label="sheetToolbar" toolbarRef={toolbar}>
        {!isMinimal && (
          <OfficeFontSelect
            className="lobster-sheet-font-select"
            value={fontName ?? undefined}
            disabled={disabled}
            onChange={font => apply(target => target.setFontFamily(font))}
          />
        )}
        <OfficeFontSizeSelect
          className="lobster-sheet-size-select"
          value={fontSize ?? undefined}
          disabled={disabled}
          onChange={size => apply(target => target.setFontSize(size))}
        />
        <OfficeToolbarButton label="officeBold" active={style.bl === 1} disabled={disabled}
          onClick={() => toggle(ToggleCommand.Bold)}><BoldIcon className="h-3.5 w-3.5" /></OfficeToolbarButton>
        {!isMinimal && (
          <>
            <OfficeToolbarButton label="officeItalic" active={style.it === 1} disabled={disabled}
              onClick={() => toggle(ToggleCommand.Italic)}><ItalicIcon className="h-3.5 w-3.5" /></OfficeToolbarButton>
            <OfficeToolbarButton label="officeUnderline" active={style.ul?.s === 1} disabled={disabled}
              onClick={() => toggle(ToggleCommand.Underline)}><UnderlineIcon className="h-3.5 w-3.5" /></OfficeToolbarButton>
          </>
        )}
        {isFull && (
          <OfficeToolbarButton label="officeStrike" active={style.st?.s === 1} disabled={disabled}
            onClick={() => toggle(ToggleCommand.Strike)}><StrikethroughIcon className="h-3.5 w-3.5" /></OfficeToolbarButton>
        )}
        <OfficeColorButton target={ColorTarget.Font} themeColors={session.themeColors} disabled={disabled}
          onPick={color => (color ? apply(target => target.setFontColor(color)) : toggle(ColorCommand.Automatic))} />
        <OfficeColorButton target={ColorTarget.Fill} themeColors={session.themeColors} disabled={disabled}
          onPick={color => (color ? apply(target => target.setBackgroundColor(color)) : toggle(ColorCommand.NoFill))} />

        <OfficeToolbarDivider />

        {/* Unified Alignment dropdown (replaces 6 individual horizontal + vertical buttons) */}
        <button
          ref={alignPopover.trigger}
          type="button"
          className="lobster-sheet-menu-button"
          title={t('sheetAlignMenu')}
          aria-label={t('sheetAlignMenu')}
          aria-haspopup="menu"
          aria-expanded={alignPopover.open}
          disabled={disabled}
          onMouseDown={keepFocus}
          onClick={() => alignPopover.setOpen(open => !open)}
        >
          <ActiveHAlignIcon className="h-3.5 w-3.5" />
          <span aria-hidden="true">▾</span>
        </button>
        <ToolbarPopoverPanel popover={alignPopover} label={t('sheetAlignMenu')} width={ALIGN_MENU_WIDTH}>
          {alignPopover.open && (
            <>
              <span className="lobster-sheet-menu-heading">{t('sheetAlignHorizontal')}</span>
              {HORIZONTAL_ALIGNMENTS.map(({ label, value, align, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={`lobster-office-menu-item lobster-sheet-popover-item${style.ht === align ? ' is-active' : ''}`}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    alignPopover.setOpen(false);
                    apply(target => target.setHorizontalAlignment(value));
                  }}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t(label)}</span>
                </button>
              ))}
              <span className="lobster-sheet-menu-divider" role="separator" />
              <span className="lobster-sheet-menu-heading">{t('sheetAlignVertical')}</span>
              {VERTICAL_ALIGNMENTS.map(item => (
                <button
                  key={item.value}
                  type="button"
                  className={`lobster-office-menu-item lobster-sheet-popover-item${verticalAlign === item.align ? ' is-active' : ''}`}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    alignPopover.setOpen(false);
                    apply(target => target.setVerticalAlignment(item.value));
                  }}
                >
                  <VerticalAlignIcon at={item.value} />
                  <span>{t(item.label)}</span>
                </button>
              ))}
            </>
          )}
        </ToolbarPopoverPanel>

        {!isMinimal && (
          <>
            <OfficeToolbarButton label="sheetWrap" active={wrapped} disabled={disabled}
              onClick={() => apply(target => target.setWrap(!wrapped))}><span className="text-[11px] font-medium">⏎</span></OfficeToolbarButton>
            <OfficeSplitButton label={t('sheetMergeCenter')} menuLabel={t('sheetMergeMenu')} active={merged} disabled={disabled}
              onClick={() => merge(merged ? MergeAction.Unmerge : MergeAction.Center)}
              items={MERGE_MENU.map(item => ({ key: item.action, label: t(item.label), onSelect: () => merge(item.action) }))}>
              <span className="text-[11px] font-medium">⊞</span>
            </OfficeSplitButton>
            <OfficeSplitButton label={t(lastBorder.label)} menuLabel={t('sheetBordersMenu')} disabled={disabled} onClick={() => border(lastBorder)}
              items={BORDERS.map(item => ({ key: item.label, label: t(item.label), onSelect: () => border(item) }))}>
              <BorderIcon border={lastBorder} />
            </OfficeSplitButton>
          </>
        )}

        {isFull && (
          <OfficeToolbarButton label="sheetFormatPainter" active={session.formatPainterActive} disabled={disabled}
            onClick={() => toggle(FormatCommand.PainterOnce)} onDoubleClick={() => toggle(FormatCommand.PainterKeep)}>
            <PaintBrushIcon className="h-3.5 w-3.5" />
          </OfficeToolbarButton>
        )}

        <OfficeToolbarDivider />

        <select className="lobster-sheet-numfmt-select" aria-label={t('sheetNumberFormat')} title={t('sheetNumberFormat')} disabled={disabled}
          value={formats.find(item => item.pattern === format)?.pattern ?? ''}
          onChange={event => {
            if (event.target.value === MORE_NUMBER_FORMATS) toggle(FormatCommand.NumberFormatPanel);
            else apply(target => target.setNumberFormat(event.target.value));
          }}>
          <option value="" disabled>{t('sheetNumberFormat')}</option>
          {formats.map(item => <option key={item.pattern} value={item.pattern}>{t(item.label)}</option>)}
          <option value={MORE_NUMBER_FORMATS}>{t('sheetMoreNumberFormats')}</option>
        </select>

        {isFull && (
          <>
            <OfficeToolbarButton label="sheetMoreDecimals" disabled={disabled} onClick={() => toggle(FormatCommand.MoreDecimals)}>
              <span className="text-[11px] font-medium">.0+</span>
            </OfficeToolbarButton>
            <OfficeToolbarButton label="sheetFewerDecimals" disabled={disabled} onClick={() => toggle(FormatCommand.FewerDecimals)}>
              <span className="text-[11px] font-medium">.0−</span>
            </OfficeToolbarButton>
          </>
        )}

        <OfficeToolbarDivider />

        {isFull && (
          <OfficeSplitButton label={t('sheetAutoSum')} menuLabel={t('sheetAutoSumMenu')} disabled={disabled}
            onClick={() => toggle(DataCommand.InsertFunction, { value: AUTO_SUM_FUNCTIONS[0].name })}
            items={[
              ...AUTO_SUM_FUNCTIONS.map(item => ({ key: item.name, label: t(item.label), onSelect: () => toggle(DataCommand.InsertFunction, { value: item.name }) })),
              { key: 'more', label: t('sheetMoreFunctions'), onSelect: () => toggle(DataCommand.MoreFunctions) },
            ]}>
            <span className="text-[13px]">Σ</span>
          </OfficeSplitButton>
        )}

        <OfficeToolbarButton label="sheetFilter" active={filtered} disabled={disabled} onClick={() => toggle(DataCommand.ToggleFilter)}>
          <FunnelIcon className="h-3.5 w-3.5" />
        </OfficeToolbarButton>

        {isFull && (
          <>
            <OfficeToolbarDivider />
            <OfficeToolbarButton label="sheetInsertImage" disabled={disabled} onClick={() => toggle(INSERT_PICTURE)}>
              <PhotoIcon className="h-3.5 w-3.5" />
            </OfficeToolbarButton>
            <button
              ref={chartPopover.trigger}
              type="button"
              className="lobster-sheet-menu-button"
              title={t('sheetInsertChart')}
              aria-label={t('sheetInsertChart')}
              aria-haspopup="menu"
              aria-expanded={chartPopover.open}
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => chartPopover.setOpen(open => !open)}
            >
              <ChartBarIcon className="h-3.5 w-3.5" />
              <span aria-hidden="true">▾</span>
            </button>
            <ToolbarPopoverPanel popover={chartPopover} label={t('sheetInsertChart')} width={CHART_MENU_WIDTH}>
              {chartPopover.open && CHART_KINDS.map(item => (
                <button
                  key={item.kind}
                  type="button"
                  className="lobster-office-menu-item lobster-sheet-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    chartPopover.setOpen(false);
                    session.insertChart(item.kind as ChartKind);
                  }}
                >
                  <ChartBarIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t(item.label)}</span>
                </button>
              ))}
            </ToolbarPopoverPanel>
          </>
        )}

        {editable && (
          <OfficeToolbarButton label="sheetChartSettings" active={settingsOpen} disabled={disabled}
            onClick={() => session.showChartSettings(!settingsOpen)}>
            <ChartBarIcon className="h-3.5 w-3.5" />
          </OfficeToolbarButton>
        )}

        {!isFull && (
          <>
            <button
              ref={morePopover.trigger}
              type="button"
              className={`lobster-sheet-overflow-trigger${morePopover.open ? ' is-active' : ''}`}
              title={t('sheetMoreTools')}
              aria-label={t('sheetMoreTools')}
              aria-haspopup="menu"
              aria-expanded={morePopover.open}
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => morePopover.setOpen(open => !open)}
            >
              <EllipsisHorizontalIcon className="h-4 w-4" />
            </button>
            <ToolbarPopoverPanel popover={morePopover} label={t('sheetMoreTools')} width={OVERFLOW_MENU_WIDTH}>
              {morePopover.open && (
                <div className="lobster-sheet-overflow-panel">
                  {isMinimal && (
                    <>
                      <div className="lobster-sheet-overflow-row">
                        <OfficeFontSelect
                          className="lobster-sheet-overflow-font"
                          value={fontName ?? undefined}
                          disabled={disabled}
                          onChange={font => apply(target => target.setFontFamily(font))}
                        />
                      </div>
                      <div className="lobster-sheet-overflow-icon-row">
                        <button type="button" className={`lobster-sheet-overflow-chip${style.it === 1 ? ' is-active' : ''}`}
                          title={t('officeItalic')} aria-label={t('officeItalic')} onMouseDown={keepFocus}
                          onClick={() => toggle(ToggleCommand.Italic)}><ItalicIcon className="h-3.5 w-3.5" /></button>
                        <button type="button" className={`lobster-sheet-overflow-chip${style.ul?.s === 1 ? ' is-active' : ''}`}
                          title={t('officeUnderline')} aria-label={t('officeUnderline')} onMouseDown={keepFocus}
                          onClick={() => toggle(ToggleCommand.Underline)}><UnderlineIcon className="h-3.5 w-3.5" /></button>
                        <button type="button" className={`lobster-sheet-overflow-chip${style.st?.s === 1 ? ' is-active' : ''}`}
                          title={t('officeStrike')} aria-label={t('officeStrike')} onMouseDown={keepFocus}
                          onClick={() => toggle(ToggleCommand.Strike)}><StrikethroughIcon className="h-3.5 w-3.5" /></button>
                        <button type="button" className={`lobster-sheet-overflow-chip${session.formatPainterActive ? ' is-active' : ''}`}
                          title={t('sheetFormatPainter')} aria-label={t('sheetFormatPainter')} onMouseDown={keepFocus}
                          onClick={() => { morePopover.setOpen(false); toggle(FormatCommand.PainterOnce); }}
                          onDoubleClick={() => { morePopover.setOpen(false); toggle(FormatCommand.PainterKeep); }}>
                          <PaintBrushIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <span className="lobster-sheet-menu-divider" role="separator" />
                      <button type="button" className={`lobster-office-menu-item lobster-sheet-popover-item${wrapped ? ' is-active' : ''}`}
                        onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); apply(target => target.setWrap(!wrapped)); }}>
                        <CheckIcon className={`h-3.5 w-3.5 shrink-0${wrapped ? '' : ' opacity-0'}`} aria-hidden="true" />
                        <span>{t('sheetWrap')}</span>
                      </button>
                      <button type="button" className={`lobster-office-menu-item lobster-sheet-popover-item${merged ? ' is-active' : ''}`}
                        onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); merge(merged ? MergeAction.Unmerge : MergeAction.Center); }}>
                        <CheckIcon className={`h-3.5 w-3.5 shrink-0${merged ? '' : ' opacity-0'}`} aria-hidden="true" />
                        <span>{t(merged ? 'sheetUnmergeCells' : 'sheetMergeCenter')}</span>
                      </button>
                      <span className="lobster-sheet-menu-heading">{t('sheetBordersMenu')}</span>
                      <div className="lobster-sheet-overflow-icon-row">
                        {QUICK_BORDERS.map(item => (
                          <button key={item.label} type="button" className="lobster-sheet-overflow-chip"
                            title={t(item.label)} aria-label={t(item.label)} onMouseDown={keepFocus}
                            onClick={() => { morePopover.setOpen(false); border(item); }}>
                            <BorderIcon border={item} />
                          </button>
                        ))}
                      </div>
                      <span className="lobster-sheet-menu-divider" role="separator" />
                    </>
                  )}

                  {!isMinimal && (
                    <>
                      <button type="button" className={`lobster-office-menu-item lobster-sheet-popover-item${style.st?.s === 1 ? ' is-active' : ''}`}
                        onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); toggle(ToggleCommand.Strike); }}>
                        <StrikethroughIcon className="h-3.5 w-3.5 shrink-0" />
                        <span>{t('officeStrike')}</span>
                      </button>
                      <button type="button" className={`lobster-office-menu-item lobster-sheet-popover-item${session.formatPainterActive ? ' is-active' : ''}`}
                        onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); toggle(FormatCommand.PainterOnce); }}>
                        <PaintBrushIcon className="h-3.5 w-3.5 shrink-0" />
                        <span>{t('sheetFormatPainter')}</span>
                      </button>
                      <span className="lobster-sheet-menu-divider" role="separator" />
                    </>
                  )}

                  <div className="lobster-sheet-overflow-icon-row">
                    <button type="button" className="lobster-sheet-overflow-chip" title={t('sheetMoreDecimals')} aria-label={t('sheetMoreDecimals')}
                      onMouseDown={keepFocus} onClick={() => toggle(FormatCommand.MoreDecimals)}>
                      <span className="text-[11px] font-medium">.0+</span>
                    </button>
                    <button type="button" className="lobster-sheet-overflow-chip" title={t('sheetFewerDecimals')} aria-label={t('sheetFewerDecimals')}
                      onMouseDown={keepFocus} onClick={() => toggle(FormatCommand.FewerDecimals)}>
                      <span className="text-[11px] font-medium">.0−</span>
                    </button>
                    <button type="button" className="lobster-sheet-overflow-chip" title={t('sheetAutoSum')} aria-label={t('sheetAutoSum')}
                      onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); toggle(DataCommand.InsertFunction, { value: AUTO_SUM_FUNCTIONS[0].name }); }}>
                      <span className="text-[13px] font-medium">Σ</span>
                    </button>
                  </div>

                  <span className="lobster-sheet-menu-heading">{t('sheetAutoSumMenu')}</span>
                  {AUTO_SUM_FUNCTIONS.map(item => (
                    <button key={item.name} type="button" className="lobster-office-menu-item lobster-sheet-popover-item"
                      onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); toggle(DataCommand.InsertFunction, { value: item.name }); }}>
                      <span>{t(item.label)}</span>
                    </button>
                  ))}
                  <button type="button" className="lobster-office-menu-item lobster-sheet-popover-item"
                    onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); toggle(DataCommand.MoreFunctions); }}>
                    <span>{t('sheetMoreFunctions')}</span>
                  </button>

                  <span className="lobster-sheet-menu-divider" role="separator" />

                  <button type="button" className="lobster-office-menu-item lobster-sheet-popover-item"
                    onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); toggle(INSERT_PICTURE); }}>
                    <PhotoIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t('sheetInsertImage')}</span>
                  </button>
                  <span className="lobster-sheet-menu-heading">{t('sheetInsertChart')}</span>
                  {CHART_KINDS.map(item => (
                    <button key={item.kind} type="button" className="lobster-office-menu-item lobster-sheet-popover-item"
                      onMouseDown={keepFocus} onClick={() => { morePopover.setOpen(false); session.insertChart(item.kind as ChartKind); }}>
                      <ChartBarIcon className="h-3.5 w-3.5 shrink-0" />
                      <span>{t(item.label)}</span>
                    </button>
                  ))}
                </div>
              )}
            </ToolbarPopoverPanel>
          </>
        )}

        {showSettings && chart && anchor && createPortal(
          <SheetChartSettings session={session} chart={chart} disabled={disabled} onClose={() => session.showChartSettings(false)}
            style={{ position: 'fixed', top: anchor.top, right: anchor.right }} />,
          document.body,
        )}
      </OfficeToolbar>
    </div>
  );
}
