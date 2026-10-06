import {
  CommandType, CustomCommandExecutionError, DrawingTypeEnum, extractPureTextFromCell, FOCUSING_COMMON_DRAWINGS, FOCUSING_FX_BAR_EDITOR, FOCUSING_PANEL_EDITOR,
  FOCUSING_SHAPE_TEXT_EDITOR, FOCUSING_SHEET, type ICellData, ICommandService, IContextService, type IDisposable, InterceptorEffectEnum, IResourceManagerService, IUndoRedoService, type IWorkbookData,
  LocaleService, type Serializable, ThemeService, type Univer, UniverInstanceType, type Workbook,
} from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';
import { getDrawingShapeKeyByDrawingSearch, getOrCreateDrawingCopyPlan, IDrawingManagerService, SetDrawingSelectedOperation } from '@univerjs/drawing';
import { IRenderManagerService } from '@univerjs/engine-render';
import {
  AUTO_FILL_HOOK_TYPE, BEFORE_CELL_EDIT, CopySheetCommand, IAutoFillService, INTERCEPTOR_POINT, SetRangeValuesCommand, SheetInterceptorService, SheetSkeletonService,
  SheetsSelectionsService,
} from '@univerjs/sheets';
import type { FWorkbook } from '@univerjs/sheets/facade';
import { drawingPositionToTransform, InsertSheetDrawingCommand, ISheetDrawingService, RemoveSheetDrawingCommand, SetSheetDrawingCommand } from '@univerjs/sheets-drawing';
import { DeleteDrawingsCommand } from '@univerjs/sheets-drawing-ui';
import { SheetsFilterService } from '@univerjs/sheets-filter';
import { AutoHeightController, FormatPainterStatus, IFormatPainterService, ISheetClipboardService, SheetCanvasPopManagerService } from '@univerjs/sheets-ui';
import { DISABLE_AUTO_FOCUS_KEY, IShortcutService, KeyCode } from '@univerjs/ui';
import { BehaviorSubject } from 'rxjs';

import type { OfficeOpenResult } from '../../../../shared/office/core/officeFile';
import { SHEET_MAX_CELLS, type SheetPackageInfo } from '../../../../shared/office/sheet/sheetFile';
import { i18nService } from '../../i18n';
import { OfficeExportRefusal } from '../core/officeDocument';
import { createOfficeEditorRegistry } from '../core/officeEditorRegistry';
import { OfficeEditorSession, type OfficeSessionContext } from '../core/officeEditorSession';
import { prepareOfficeFonts } from '../core/officeFonts';
import { type CellRange, parseRangeReference, rangeReference } from './sheetAddress';
import { installPlainTypedCells } from './sheetCellInput';
import { chartHost, readChartData, registerChartHost, SHEET_CHART_COMPONENT } from './sheetChartHost';
import {
  chartFromRange, type ChartKind, chartKind, chartSeriesList, chartSourceRange, mapChartReferences, type SheetChartData, withChartData, withChartTitle,
} from './sheetChartSpec';
import { installAddToChat } from './sheetChatAction';
import type { SheetSelectionReference } from './sheetChatReference';
import type { EditorImport } from './sheetEditorImport';
import { createSheetFileClient, type SheetFileClient } from './sheetFileClient';
import { measureDigitWidth } from './sheetFonts';
import { installExcelShortcuts } from './sheetShortcuts';
import {
  expandThisRowReferences, type FormulaScope, formulaSheetName, IDENTITY_COLUMNS, IDENTITY_ROWS, laterEditsScope, shortenThisRowReferences, transformFormula,
} from './sheetStructure';
import { StructureRefusal } from './sheetStructureSupport';
import { StructureTracker, UNSUPPORTED_IMAGE_EDIT } from './sheetStructureTracker';
import { type DrawnTable, tableCellStyle, underCellStyle } from './sheetTableStyles';
import { registerWorkbookTables, type SheetLanguage, toUniverLocale } from './sheetUniverEngine';
import { createSheetFormulaWorker, createSheetUniver } from './sheetUniverUi';
import { installValidationPrompts } from './sheetValidationPrompt';
import type { ChartSpec } from './xlsxCharts';
import { XlsxExportError } from './xlsxExport';
import { pendingFilterValues } from './xlsxFilters';
import { type ImportOptions, XlsxImportError } from './xlsxImport';
import { StructurePlan } from './xlsxStructureExport';

const AUTOSAVE_DELAY_MS = 1000;
/** Mutations that change what the workbook shows but not what is saved. */
const VIEW_MUTATIONS = new Set([
  'sheet.mutation.set-worksheet-row-auto-height', 'sheet.mutation.set-worksheet-row-count', 'sheet.mutation.set-worksheet-column-count',
  'sheet.mutation.set-workbook-name', 'sheet.mutation.empty', 'sheet.mutation.mark-dirty-filter-change',
  'sheet.mutation.data-validation-formula-mark-dirty',
]);
/** Mutations of saved content: sheets, data validation rules and the hyperlink model. */
const EDIT_MUTATION = /^(?:sheet|sheets|data-validation)\.mutation\./;
const CALCULATION_WAIT_MS = 10_000;
/**
 * Excel for Mac deletes a selected picture or chart with fn+delete too; Univer binds only delete
 * (Backspace) there. Same conditions as Univer's own drawing shortcuts.
 */
const FORWARD_DELETE_DRAWINGS = {
  id: DeleteDrawingsCommand.id,
  binding: KeyCode.DELETE,
  priority: 100,
  preconditions: (context: IContextService) => Boolean(context.getContextValue(FOCUSING_SHEET) && context.getContextValue(FOCUSING_COMMON_DRAWINGS)
    && !context.getContextValue(FOCUSING_FX_BAR_EDITOR) && !context.getContextValue(FOCUSING_PANEL_EDITOR) && !context.getContextValue(FOCUSING_SHAPE_TEXT_EDITOR)),
};
/**
 * Univer's cell editor gives typed text its own default color (the theme's gray.900); committing
 * the edit then stamps that color on a cell that had none. Excel shows such cells in the
 * automatic font color, so the stray color is removed before the value is written.
 */
function dropEditorTextColor(params: unknown, editorColor: string): void {
  const value = (params as { value?: { s?: unknown } } | undefined)?.value;
  const style = value?.s;
  if (!style || typeof style !== 'object') return;
  const keys = Object.keys(style);
  const color = (style as { cl?: { rgb?: unknown } }).cl?.rgb;
  if (keys.length === 1 && keys[0] === 'cl' && typeof color === 'string' && color.toLowerCase() === editorColor.toLowerCase()) delete value.s;
}

/** The parts of `SetRangeValuesCommand` params the editor reads. */
interface SetRangeValuesParams {
  subUnitId?: string;
  range?: { startRow: number; startColumn: number };
  value?: ICellData | (ICellData | null)[][] | Record<number, Record<number, ICellData | null>>;
}

/** Table styles are drawn early, so conditional formats and number formats apply over them. */
const TABLE_STYLE_PRIORITY = 50;

/** Opens the chart settings of the selected chart (from the chart's menu over the grid). */
const OPEN_CHART_SETTINGS_OPERATION = 'lobster.operation.open-chart-settings';

/** Excel's default chart size (5 × 3 inches) and its distance from the charted cells. */
const CHART_SIZE = { width: 480, height: 288 } as const;
const CHART_GAP = 16;

/** A chart floating over the grid, as the drawing model holds it. */
export interface ChartDrawing {
  unitId: string;
  subUnitId: string;
  drawingId: string;
  componentKey?: string;
  data?: SheetChartData;
}

/**
 * The block of data around a cell, as Excel's current region: grown while a neighbouring row or
 * column has content next to it.
 */
export function currentRegion(row: number, column: number, occupied: (row: number, column: number) => boolean, lastRow: number, lastColumn: number): CellRange {
  const range = { startRow: row, endRow: row, startColumn: column, endColumn: column };
  const rowHas = (index: number) => {
    for (let at = Math.max(0, range.startColumn - 1); at <= Math.min(lastColumn, range.endColumn + 1); at++) if (occupied(index, at)) return true;
    return false;
  };
  const columnHas = (index: number) => {
    for (let at = Math.max(0, range.startRow - 1); at <= Math.min(lastRow, range.endRow + 1); at++) if (occupied(at, index)) return true;
    return false;
  };
  for (let grown = true; grown;) {
    grown = false;
    if (range.startRow > 0 && rowHas(range.startRow - 1)) { range.startRow--; grown = true; }
    if (range.endRow < lastRow && rowHas(range.endRow + 1)) { range.endRow++; grown = true; }
    if (range.startColumn > 0 && columnHas(range.startColumn - 1)) { range.startColumn--; grown = true; }
    if (range.endColumn < lastColumn && columnHas(range.endColumn + 1)) { range.endColumn++; grown = true; }
  }
  return range;
}

/**
 * From this many formulas on, a recalculation takes long enough on the grid's thread to be felt
 * (Univer rebuilds the dependencies of every formula each time, about 15 ms per thousand).
 */
const FORMULA_WORKER_THRESHOLD = 2000;

/** How many formula cells a workbook has, counting up to `limit`. */
export function formulaCount(data: IWorkbookData, limit: number): number {
  let count = 0;
  for (const sheet of Object.values(data.sheets)) {
    for (const row of Object.values(sheet.cellData ?? {})) {
      for (const cell of Object.values(row as Record<string, ICellData | null>)) {
        if (cell && (cell.f || cell.si) && ++count >= limit) return count;
      }
    }
  }
  return count;
}

/** Set once a formula worker fails: workbooks opened afterwards calculate on the grid's thread. */
let formulaWorkerFailed = false;

/**
 * Filter criteria Univer has no model for (Excel's date tree, icon sets, …) become the value lists
 * that pass, from the cells' displayed text; the rows stay as the file hides them.
 */
function resolvePendingFilters(univer: Univer, workbook: Workbook, imported: EditorImport): void {
  const service = univer.__getInjector().get(SheetsFilterService);
  for (const [sheetId, filter] of imported.filters) {
    const model = filter.pending?.length ? service.getFilterModel(workbook.getUnitId(), sheetId) : undefined;
    const worksheet = workbook.getSheetBySheetId(sheetId);
    if (!model || !worksheet) continue;
    for (const pending of filter.pending!) {
      const cell = (row: number) => {
        const raw = worksheet.getCellRaw(row, pending.colId);
        return { text: extractPureTextFromCell(worksheet.getCell(row, pending.colId)), serial: typeof raw?.v === 'number' ? raw.v : undefined };
      };
      try {
        model.setCriteria(pending.colId, { colId: pending.colId, filters: pendingFilterValues(pending, filter, cell, workbook.getDateSystem()) });
      } catch (error) {
        console.warn('[SheetEditor] Could not show a filter column\'s criteria:', error);
      }
    }
  }
}

const currentLanguage = (): SheetLanguage => (i18nService.getLanguage() === 'zh' ? 'zh' : 'en');

/** The block a discrete range (rows and columns listed) spans. */
function boundsOf(range: { rows: number[]; cols: number[] }): CellRange | undefined {
  const { rows, cols } = range;
  if (!rows.length || !cols.length) return undefined;
  return {
    startRow: rows.reduce((a, b) => Math.min(a, b)), endRow: rows.reduce((a, b) => Math.max(a, b)),
    startColumn: cols.reduce((a, b) => Math.min(a, b)), endColumn: cols.reduce((a, b) => Math.max(a, b)),
  };
}

/** The name Univer gives a copy of a sheet (getCopyUniqueSheetName in @univerjs/sheets, not exported). */
function copyName(workbook: Workbook, locale: LocaleService, name: string): string {
  let output = `${name} ${locale.t('sheets.tabs.sheetCopy', '')}`;
  for (let count = 2; workbook.checkSheetName(output); count++) output = `${name} ${locale.t('sheets.tabs.sheetCopy', String(count))}`;
  return output;
}
const prefersDark = (): boolean => document.documentElement.classList.contains('dark');

export interface SheetSelection {
  sheet: string;
  range: string;
}

/** One open workbook, in a Univer instance that lives in the session's host element. */
export class SheetEditorSession extends OfficeEditorSession<SheetPackageInfo> {
  univer?: Univer;
  api?: FUniver;
  workbook?: FWorkbook;
  private imported?: EditorImport;
  private sourceBytes?: Uint8Array;
  private readOnly = false;
  private instanceDisposers: IDisposable[] = [];
  private listeners = new Set<() => void>();
  private refusedAt = 0;
  private refusedReason: StructureRefusal = StructureRefusal.Unsupported;
  private structure?: StructureTracker;
  private exporter?: SheetFileClient;
  private formulaWorker?: Worker;
  /** Whether the workbook was edited since it was last loaded. */
  private editedSinceLoad = false;
  private themeObserver?: MutationObserver;

  constructor(file: OfficeOpenResult<SheetPackageInfo>, context: OfficeSessionContext<SheetPackageInfo>) {
    super(file, context, { hostClassName: 'lobster-sheet-surface', autosaveDelayMs: AUTOSAVE_DELAY_MS, logTag: '[SheetDocument]' });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify = (): void => { this.listeners.forEach(listener => listener()); };
  /** Changes whenever the selection, the active sheet or the refused-operation notice changes. */
  private version = 0;
  getVersion = (): number => this.version;
  private bump = (): void => { this.version++; this.notify(); };
  /** When an unsupported operation was last refused, so the view can say why nothing happened. */
  get lastRefusal(): number { return this.refusedAt; }
  get lastRefusalReason(): StructureRefusal { return this.refusedReason; }
  /** Pixel width of a digit in the workbook's default font; Excel column widths count these. */
  get maxDigitWidth(): number { return this.imported?.maxDigitWidth ?? 7; }
  /** The workbook's default font (its Normal style), which cells without a font of their own use. */
  get defaultFont(): { name?: string; size?: number } {
    const style = this.imported?.data.defaultStyle;
    return typeof style === 'object' && style ? { name: style.ff ?? undefined, size: style.fs ?? undefined } : {};
  }
  /** Whether the file has shapes or pictures the grid does not draw (they are kept as they are). */
  get hiddenDrawings(): boolean { return Boolean(this.imported?.hiddenDrawings); }
  /** Whether the file has links the grid does not show (they are kept as they are). */
  get hiddenHyperlinks(): boolean { return Boolean(this.imported?.hiddenHyperlinks); }

  /** The workbook's theme color palette (Excel's "Theme Colors"), for the font and fill colors. */
  get themeColors(): string[][] { return this.imported?.themeColors ?? []; }

  protected disposeEditor(): void {
    this.disposeInstance();
  }

  /** Tears the Univer instance and its workers down, before a reload or with the session. */
  private disposeInstance(): void {
    for (const disposable of this.instanceDisposers.splice(0)) disposable.dispose();
    this.exporter?.dispose();
    this.exporter = undefined;
    this.themeObserver?.disconnect();
    this.univer?.dispose();
    this.formulaWorker?.terminate();
    this.formulaWorker = undefined;
    this.univer = undefined;
    this.api = undefined;
    this.workbook = undefined;
    this.host.replaceChildren();
  }

  /**
   * Formulas of large workbooks calculate in a worker so recalculations never freeze the grid. If
   * the worker fails, a workbook that has not been edited reopens calculating on this thread; an
   * edited one keeps its current results until it is opened again.
   */
  private startFormulaWorker(bytes: Uint8Array): Worker | undefined {
    if (formulaWorkerFailed || typeof Worker === 'undefined') return undefined;
    let worker: Worker;
    try {
      worker = createSheetFormulaWorker();
    } catch (error) {
      formulaWorkerFailed = true;
      console.error('[SheetEditor] Could not start the formula worker; calculating on the main thread:', error);
      return undefined;
    }
    worker.addEventListener('error', event => {
      if (this.formulaWorker !== worker) return;
      formulaWorkerFailed = true;
      console.error('[SheetEditor] Formula worker failed; calculating on the main thread from now on:', event.message || 'the worker did not load');
      if (this.editedSinceLoad) return;
      this.load(bytes).catch(error => console.error('[SheetEditor] Could not reopen the workbook after the formula worker failed:', error));
    });
    this.formulaWorker = worker;
    return worker;
  }

  async load(bytes: Uint8Array): Promise<void> {
    const language = currentLanguage();
    const options: ImportOptions = {
      name: this.document.file.filePath.split(/[\\/]/).pop() ?? 'workbook.xlsx',
      univerLocale: toUniverLocale(language),
      formatLocale: language,
      maxCells: SHEET_MAX_CELLS,
    };
    // The file worker opens and imports the file (and saves it later), so a large workbook does
    // not freeze the app while it opens; this thread loads the fonts and measures the default one.
    const file = createSheetFileClient(bytes, language);
    let imported: EditorImport;
    try {
      const fonts = await file.fonts();
      await prepareOfficeFonts([fonts.name, ...fonts.fonts].filter((font): font is string => Boolean(font)));
      // Column widths count digits of the default font; convert them with the width it really paints at.
      const digitWidth = measureDigitWidth(fonts.name, fonts.size);
      imported = await file.import(digitWidth ? { ...options, digitWidth } : options);
    } catch (error) {
      file.dispose();
      if (error instanceof XlsxImportError) throw new Error(`Workbook cannot be edited: ${error.message}`);
      throw error;
    }
    this.disposeInstance();
    this.exporter = file;
    this.editedSinceLoad = false;
    // Small workbooks recalculate within a frame here, and their results show at once.
    const formulaWorker = formulaCount(imported.data, FORMULA_WORKER_THRESHOLD) >= FORMULA_WORKER_THRESHOLD ? this.startFormulaWorker(bytes) : undefined;
    const { univer, api } = createSheetUniver({ container: this.host, language, darkMode: prefersDark(), formulaWorker });
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, imported.data);
    const created = api.getActiveWorkbook();
    if (created) {
      resolvePendingFilters(univer, created.getWorkbook(), imported);
      file.adopt({ resources: created.save().resources });
      const unregister = registerChartHost(imported.data.id, {
        workbook: created,
        resolve: (reference, origin) => this.resolveChartReference(reference, origin),
        data: drawingId => this.chartDrawing(drawingId)?.data,
        title: drawingId => this.chartTitle(drawingId),
        setTitle: (drawingId, text) => {
          if (this.readOnly) return;
          this.updateChart(drawingId, spec => withChartTitle(spec, text)).catch(error => console.warn('[SheetEditor] The chart title change was refused:', error));
        },
      });
      this.instanceDisposers.push({ dispose: unregister });
    }
    this.structure = new StructureTracker(univer, imported, index => i18nService.t('sheetTableColumnName').replace('{n}', String(index)));
    this.instanceDisposers.push(...this.structure.install(api.getFormula()));
    this.instanceDisposers.push(this.installPasteExpansion(univer, this.structure), this.installFillExpansion(univer, this.structure));
    this.instanceDisposers.push(this.installThisRowDisplay(univer));
    registerWorkbookTables(univer, imported.data.id, imported.tables);
    const tableStyles = this.installTableStyles(univer, imported);
    if (tableStyles) this.instanceDisposers.push(tableStyles);
    if (/Mac/i.test(navigator.platform)) this.instanceDisposers.push(univer.__getInjector().get(IShortcutService).registerShortcut(FORWARD_DELETE_DRAWINGS));
    this.installChartMenu(univer);
    this.instanceDisposers.push(this.installChartCopies(univer));
    // Opening must not take focus from the chat input, but typing into a selected cell must start
    // editing, which Univer skips while auto focus stays disabled.
    univer.__getInjector().get(IContextService).setContextValue(DISABLE_AUTO_FOCUS_KEY, false);
    const workbook = api.getActiveWorkbook();
    if (!workbook) throw new Error('Workbook did not open');
    if (imported.activeSheetId) workbook.setActiveSheet(imported.activeSheetId);
    this.univer = univer;
    this.api = api;
    this.workbook = workbook;
    this.imported = imported;
    this.sourceBytes = bytes;
    this.installListeners(univer, api);
    this.instanceDisposers.push(
      installValidationPrompts(univer, workbook, { alertTitle: i18nService.t('sheetDataValidation') }),
      installExcelShortcuts(univer, api, { language }),
      installPlainTypedCells(univer),
      installAddToChat(univer, workbook, {
        label: i18nService.t('coworkSelectedTextAddToChat'),
        labels: { empty: i18nService.t('sheetChatEmptyCells'), moreRows: i18nService.t('sheetChatMoreRows') },
        available$: this.chatAvailable$,
        isAvailable: () => Boolean(this.chatHandler),
        add: reference => this.chatHandler?.(reference),
      }),
    );
    workbook.setEditable(!this.readOnly);
    this.fitRowsToContent(univer, imported);
    this.bump();
  }

  /**
   * Excel grows rows without a fixed height to fit wrapped or multi-line text when it opens a
   * file. The computed heights are view state: they are neither undoable nor written back.
   */
  private fitRowsToContent(univer: Univer, imported: EditorImport): void {
    const entries = Object.entries(imported.autoFitRows);
    if (!entries.length) return;
    requestAnimationFrame(() => {
      if (this.univer !== univer) return;
      try {
        const controller = univer.__getInjector().get(AutoHeightController);
        const commands = univer.__getInjector().get(ICommandService);
        for (const [sheetId, rows] of entries) {
          const ranges = rows.map(row => ({ startRow: row, endRow: row, startColumn: 0, endColumn: Math.max(0, (imported.data.sheets[sheetId].columnCount ?? 1) - 1) }));
          const { redos } = controller.getUndoRedoParamsOfAutoHeight(ranges, sheetId, undefined, imported.data.id);
          for (const redo of redos) commands.syncExecuteCommand(redo.id, redo.params, { onlyLocal: true });
        }
      } catch (error) {
        console.debug('[SheetEditor] Could not fit rows to their content:', error);
      }
    });
  }

  /** A chart's series reference as the file wrote it, moved through the rows, columns and sheets edited since. */
  private resolveChartReference(reference: string, origin?: number): string {
    const { workbook, imported } = this;
    if (!workbook || !imported) return reference;
    const sheets = workbook.getSheets();
    const ops = this.structure?.ops ?? [];
    // A chart made in the editor wrote its references after `origin` edits.
    if (origin !== undefined) {
      return ops.length > origin ? transformFormula(reference, laterEditsScope(ops, origin, sheets.map(sheet => ({ id: sheet.getSheetId(), name: sheet.getSheetName() })))) : reference;
    }
    const names = new Map(sheets.map(sheet => [sheet.getSheetId(), sheet.getSheetName()]));
    const plan = new StructurePlan(imported, sheets.map(sheet => sheet.getSheetId()), names, ops);
    return plan.referencesMoved ? transformFormula(reference, plan.scope()) : reference;
  }

  /**
   * Excel table styles drawn beneath the cells' own formats: the header, banded rows and columns,
   * first/last column and total row of each styled table, following its moved range. Only drawn.
   */
  private installTableStyles(univer: Univer, imported: EditorImport): IDisposable | undefined {
    const tables = imported.tables.filter(table => table.style && imported.tableStyles.has(table.style.name));
    if (!tables.length) return undefined;
    const defaults = typeof imported.data.defaultStyle === 'object' ? imported.data.defaultStyle : undefined;
    let cache: { edits: number; bySheet: Map<string, DrawnTable[]> } | undefined;
    const drawn = (sheetId: string): DrawnTable[] => {
      const edits = this.structure?.version ?? 0;
      if (cache?.edits !== edits) {
        const ranges = this.structure?.tableRanges();
        const bySheet = new Map<string, DrawnTable[]>();
        for (const table of tables) {
          const style = imported.tableStyles.get(table.style!.name)!;
          const range = ranges ? ranges.get(table.name) : table.range;
          if (!range) continue;
          const list = bySheet.get(table.sheetId) ?? [];
          list.push({ range, headerRow: table.showHeader, totalRow: table.showFooter, options: table.style!, style });
          bySheet.set(table.sheetId, list);
        }
        cache = { edits, bySheet };
      }
      return cache.bySheet.get(sheetId) ?? [];
    };
    return univer.__getInjector().get(SheetInterceptorService).intercept(INTERCEPTOR_POINT.CELL_CONTENT, {
      priority: TABLE_STYLE_PRIORITY,
      effect: InterceptorEffectEnum.Style,
      handler: (cell, location, next) => {
        const { row, col } = location;
        const table = drawn(location.subUnitId).find(item => row >= item.range.startRow && row <= item.range.endRow && col >= item.range.startColumn && col <= item.range.endColumn);
        const style = table && tableCellStyle(table, row, col);
        if (!style) return next(cell);
        const own = cell ? location.workbook.getStyles().getStyleByCell(cell) : undefined;
        return next({ ...cell, s: underCellStyle(style, own, defaults) });
      },
    });
  }

  /** A chart drawing of the workbook by id, from whichever sheet holds it. */
  private chartDrawing(drawingId: string): ChartDrawing | undefined {
    const { univer, workbook } = this;
    if (!univer || !workbook) return undefined;
    const manager = univer.__getInjector().get(IDrawingManagerService);
    for (const sheet of workbook.getSheets()) {
      const drawing = manager.getDrawingByParam({ unitId: workbook.getId(), subUnitId: sheet.getSheetId(), drawingId }) as ChartDrawing | undefined;
      if (drawing) return drawing.componentKey === SHEET_CHART_COMPONENT && drawing.data?.spec ? drawing : undefined;
    }
    return undefined;
  }

  /** Whether the chart settings show while a chart is selected. */
  chartSettingsOpen = false;
  /** Whether Univer's format painter is on (once, or kept on by a double click). */
  formatPainterActive = false;

  showChartSettings(open: boolean): void {
    if (this.chartSettingsOpen === open) return;
    this.chartSettingsOpen = open;
    this.bump();
  }

  /** Where "Add to chat" puts selected cells: the task chat beside the editor, when there is one. */
  private chatHandler: ((reference: SheetSelectionReference) => void) | undefined;
  private readonly chatAvailable$ = new BehaviorSubject(false);

  setChatHandler(handler: ((reference: SheetSelectionReference) => void) | undefined): void {
    this.chatHandler = handler;
    if (this.chatAvailable$.getValue() !== Boolean(handler)) this.chatAvailable$.next(Boolean(handler));
  }

  /** Dragging the fill handle below or beside a table grows it too, as in Excel. */
  private installFillExpansion(univer: Univer, structure: StructureTracker): IDisposable {
    return univer.__getInjector().get(IAutoFillService).addHook({
      id: 'lobster-table-expansion',
      type: AUTO_FILL_HOOK_TYPE.APPEND,
      onFillData: location => {
        const target = boundsOf(location.target);
        const source = boundsOf(location.source);
        const sheet = this.workbook?.getWorkbook().getSheetBySheetId(location.subUnitId);
        if (!target || !source || !sheet) return { redos: [], undos: [] };
        // Filling from empty cells enters nothing.
        let hasValues = false;
        for (let row = source.startRow; row <= source.endRow && !hasValues; row++) {
          for (let column = source.startColumn; column <= source.endColumn && !hasValues; column++) {
            const cell = sheet.getCellRaw(row, column);
            hasValues = Boolean(cell && ((cell.v !== undefined && cell.v !== null && cell.v !== '') || cell.p || cell.f || cell.si));
          }
        }
        return structure.pasteExpansion(location.subUnitId, target, hasValues);
      },
    });
  }

  /**
   * The formula bar and the cell editor show same-row table references as Excel does (`[@Qty]`);
   * what is entered is written out in the long form files keep (see `expandThisRow`).
   */
  private installThisRowDisplay(univer: Univer): IDisposable {
    const remove = univer.__getInjector().get(SheetInterceptorService).writeCellInterceptor.intercept(BEFORE_CELL_EDIT, {
      // Interceptors run in turn and the formula plugin's ends the turn for formula cells with the
      // formula text, so a cell with such references is answered here first, the same way.
      priority: 100,
      handler: (cell, location, next) => {
        const formula = cell?.f;
        if (!formula || !/#this row/i.test(formula)) return next(cell);
        return { ...cell, f: shortenThisRowReferences(formula, this.structure?.tableAt(location.subUnitId, location.row, location.col)) };
      },
    });
    return { dispose: () => { remove(); } };
  }

  /** Pasting right below or beside a table grows it, as typing there does (Excel's AutoExpansion). */
  private installPasteExpansion(univer: Univer, structure: StructureTracker): IDisposable {
    return univer.__getInjector().get(ISheetClipboardService).addClipboardHook({
      id: 'lobster-table-expansion',
      onPasteCells: (_from, to, data) => {
        const range = boundsOf(to.range);
        if (!range) return { redos: [], undos: [] };
        let hasValues = false;
        data.forValue((_row, _column, cell) => {
          hasValues = Boolean(cell && ((cell.v !== undefined && cell.v !== null && cell.v !== '') || cell.p || cell.f));
          return hasValues ? false : undefined;
        });
        return structure.pasteExpansion(to.subUnitId, range, hasValues);
      },
    });
  }

  /**
   * A copied sheet's charts chart the copy's cells, as in Excel. Univer copies drawings as they
   * are; this runs first and hands its drawing plugin the copies with their references moved.
   */
  private installChartCopies(univer: Univer): IDisposable {
    const injector = univer.__getInjector();
    return injector.get(SheetInterceptorService).interceptCommand({
      priority: 100,
      getMutations: info => {
        if (info.id === CopySheetCommand.id) {
          try {
            this.prepareChartCopies(univer, info.params as { unitId?: string; subUnitId?: string; targetSubUnitId?: string; copyContext?: Map<string, unknown> } | undefined);
          } catch (error) {
            console.warn('[SheetEditor] Could not point copied charts at the copy:', error);
          }
        }
        return { redos: [], undos: [] };
      },
    });
  }

  private prepareChartCopies(univer: Univer, params: { unitId?: string; subUnitId?: string; targetSubUnitId?: string; copyContext?: Map<string, unknown> } | undefined): void {
    const { unitId, subUnitId, targetSubUnitId, copyContext } = params ?? {};
    const workbook = this.workbook?.getWorkbook();
    const source = subUnitId ? workbook?.getSheetBySheetId(subUnitId) : undefined;
    if (!unitId || !subUnitId || !targetSubUnitId || !copyContext || !workbook || !source) return;
    const injector = univer.__getInjector();
    const service = injector.get(ISheetDrawingService);
    const data = service.getDrawingData(unitId, subUnitId) ?? {};
    // In stacking order, as the drawing plugin lists them.
    const order = service.getDrawingOrder(unitId, subUnitId) ?? [];
    const drawings = [...order.map(id => data[id]).filter(Boolean), ...Object.values(data).filter(item => !order.includes(item.drawingId))];
    const isChart = (item: object): item is { componentKey: string; data?: Serializable } => (item as { componentKey?: string }).componentKey === SHEET_CHART_COMPONENT;
    if (!drawings.some(isChart)) return;
    const plan = getOrCreateDrawingCopyPlan(copyContext as never, drawings, { unitId, sourceSubUnitId: subUnitId, targetSubUnitId });
    const from = source.getName();
    const to = copyName(workbook, injector.get(LocaleService), from);
    const scope: FormulaScope = {
      homeSheet: from,
      sheet: name => (name.toLowerCase() === from.toLowerCase() ? { name: to, renamed: true, maps: { rows: IDENTITY_ROWS, columns: IDENTITY_COLUMNS } } : undefined),
    };
    for (const drawing of plan.drawings) {
      const chart = isChart(drawing) ? drawing.data as unknown as SheetChartData | undefined : undefined;
      if (!isChart(drawing) || !chart?.spec) continue;
      // References as they stand now, then onto the copy; later edits move them from here.
      const current = mapChartReferences(chart.spec, reference => this.resolveChartReference(reference, chart.origin?.edits));
      const copied: SheetChartData = { ...chart, spec: mapChartReferences(current, reference => transformFormula(reference, scope)), origin: { edits: this.structure?.ops.length ?? 0 } };
      drawing.data = copied as unknown as Serializable;
    }
  }

  /**
   * The menu beside a selected chart. Univer's picture menu offers cropping, flipping and resizing,
   * which a chart has not; it gets its settings and delete instead, like Excel's chart buttons.
   */
  private installChartMenu(univer: Univer): void {
    const injector = univer.__getInjector();
    this.instanceDisposers.push(injector.get(ICommandService).registerCommand({
      id: OPEN_CHART_SETTINGS_OPERATION, type: CommandType.OPERATION,
      handler: () => { this.showChartSettings(true); return true; },
    }));
    // Charts are the editor's only floating DOM drawings. Univer translates keys it knows and shows other labels as they are.
    injector.get(SheetCanvasPopManagerService).registerFeatureMenu(DrawingTypeEnum.DRAWING_DOM, (unitId, subUnitId, drawingId) => [
      { label: i18nService.t('sheetChartSettings'), index: 0, commandId: OPEN_CHART_SETTINGS_OPERATION, commandParams: {}, disable: this.readOnly },
      {
        label: 'sheets-drawing-ui.image-popup.delete', index: 1, commandId: RemoveSheetDrawingCommand.id,
        commandParams: { unitId, drawings: [{ unitId, subUnitId, drawingId }] }, disable: this.readOnly,
      },
    ]);
  }

  /** The chart selected over the grid, when exactly one chart is. */
  focusedChart(): ChartDrawing | undefined {
    const focus = this.univer?.__getInjector().get(IDrawingManagerService).getFocusDrawings() ?? [];
    return focus.length === 1 ? this.chartDrawing(focus[0].drawingId) : undefined;
  }

  /**
   * Insert a chart of the selected cells (the block of data around the active cell when one cell
   * is selected) to the right of them, as Excel does. False when the cells hold no numbers.
   */
  insertChart(kind: ChartKind): boolean {
    const { univer, workbook, imported } = this;
    if (!univer || !workbook || !imported || this.readOnly) return false;
    const sheet = workbook.getActiveSheet();
    const model = sheet.getSheet();
    const active = workbook.getActiveRange();
    if (!active) return false;
    const selected = { startRow: active.getRow(), endRow: active.getLastRow(), startColumn: active.getColumn(), endColumn: active.getLastColumn() };
    const occupied = (row: number, column: number) => {
      const value = model.getCellRaw(row, column)?.v;
      return value !== undefined && value !== null && value !== '';
    };
    const range = selected.startRow === selected.endRow && selected.startColumn === selected.endColumn
      ? currentRegion(selected.startRow, selected.startColumn, occupied, model.getLastRowWithContent(), model.getLastColumnWithContent())
      : selected;
    const spec = chartFromRange(kind, sheet.getSheetName(), range, (row, column) => ({
      value: model.getCellRaw(row, column)?.v ?? null,
      text: extractPureTextFromCell(model.getCell(row, column)),
    }));
    if (!spec) {
      this.refuse(StructureRefusal.ChartData);
      return false;
    }
    spec.palette = [...imported.palette];
    // To the right of the cells, top-aligned with them, at Excel's default size.
    const size = (count: number, length: (index: number) => number, start: number, offset: number, extent: number) => {
      let index = start;
      let remaining = extent + offset;
      while (remaining >= length(index) && index < count - 1) remaining -= length(index++);
      return { index, offset: remaining };
    };
    const width = (column: number) => model.getColumnWidth(column);
    const height = (row: number) => model.getRowHeight(row);
    const fromColumn = range.endColumn + 1;
    const end = {
      column: size(model.getMaxColumns(), width, fromColumn, CHART_GAP, CHART_SIZE.width),
      row: size(model.getMaxRows(), height, range.startRow, 0, CHART_SIZE.height),
    };
    const sheetTransform = {
      from: { column: fromColumn, columnOffset: CHART_GAP, row: range.startRow, rowOffset: 0 },
      to: { column: end.column.index, columnOffset: end.column.offset, row: end.row.index, rowOffset: end.row.offset },
    };
    const unitId = workbook.getId();
    // Where the grid draws those cells (headers and hidden rows included).
    const skeleton = univer.__getInjector().get(SheetSkeletonService).getSkeletonParam(unitId, sheet.getSheetId());
    const transform = drawingPositionToTransform(sheetTransform, skeleton);
    if (!transform) return false;
    const data: SheetChartData = { spec, origin: { edits: this.structure?.ops.length ?? 0 } };
    const drawing = {
      unitId, subUnitId: sheet.getSheetId(), drawingId: `lobster-chart-new-${Math.random().toString(36).slice(2, 10)}`,
      drawingType: DrawingTypeEnum.DRAWING_DOM, componentKey: SHEET_CHART_COMPONENT, allowTransform: true,
      // The description is plain JSON.
      data: data as unknown as Serializable,
      sheetTransform, axisAlignSheetTransform: sheetTransform, transform,
    };
    univer.__getInjector().get(ICommandService).executeCommand(InsertSheetDrawingCommand.id, { unitId, drawings: [drawing] })
      // Selected, as Excel leaves a new chart, so its settings are at hand.
      .then(inserted => { if (inserted) this.selectDrawing(univer, { unitId, subUnitId: drawing.subUnitId, drawingId: drawing.drawingId }); })
      .catch(error => console.warn('[SheetEditor] Could not insert a chart:', error));
    return true;
  }

  /** Selects a drawing as clicking it would, once the grid has drawn it. */
  private selectDrawing(univer: Univer, search: { unitId: string; subUnitId: string; drawingId: string }, frames = 30): void {
    if (this.univer !== univer) return;
    const injector = univer.__getInjector();
    const scene = injector.get(IRenderManagerService).getRenderUnitById(search.unitId)?.scene;
    const shape = scene?.getObject(getDrawingShapeKeyByDrawingSearch(search));
    if (!scene || !shape) {
      if (frames > 0) requestAnimationFrame(() => this.selectDrawing(univer, search, frames - 1));
      return;
    }
    scene.getTransformerByCreate().setSelectedControl(shape);
    injector.get(ICommandService).syncExecuteCommand(SetDrawingSelectedOperation.id, [search]);
  }

  /** What a chart's series are called, as the cells behind their names show it. */
  chartSeriesNames(drawingId: string): string[] {
    const drawing = this.chartDrawing(drawingId);
    const host = this.imported ? chartHost(this.imported.data.id) : undefined;
    if (!drawing?.data?.spec || !host) return [];
    return chartSeriesList(drawing.data.spec).map((series, index) => readChartData(host, series.name, drawing.data!.origin?.edits).text.filter(Boolean).join(' ')
      || i18nService.t('sheetChartSeries').replace('{n}', String(index + 1)));
  }

  /** A chart's title as it shows, when it has text or a cell of its own (not the placeholder). */
  chartTitle(drawingId: string): string | undefined {
    const drawing = this.chartDrawing(drawingId);
    const title = drawing?.data?.spec.title;
    const host = this.imported ? chartHost(this.imported.data.id) : undefined;
    if (!title || !host || (title.ref === undefined && title.text === undefined)) return undefined;
    return title.ref ? readChartData(host, { ref: title.ref, cache: [title.text ?? ''] }, drawing.data!.origin?.edits).text.join(' ') : title.text;
  }

  /** The cells a chart reads, as Excel's Select Data shows them (`A1:D7`, sheet-qualified when on another sheet). */
  chartDataRange(drawingId: string): string | undefined {
    const drawing = this.chartDrawing(drawingId);
    const spec = drawing?.data?.spec;
    const sheet = drawing && this.workbook?.getWorkbook().getSheetBySheetId(drawing.subUnitId);
    if (!spec || !sheet || spec.plots.length !== 1) return undefined;
    const source = chartSourceRange(spec, reference => this.resolveChartReference(reference, drawing.data!.origin?.edits));
    if (!source) return undefined;
    const text = rangeReference(source.range);
    return source.sheet.toLowerCase() === sheet.getName().toLowerCase() ? text : `${formulaSheetName(source.sheet)}!${text}`;
  }

  /**
   * Chart other cells, as Excel's Select Data does: the series are read again from the block the
   * way inserting a chart reads it, the chart's settings stay. False when the text names no block
   * of cells with numbers.
   */
  setChartDataRange(drawingId: string, text: string): boolean {
    const drawing = this.chartDrawing(drawingId);
    const spec = drawing?.data?.spec;
    const kind = spec && chartKind(spec);
    const workbook = this.workbook?.getWorkbook();
    if (!drawing || !spec || !kind || spec.plots.length !== 1 || !workbook || !this.api || this.readOnly) return false;
    const trimmed = text.trim().replace(/^=/, '');
    const bang = trimmed.lastIndexOf('!');
    const name = bang >= 0 ? trimmed.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, '\'') : undefined;
    const sheet = name !== undefined ? workbook.getSheetBySheetName(name) : workbook.getSheetBySheetId(drawing.subUnitId);
    const range = parseRangeReference(bang >= 0 ? trimmed.slice(bang + 1) : trimmed);
    if (!sheet || !range) return false;
    const fresh = chartFromRange(kind, sheet.getName(), range, (row, column) => ({ value: sheet.getCellRaw(row, column)?.v ?? null, text: extractPureTextFromCell(sheet.getCell(row, column)) }));
    if (!fresh) {
      this.refuse(StructureRefusal.ChartData);
      return false;
    }
    // The chart's other references as they stand now, since the new ones are written now.
    const current = mapChartReferences(spec, reference => this.resolveChartReference(reference, drawing.data!.origin?.edits));
    const data: SheetChartData = { ...drawing.data!, spec: withChartData(current, fresh), origin: { edits: this.structure?.ops.length ?? 0 } };
    this.api.executeCommand(SetSheetDrawingCommand.id, { unitId: drawing.unitId, drawings: [{ unitId: drawing.unitId, subUnitId: drawing.subUnitId, drawingId, data }] })
      .catch(error => console.warn('[SheetEditor] The chart data change was refused:', error));
    return true;
  }

  /** Change a chart's description (type, title, legend …) as one undoable step. */
  async updateChart(drawingId: string, change: (spec: ChartSpec) => ChartSpec): Promise<void> {
    const drawing = this.chartDrawing(drawingId);
    if (!drawing?.data?.spec || !this.api || this.readOnly) return;
    const data: SheetChartData = { ...drawing.data, spec: change(drawing.data.spec) };
    await this.api.executeCommand(SetSheetDrawingCommand.id, { unitId: drawing.unitId, drawings: [{ unitId: drawing.unitId, subUnitId: drawing.subUnitId, drawingId, data }] });
  }

  /**
   * Formulas typed or pasted with Excel's `[@Column]` shorthand get the long form the formula
   * engine and files use; an unqualified reference takes the table its cell is in.
   */
  private expandThisRow(params: SetRangeValuesParams | undefined): void {
    const value = params?.value;
    const sheetId = params?.subUnitId ?? this.workbook?.getActiveSheet().getSheetId();
    const start = params?.range;
    if (!value || typeof value !== 'object' || !sheetId) return;
    const expand = (cell: ICellData | null | undefined, row: number, column: number) => {
      if (!cell) return;
      const tableAt = () => this.structure?.tableAt(sheetId, row, column);
      if (typeof cell.f === 'string') cell.f = expandThisRowReferences(cell.f, tableAt);
      else if (typeof cell.v === 'string' && cell.v.startsWith('=')) cell.v = expandThisRowReferences(cell.v, tableAt);
    };
    const origin = { row: start?.startRow ?? 0, column: start?.startColumn ?? 0 };
    if ('f' in value || 'v' in value) {
      expand(value as ICellData, origin.row, origin.column);
      return;
    }
    // A matrix of cells: rows of arrays, or sparse rows keyed by index (absolute, as Univer passes them).
    const rows = Array.isArray(value) ? value.map((row, index) => [origin.row + index, row] as const) : Object.entries(value).map(([row, cells]) => [Number(row), cells] as const);
    for (const [row, cells] of rows) {
      if (!cells || typeof cells !== 'object') continue;
      const entries = Array.isArray(cells) ? cells.map((cell, index) => [origin.column + index, cell] as const) : Object.entries(cells).map(([column, cell]) => [Number(column), cell] as const);
      for (const [column, cell] of entries) expand(cell as ICellData | null, row, column);
    }
  }

  private refuse(reason: StructureRefusal): void {
    this.refusedAt = Date.now();
    this.refusedReason = reason;
    this.bump();
  }

  private installListeners(univer: Univer, api: FUniver): void {
    const commands = univer.__getInjector().get(ICommandService);
    const editorTextColor = univer.__getInjector().get(ThemeService).getColorFromTheme('gray.900');
    this.instanceDisposers.push(commands.beforeCommandExecuted(command => {
      if (command.type === CommandType.OPERATION && UNSUPPORTED_IMAGE_EDIT.test(command.id)) {
        this.refuse(StructureRefusal.ImageEdit);
        throw new CustomCommandExecutionError(`LobsterAI cannot save "${command.id}" to the .xlsx file yet`);
      }
      if (command.type !== CommandType.COMMAND) return;
      if (command.id === SetRangeValuesCommand.id) {
        dropEditorTextColor(command.params, editorTextColor);
        this.expandThisRow(command.params as SetRangeValuesParams | undefined);
      }
      const reason = this.structure?.refusalFor(command);
      if (reason) {
        this.refuse(reason);
        throw new CustomCommandExecutionError(`LobsterAI cannot save "${command.id}" to the .xlsx file (${reason})`);
      }
    }));
    this.instanceDisposers.push(commands.onCommandExecuted((command, options) => {
      if (command.type !== CommandType.MUTATION || !EDIT_MUTATION.test(command.id)) return;
      const flags = options as { applyFormulaCalculationResult?: boolean; onlyLocal?: boolean } | undefined;
      // Local-only mutations recompute what is shown (formula results, rule caches, row heights);
      // user edits, undo and redo never carry the flag.
      if (flags?.applyFormulaCalculationResult || flags?.onlyLocal || VIEW_MUTATIONS.has(command.id)) return;
      this.editedSinceLoad = true;
      this.document.changed();
    }));
    // Selections made in code (an agent revealing its edit) update the toolbar too.
    const selections = univer.__getInjector().get(SheetsSelectionsService).selectionChanged$.subscribe(() => this.bump());
    // The toolbar shows chart settings while a chart is selected.
    const drawings = univer.__getInjector().get(IDrawingManagerService);
    const focus = drawings.focus$.subscribe(() => this.bump());
    const updates = drawings.update$.subscribe(() => this.bump());
    // The format painter button shows while the painter is on.
    const painter = univer.__getInjector().get(IFormatPainterService).status$.subscribe(status => {
      this.formatPainterActive = status !== FormatPainterStatus.OFF;
      this.bump();
    });
    this.instanceDisposers.push({ dispose: () => { selections.unsubscribe(); focus.unsubscribe(); updates.unsubscribe(); painter.unsubscribe(); } });
    this.themeObserver = new MutationObserver(() => {
      if (api.isDarkMode() !== prefersDark()) api.toggleDarkMode(prefersDark());
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  /**
   * Resolve once the latest formula calculation has been applied. An edit schedules its
   * recalculation asynchronously; the engine's own wait also covers one that has not started yet.
   */
  async waitForCalculation(): Promise<void> {
    try {
      await this.structure?.settled();
      await this.api?.getFormula().onCalculationResultApplied(CALCULATION_WAIT_MS);
    } catch (error) {
      console.warn('[SheetEditor] Formula calculation did not finish in time; saving current results:', error);
    }
  }

  async save(): Promise<Uint8Array> {
    // Let the edit's dependents recalculate so their results are saved with it.
    await this.waitForCalculation();
    const workbook = this.workbook;
    if (!workbook || !this.imported || !this.sourceBytes || !this.exporter) throw new Error('Workbook is not ready');
    try {
      const resources = this.univer?.__getInjector().get(IResourceManagerService);
      const snapshots = {
        // Univer's own save deep-copies the model; posting to the export worker copies it anyway.
        live: () => ({ ...workbook.getWorkbook().getSnapshot(), resources: resources?.getResources(workbook.getId(), UniverInstanceType.UNIVER_SHEET) ?? [] }),
        copy: () => workbook.save(),
        revision: () => this.document.currentRevision,
      };
      return await this.exporter.export(snapshots, {
        structure: [...(this.structure?.ops ?? [])], tables: this.structure?.grownTables(), activeSheetId: workbook.getActiveSheet().getSheetId(),
      });
    } catch (error) {
      if (error instanceof XlsxExportError) throw new OfficeExportRefusal(error.issue, error.message);
      throw error;
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.workbook?.setEditable(!readOnly);
  }

  /** Run an agent call as ONE undo step: everything it changes is undone together. */
  async asUndoGroup<T>(operation: () => Promise<T>): Promise<T> {
    const univer = this.univer;
    const unitId = this.workbook?.getId();
    if (!univer || !unitId) throw new Error('Workbook is not ready');
    const group = univer.__getInjector().get(IUndoRedoService).beginUndoRedoGroup(unitId, `lobster-agent-${Date.now()}`, 'append');
    try {
      return await operation();
    } finally {
      group.dispose();
    }
  }

  /** Revert the last undo step, e.g. an agent call that failed halfway. */
  async undoLast(): Promise<void> {
    await this.api?.undo();
  }

  selection(): SheetSelection | undefined {
    const workbook = this.workbook;
    const range = workbook?.getActiveRange();
    if (!workbook || !range) return undefined;
    const bounds = range.getRange();
    return { sheet: workbook.getActiveSheet().getSheetName(), range: rangeReference(bounds) };
  }

  /** Bring an edited range into view. */
  reveal(sheetName: string, range: CellRange): void {
    try {
      const sheet = this.workbook?.getSheetByName(sheetName);
      if (!sheet) return;
      this.workbook!.setActiveSheet(sheet);
      sheet.getRange(range.startRow, range.startColumn, range.endRow - range.startRow + 1, range.endColumn - range.startColumn + 1).activate();
    } catch (error) {
      console.debug('[SheetEditor] Could not reveal the edited range:', error);
    }
  }
}

const registry = createOfficeEditorRegistry<SheetPackageInfo, SheetEditorSession>({
  bridge: () => window.electron.artifact.office.sheet,
  create: (file, context) => new SheetEditorSession(file, context),
  maxCachedSessions: 3,
  logTag: '[SheetEditor]',
  hot: import.meta.hot,
  hotKey: 'sheetEditorRegistry',
});

export const acquireSheetEditor = registry.acquire;
/** Route refreshes through the live session instead of replacing its Redux artifact bytes. */
export const refreshOpenSheetEditor = registry.refresh;
