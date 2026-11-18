import { BorderStyleTypes, BorderType, CommandType, ICommandService, type IDisposable, type Univer } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';
import type { FRange, FWorksheet } from '@univerjs/sheets/facade';
import { whenSheetEditorFocused } from '@univerjs/sheets-ui';
import { IShortcutService, KeyCode, MetaKeys } from '@univerjs/ui';

import { enterIntoActiveCell } from './sheetCellEditor';
import type { SheetLanguage } from './sheetUniverEngine';

/**
 * Excel's keyboard shortcuts that Univer lacks: Format Cells (number formats), the current date and
 * time, the number format shortcuts (Ctrl+Shift+$, %, …), outline borders, and moving to the sheet's
 * start or end, the row's start and the next or previous sheet. Each platform gets Excel's own
 * keys: Control-based ones on a Mac, where Command+Shift+digits belong to the system.
 */

/** Key codes Univer's KeyCode enum does not name. */
const SEMICOLON = 186;
const BACKQUOTE = 192;
const PAGE_UP = 33;
const PAGE_DOWN = 34;

/** Univer's number format panel: what Excel's Format Cells dialog opens on (Ctrl+1). */
const NUMBER_FORMAT_PANEL = 'sheet.operation.open.numfmt.panel';

/** Currency formats of the toolbar and Ctrl+Shift+$. */
export const CURRENCY_FORMAT: Record<SheetLanguage, string> = { zh: '¥#,##0.00', en: '$#,##0.00' };

export const ShortcutCommand = {
  FormatCells: 'lobster.operation.format-cells',
  InsertDate: 'lobster.operation.insert-current-date',
  InsertTime: 'lobster.operation.insert-current-time',
  GeneralFormat: 'lobster.command.general-format',
  CurrencyFormat: 'lobster.command.currency-format',
  PercentFormat: 'lobster.command.percent-format',
  ScientificFormat: 'lobster.command.scientific-format',
  DateFormat: 'lobster.command.date-format',
  TimeFormat: 'lobster.command.time-format',
  NumberFormat: 'lobster.command.number-format',
  OutlineBorder: 'lobster.command.outline-border',
  RemoveBorders: 'lobster.command.remove-borders',
  GoToStart: 'lobster.operation.go-to-sheet-start',
  GoToEnd: 'lobster.operation.go-to-sheet-end',
  GoToRowStart: 'lobster.operation.go-to-row-start',
  NextSheet: 'lobster.operation.next-sheet',
  PreviousSheet: 'lobster.operation.previous-sheet',
} as const;
export type ShortcutCommand = typeof ShortcutCommand[keyof typeof ShortcutCommand];

/** Excel's number formats behind its Ctrl+Shift shortcuts. */
function shortcutFormats(language: SheetLanguage): Partial<Record<ShortcutCommand, string>> {
  return {
    [ShortcutCommand.GeneralFormat]: 'General',
    [ShortcutCommand.CurrencyFormat]: CURRENCY_FORMAT[language],
    [ShortcutCommand.PercentFormat]: '0%',
    [ShortcutCommand.ScientificFormat]: '0.00E+00',
    [ShortcutCommand.DateFormat]: language === 'zh' ? 'yyyy/m/d' : 'd-mmm-yy',
    [ShortcutCommand.TimeFormat]: language === 'zh' ? 'h:mm' : 'h:mm AM/PM',
    [ShortcutCommand.NumberFormat]: '#,##0.00',
  };
}

/** Windows and Linux keys, then the Mac ones (Excel for Mac's own); 0 where a platform has none. */
const BINDINGS: { id: ShortcutCommand; binding: number; mac: number }[] = [
  { id: ShortcutCommand.FormatCells, binding: KeyCode.Digit1 | MetaKeys.CTRL_COMMAND, mac: KeyCode.Digit1 | MetaKeys.CTRL_COMMAND },
  { id: ShortcutCommand.InsertDate, binding: SEMICOLON | MetaKeys.CTRL_COMMAND, mac: SEMICOLON | MetaKeys.MAC_CTRL },
  { id: ShortcutCommand.InsertTime, binding: SEMICOLON | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: SEMICOLON | MetaKeys.CTRL_COMMAND },
  { id: ShortcutCommand.GeneralFormat, binding: BACKQUOTE | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: BACKQUOTE | MetaKeys.MAC_CTRL | MetaKeys.SHIFT },
  { id: ShortcutCommand.CurrencyFormat, binding: KeyCode.Digit4 | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.Digit4 | MetaKeys.MAC_CTRL | MetaKeys.SHIFT },
  { id: ShortcutCommand.PercentFormat, binding: KeyCode.Digit5 | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.Digit5 | MetaKeys.MAC_CTRL | MetaKeys.SHIFT },
  { id: ShortcutCommand.ScientificFormat, binding: KeyCode.Digit6 | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.Digit6 | MetaKeys.MAC_CTRL | MetaKeys.SHIFT },
  { id: ShortcutCommand.DateFormat, binding: KeyCode.Digit3 | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.Digit3 | MetaKeys.MAC_CTRL | MetaKeys.SHIFT },
  { id: ShortcutCommand.TimeFormat, binding: KeyCode.Digit2 | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.Digit2 | MetaKeys.MAC_CTRL | MetaKeys.SHIFT },
  { id: ShortcutCommand.NumberFormat, binding: KeyCode.Digit1 | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.Digit1 | MetaKeys.MAC_CTRL | MetaKeys.SHIFT },
  { id: ShortcutCommand.OutlineBorder, binding: KeyCode.Digit7 | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.Digit0 | MetaKeys.CTRL_COMMAND | MetaKeys.ALT },
  { id: ShortcutCommand.RemoveBorders, binding: KeyCode.MINUS | MetaKeys.CTRL_COMMAND | MetaKeys.SHIFT, mac: KeyCode.MINUS | MetaKeys.CTRL_COMMAND | MetaKeys.ALT },
  // Mac keyboards type Home, End and the page keys with fn and the arrows.
  { id: ShortcutCommand.GoToStart, binding: KeyCode.HOME | MetaKeys.CTRL_COMMAND, mac: KeyCode.HOME | MetaKeys.MAC_CTRL },
  { id: ShortcutCommand.GoToEnd, binding: KeyCode.END | MetaKeys.CTRL_COMMAND, mac: KeyCode.END | MetaKeys.MAC_CTRL },
  { id: ShortcutCommand.GoToRowStart, binding: KeyCode.HOME, mac: KeyCode.HOME },
  { id: ShortcutCommand.NextSheet, binding: PAGE_DOWN | MetaKeys.CTRL_COMMAND, mac: PAGE_DOWN | MetaKeys.MAC_CTRL },
  { id: ShortcutCommand.PreviousSheet, binding: PAGE_UP | MetaKeys.CTRL_COMMAND, mac: PAGE_UP | MetaKeys.MAC_CTRL },
  { id: ShortcutCommand.NextSheet, binding: 0, mac: KeyCode.ARROW_RIGHT | MetaKeys.ALT },
  { id: ShortcutCommand.PreviousSheet, binding: 0, mac: KeyCode.ARROW_LEFT | MetaKeys.ALT },
];

/** Shortcuts that only open or move to something; the formats and borders are edits. */
const OPERATIONS = new Set<string>([
  ShortcutCommand.FormatCells, ShortcutCommand.InsertDate, ShortcutCommand.InsertTime, ShortcutCommand.GoToStart, ShortcutCommand.GoToEnd,
  ShortcutCommand.GoToRowStart, ShortcutCommand.NextSheet, ShortcutCommand.PreviousSheet,
]);

const pad = (value: number): string => String(value).padStart(2, '0');

/** The current date or time as typed into a cell; the cell turns it into a date serial on Enter. */
export function currentDateTimeText(kind: typeof ShortcutCommand.InsertDate | typeof ShortcutCommand.InsertTime, now = new Date()): string {
  return kind === ShortcutCommand.InsertDate
    ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    : `${now.getHours()}:${pad(now.getMinutes())}`;
}

export interface ExcelShortcutOptions {
  language: SheetLanguage;
}

export function installExcelShortcuts(univer: Univer, api: FUniver, { language }: ExcelShortcutOptions): IDisposable {
  const injector = univer.__getInjector();
  const commands = injector.get(ICommandService);
  const shortcuts = injector.get(IShortcutService);
  const disposers: IDisposable[] = [];
  const onRange = (change: (range: FRange) => unknown) => () => {
    const range = api.getActiveWorkbook()?.getActiveRange();
    if (!range) return false;
    change(range);
    return true;
  };
  // Excel types the date or time into the cell being entered: Enter keeps it, Escape drops it.
  const typeInto = (kind: typeof ShortcutCommand.InsertDate | typeof ShortcutCommand.InsertTime) => () => enterIntoActiveCell(univer, currentDateTimeText(kind));
  // Excel's moves: the first cell below and right of frozen panes, the last used cell, the row's first cell.
  const goTo = (target: (sheet: FWorksheet) => [number, number]) => () => {
    const sheet = api.getActiveWorkbook()?.getActiveSheet();
    if (!sheet) return false;
    const [row, column] = target(sheet);
    sheet.getRange(row, column).activate();
    sheet.scrollToCell(row, column);
    return true;
  };
  const frozen = (sheet: FWorksheet) => sheet.getSheet().getFreeze();
  // Excel skips hidden sheets and stops at the first and last one.
  const switchSheet = (step: number) => () => {
    const workbook = api.getActiveWorkbook();
    if (!workbook) return false;
    const sheets = workbook.getSheets().filter(sheet => !sheet.isSheetHidden());
    const index = sheets.findIndex(sheet => sheet.getSheetId() === workbook.getActiveSheet().getSheetId());
    const next = sheets[index + step];
    if (next) workbook.setActiveSheet(next);
    return Boolean(next);
  };
  const handlers: Record<ShortcutCommand, () => boolean> = {
    [ShortcutCommand.GoToStart]: goTo(sheet => [frozen(sheet).ySplit, frozen(sheet).xSplit]),
    [ShortcutCommand.GoToEnd]: goTo(sheet => [Math.max(0, sheet.getSheet().getLastRowWithContent()), Math.max(0, sheet.getSheet().getLastColumnWithContent())]),
    [ShortcutCommand.GoToRowStart]: goTo(sheet => [sheet.getSelection()?.getCurrentCell()?.actualRow ?? 0, frozen(sheet).xSplit]),
    [ShortcutCommand.NextSheet]: switchSheet(1),
    [ShortcutCommand.PreviousSheet]: switchSheet(-1),
    [ShortcutCommand.FormatCells]: () => { void commands.executeCommand(NUMBER_FORMAT_PANEL); return true; },
    [ShortcutCommand.InsertDate]: typeInto(ShortcutCommand.InsertDate),
    [ShortcutCommand.InsertTime]: typeInto(ShortcutCommand.InsertTime),
    [ShortcutCommand.OutlineBorder]: onRange(range => range.setBorder(BorderType.OUTSIDE, BorderStyleTypes.THIN, '#000000')),
    [ShortcutCommand.RemoveBorders]: onRange(range => range.setBorder(BorderType.NONE, BorderStyleTypes.THIN, '#000000')),
    ...Object.fromEntries(Object.entries(shortcutFormats(language)).map(([id, pattern]) => [id, onRange(range => range.setNumberFormat(pattern))])),
  } as Record<ShortcutCommand, () => boolean>;
  for (const id of new Set(BINDINGS.map(item => item.id))) {
    disposers.push(commands.registerCommand({ id, type: OPERATIONS.has(id) ? CommandType.OPERATION : CommandType.COMMAND, handler: handlers[id] }));
  }
  for (const item of BINDINGS) {
    disposers.push(shortcuts.registerShortcut({ id: item.id, binding: item.binding || undefined, mac: item.mac || undefined, preconditions: whenSheetEditorFocused }));
  }
  return { dispose: () => disposers.forEach(disposer => disposer.dispose()) };
}
