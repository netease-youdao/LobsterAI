import {
  CellValueType, CommandType, DataValidationType, DrawingTypeEnum, extractPureTextFromCell, type ICellData, type ICommandInfo, ICommandService, type IDisposable,
  type IMutationInfo, IUniverInstanceService, type IWorksheetData, type Nullable, type Univer, type Workbook, type Worksheet,
} from '@univerjs/core';
import { AddDataValidationMutation, RemoveDataValidationMutation, UpdateDataValidationMutation, UpdateRuleType } from '@univerjs/data-validation';
import type { FFormula } from '@univerjs/engine-formula/facade';
import {
  CopySheetCommand, getVisibleRanges, InsertColByRangeCommand, InsertColCommand, InsertColMutation, InsertRowByRangeCommand, InsertRowCommand,
  InsertRowMutation, InsertSheetCommand, InsertSheetMutation, RemoveColByRangeCommand, RemoveColCommand, RemoveColMutation,
  RemoveRowByRangeCommand, RemoveRowCommand, RemoveRowMutation, RemoveSheetCommand, SetRangeValuesCommand, SetRangeValuesMutation, SetWorksheetNameCommand,
  SetWorksheetOrderCommand, SheetInterceptorService,
} from '@univerjs/sheets';
import {
  ConditionalFormattingRuleModel, DeleteConditionalRuleMutation, DeleteConditionalRuleMutationUndoFactory, SetConditionalRuleMutation,
  setConditionalRuleMutationUndoFactory,
} from '@univerjs/sheets-conditional-formatting';
import { SheetDataValidationModel } from '@univerjs/sheets-data-validation';

import type { CellRange } from './sheetAddress';
import { SHEET_CHART_COMPONENT } from './sheetChartHost';
import { BLOCKED_SHEET_COMMAND } from './sheetCommandPolicy';
import type { EditorImport } from './sheetEditorImport';
import {
  type FormulaScope, IDENTITY_COLUMNS, IDENTITY_ROWS, offsetFormula, type SheetFate, sheetMaps, StructureAction, StructureAxis, type StructureOp,
} from './sheetStructure';
import {
  currentTableRanges, hasAttachments, refuseRowsOrColumns, StructureRefusal, type TableExtent, type WorkbookStructureInfo,
} from './sheetStructureSupport';
import { registerWorkbookTable } from './sheetUniverEngine';
import { moveConditionalFormat, stable } from './xlsxConditionalFormatExport';
import { moveDataValidation } from './xlsxDataValidationExport';
import { isSavableImageSource } from './xlsxDrawings';

/** Records row and column edits in Univer's undo stack, so undo and redo keep the log in step. */
export const SET_STRUCTURE_OPS_MUTATION = 'lobster.mutation.set-structure-ops';
/** Records tables grown by typing next to them, in the undo stack like the log. */
export const SET_TABLE_EXTENTS_MUTATION = 'lobster.mutation.set-table-extents';

const INSERT_ROWS = { axis: StructureAxis.Rows, action: StructureAction.Insert };
const REMOVE_ROWS = { axis: StructureAxis.Rows, action: StructureAction.Remove };
const INSERT_COLUMNS = { axis: StructureAxis.Columns, action: StructureAction.Insert };
const REMOVE_COLUMNS = { axis: StructureAxis.Columns, action: StructureAction.Remove };
/** The ids the by-range commands report to interceptors. */
const INTERCEPTED_COMMANDS: Record<string, { axis: StructureAxis; action: StructureAction }> = {
  [InsertRowCommand.id]: INSERT_ROWS, [RemoveRowCommand.id]: REMOVE_ROWS, [InsertColCommand.id]: INSERT_COLUMNS, [RemoveColCommand.id]: REMOVE_COLUMNS,
};
/** The commands that always run, whether the menus, the facade or the agent started the edit. */
const GUARDED_COMMANDS: Record<string, { axis: StructureAxis; action: StructureAction }> = {
  [InsertRowByRangeCommand.id]: INSERT_ROWS, [RemoveRowByRangeCommand.id]: REMOVE_ROWS,
  [InsertColByRangeCommand.id]: INSERT_COLUMNS, [RemoveColByRangeCommand.id]: REMOVE_COLUMNS,
};

/** Picture operations the writer does not carry yet (moving, resizing and deleting it does). */
export const UNSUPPORTED_IMAGE_EDIT = /^sheet\.(?:command\.(?:insert-(?:sheet|float|cell)-image|(?:un)?group-sheet-image|(?:add|set|delete)-worksheet-background-image|set-drawing-arrange|toggle-flip-drawings|save-cell-images)|operation\.open-image-crop)$/;

/** Univer's command for adding drawings, pictures and floating charts alike (from @univerjs/sheets-drawing). */
const INSERT_DRAWINGS_COMMAND = 'sheet.command.insert-sheet-image';

/** Univer's command for a picture floating over the cells (from a file picker or pasted files). */
const INSERT_PICTURE_COMMAND = 'sheet.command.insert-float-image';

/** Why drawings cannot be added: only charts and embedded PNG, JPEG, GIF or BMP pictures are saved. */
function insertRefusal(params: unknown): StructureRefusal | undefined {
  const drawings = (params as { drawings?: { componentKey?: string; data?: { spec?: unknown }; drawingType?: number; source?: unknown }[] } | undefined)?.drawings ?? [];
  if (!drawings.length) return StructureRefusal.ImageEdit;
  for (const drawing of drawings) {
    if (drawing.componentKey === SHEET_CHART_COMPONENT && drawing.data?.spec) continue;
    if (drawing.drawingType !== DrawingTypeEnum.DRAWING_IMAGE || drawing.componentKey) return StructureRefusal.ImageEdit;
    if (!isSavableImageSource(drawing.source)) return StructureRefusal.ImageFormat;
  }
  return undefined;
}

/** The sort command every sort menu item runs (from @univerjs/sheets-sort). */
const SORT_RANGE_COMMAND = 'sheet.command.sort-range';

/** Row and column edits as they run, including through undo and redo. */
const STRUCTURE_MUTATIONS = new Set<string>([InsertRowMutation.id, RemoveRowMutation.id, InsertColMutation.id, RemoveColMutation.id]);
const CALCULATION_WAIT_MS = 10_000;

/** Univer's own defaults for a new sheet (DEFAULT_WORKSHEET_ROW_HEIGHT / _COLUMN_WIDTH). */
const UNIVER_DEFAULT_ROW_HEIGHT = 24;
const UNIVER_DEFAULT_COLUMN_WIDTH = 88;

interface StructureCommandParams {
  unitId?: string;
  subUnitId?: string;
  range?: { startRow: number; endRow: number; startColumn: number; endColumn: number };
  /** The new name of a renamed sheet. */
  name?: string;
}

const IDENTITY = { rows: IDENTITY_ROWS, columns: IDENTITY_COLUMNS };

/** A table header cell's text. */
function headerText(worksheet: Worksheet, row: number, column: number): string {
  const cell: Nullable<ICellData> = worksheet.getCellRaw(row, column);
  return cell ? extractPureTextFromCell(cell).trim() : '';
}
/** Validation types whose ranges Univer moves itself (and drops when all their cells go). */
const UNIVER_MOVED_VALIDATIONS = new Set<string>([DataValidationType.LIST, DataValidationType.LIST_MULTIPLE, DataValidationType.CHECKBOX, DataValidationType.ANY]);

/**
 * Row and column edits enter a log that export replays on every reference in the file. The log
 * rides in Univer's undo stack: each edit adds a mutation that sets the log after it, and undo
 * restores the log before it, so undoing a deletion brings references back intact. The tracker
 * also decides which structural commands this workbook can carry into its file.
 */
export class StructureTracker {
  private log: StructureOp[] = [];
  private extents = new Map<string, TableExtent>();
  /** Tables an entry being typed next to would grow, noted before the values land. */
  private expansion?: { sheetId: string; ranges: Map<string, CellRange> };
  private changes = 0;
  private edits = 0;
  private recalculation?: Promise<void>;
  readonly info: WorkbookStructureInfo;

  /**
   * @param columnName the name of the nth new table column (`Column1`), for columns inserted
   * inside a table, as Excel names them in its language.
   */
  constructor(private readonly univer: Univer, private readonly imported: EditorImport, private readonly columnName: (index: number) => string = index => `Column${index}`) {
    this.info = imported.structure;
  }

  /** Row and column insertions and deletions since the workbook was loaded, oldest first. */
  get ops(): readonly StructureOp[] {
    return this.log;
  }

  /** Changes whenever the log or a table's extent changes (with undo and redo too). */
  get version(): number {
    return this.changes;
  }

  /**
   * Register the log mutation and the command interceptor; call once the workbook exists (plugins
   * start with it). With the formula facade, row and column edits end in a full recalculation.
   */
  install(formula?: FFormula): IDisposable[] {
    const injector = this.univer.__getInjector();
    const commands = injector.get(ICommandService);
    // A sheet added here gets the workbook's row height and column width, as Excel gives a new
    // sheet the defaults of the workbook's Normal style, instead of Univer's own.
    const first = this.imported.data.sheets[this.imported.data.sheetOrder[0]];
    let inserting = false;
    return [
      commands.beforeCommandExecuted(info => {
        if (info.id === InsertRowByRangeCommand.id || info.id === InsertColByRangeCommand.id) this.copyOwnStyles(info);
        if (info.id === SetRangeValuesCommand.id) this.expansion = this.expansionFor(info.params as StructureCommandParams | undefined);
        if (info.id === InsertSheetCommand.id) inserting = true;
        if (!inserting || info.id !== InsertSheetMutation.id) return;
        const sheet = (info.params as { sheet?: Partial<IWorksheetData> } | undefined)?.sheet;
        if (!sheet || !first) return;
        if (sheet.defaultRowHeight === UNIVER_DEFAULT_ROW_HEIGHT && first.defaultRowHeight) sheet.defaultRowHeight = first.defaultRowHeight;
        if (sheet.defaultColumnWidth === UNIVER_DEFAULT_COLUMN_WIDTH && first.defaultColumnWidth) sheet.defaultColumnWidth = first.defaultColumnWidth;
      }),
      commands.onCommandExecuted(info => {
        if (info.id === InsertSheetCommand.id) inserting = false;
        if (formula && STRUCTURE_MUTATIONS.has(info.id)) this.recalculateAfterEdits(formula);
      }),
      commands.registerCommand({
        id: SET_STRUCTURE_OPS_MUTATION,
        type: CommandType.MUTATION,
        handler: (_accessor, params?: { ops?: StructureOp[] }) => {
          this.log = params?.ops ? [...params.ops] : [];
          this.changes++;
          this.syncTables();
          return true;
        },
      }),
      commands.registerCommand({
        id: SET_TABLE_EXTENTS_MUTATION,
        type: CommandType.MUTATION,
        handler: (_accessor, params?: { extents?: [string, TableExtent][] }) => {
          this.extents = new Map(params?.extents ?? []);
          this.changes++;
          this.syncTables();
          return true;
        },
      }),
      injector.get(SheetInterceptorService).interceptCommand({
        // Last, so rule updates here win over what Univer's own reference tracking computed.
        priority: -100,
        getMutations: info => {
          if (info.id === SetRangeValuesCommand.id) return this.expansionMutations(info.params as { subUnitId?: string; cellValue?: Record<number, Record<number, Nullable<ICellData>>> });
          const kind = INTERCEPTED_COMMANDS[info.id];
          const added = kind ? this.opsFor(kind, info.params as StructureCommandParams | undefined) : [];
          const rules = this.ruleMutations(info, added);
          if (!added.length) return rules;
          // New table columns are named before the tables are synced; removing the column undoes it.
          const headers = kind === INSERT_COLUMNS ? this.tableHeaderMutation(added[0]) : undefined;
          return {
            redos: [...(headers ? [headers] : []), { id: SET_STRUCTURE_OPS_MUTATION, params: { ops: [...this.log, ...added] } }, ...rules.redos],
            undos: [{ id: SET_STRUCTURE_OPS_MUTATION, params: { ops: [...this.log] } }, ...rules.undos],
          };
        },
      }),
    ];
  }

  /**
   * New rows and columns take the formatting of the row above or the column to the left, as in
   * Excel. Univer copies what those cells show, conditional formats included, which would turn a
   * rule's highlight into real formatting; the new cells get the source cells' own styles instead.
   */
  private copyOwnStyles(info: ICommandInfo): void {
    const params = info.params as (StructureCommandParams & { cellValue?: Record<number, Record<number, ICellData>> }) | undefined;
    const range = params?.range;
    const copied = params?.cellValue;
    const sheetId = this.sheetIdOf(params);
    const worksheet = sheetId ? this.workbook()?.getSheetBySheetId(sheetId) : undefined;
    if (!range || !copied || !worksheet) return;
    // Only a copied format is replaced; cell contents passed for new rows stay as they are.
    if (Object.values(copied).some(row => Object.values(row ?? {}).some(cell => Object.keys(cell ?? {}).some(key => key !== 's')))) return;
    const rows = info.id === InsertRowByRangeCommand.id;
    const source = (rows ? range.startRow : range.startColumn) - 1;
    const cellValue: Record<number, Record<number, ICellData>> = {};
    const add = (row: number, column: number, style: ICellData['s']) => {
      if (!style || (typeof style === 'object' && !Object.keys(style).length)) return;
      (cellValue[row] ??= {})[column] = { s: style };
    };
    const cells = worksheet.getCellMatrix();
    if (source >= 0 && rows) {
      for (const [key, cell] of Object.entries(cells.getRow(source) ?? {})) {
        const column = Number(key);
        if (column < range.startColumn || column > range.endColumn) continue;
        for (let row = range.startRow; row <= range.endRow; row++) add(row, column, cell?.s);
      }
    } else if (source >= 0) {
      cells.forRow(row => {
        if (row < range.startRow || row > range.endRow) return;
        const style = cells.getValue(row, source)?.s;
        for (let column = range.startColumn; column <= range.endColumn; column++) add(row, column, style);
      });
    }
    params.cellValue = cellValue;
  }

  /** Resolves once formula results are current after the latest row or column edit. */
  async settled(): Promise<void> {
    while (this.recalculation) await this.recalculation;
  }

  /**
   * After consecutive row and column edits Univer can leave formulas that reach the edited sheet
   * from another sheet at stale results (they show 0). A full recalculation repairs them, but only
   * once the edits' own calculations have finished; one requested earlier merges into them.
   */
  private recalculateAfterEdits(formula: FFormula): void {
    this.edits++;
    if (this.recalculation) return;
    const applied = () => formula.onCalculationResultApplied(CALCULATION_WAIT_MS).catch(() => undefined);
    this.recalculation = (async () => {
      let seen = -1;
      while (seen !== this.edits) {
        do {
          seen = this.edits;
          await new Promise(resolve => setTimeout(resolve, 0));
          await applied();
        } while (seen !== this.edits);
        formula.executeCalculation();
        await applied();
      }
    })().finally(() => { this.recalculation = undefined; });
  }

  private workbook(): Workbook | undefined {
    return this.univer.__getInjector().get(IUniverInstanceService).getUnit<Workbook>(this.imported.data.id) ?? undefined;
  }

  private sheetIdOf(params: { subUnitId?: string } | undefined): string | undefined {
    return params?.subUnitId ?? this.workbook()?.getActiveSheet()?.getSheetId();
  }

  /** The log entries one row or column command produces, in the order its mutations run. */
  private opsFor(kind: { axis: StructureAxis; action: StructureAction }, params: StructureCommandParams | undefined): StructureOp[] {
    const range = params?.range;
    const sheetId = this.sheetIdOf(params);
    if (!range || !sheetId) return [];
    if (kind.axis === StructureAxis.Columns) {
      return [{ sheetId, ...kind, index: range.startColumn, count: range.endColumn - range.startColumn + 1 }];
    }
    if (kind.action === StructureAction.Insert) return [{ sheetId, ...kind, index: range.startRow, count: range.endRow - range.startRow + 1 }];
    // Rows hidden by a filter stay; the command removes the visible runs from the bottom up.
    const visible = getVisibleRanges([range], this.univer.__getInjector(), params?.unitId ?? this.imported.data.id, sheetId).reverse();
    return visible.map(run => ({ sheetId, ...kind, index: run.startRow, count: run.endRow - run.startRow + 1 }));
  }

  /**
   * Conditional formats follow row, column and sheet edits the way Excel moves them: ranges grow
   * and shrink, formulas keep their anchor and their references follow, references to a deleted
   * sheet become #REF!. (Univer's own tracking of rule references is off for these edits.)
   */
  private ruleMutations(info: ICommandInfo, added: StructureOp[]): { redos: IMutationInfo[]; undos: IMutationInfo[] } {
    const none = { redos: [], undos: [] };
    const workbook = this.workbook();
    const params = info.params as StructureCommandParams | undefined;
    const sheetId = this.sheetIdOf(params);
    const sheet = sheetId ? workbook?.getSheetBySheetId(sheetId) : undefined;
    if (!workbook || !sheetId || !sheet) return none;
    const name = sheet.getName();
    let fate: SheetFate | undefined;
    if (added.length) fate = { name, renamed: false, maps: sheetMaps(added, sheetId) };
    else if (info.id === SetWorksheetNameCommand.id && params?.name && params.name !== name) fate = { name: params.name, renamed: true, maps: IDENTITY };
    else if (info.id === RemoveSheetCommand.id) fate = { name: null, renamed: false, maps: IDENTITY };
    if (!fate) return none;
    const injector = this.univer.__getInjector();
    const formats = injector.has(ConditionalFormattingRuleModel) ? injector.get(ConditionalFormattingRuleModel) : undefined;
    const validations = injector.has(SheetDataValidationModel) ? injector.get(SheetDataValidationModel) : undefined;
    const unitId = workbook.getUnitId();
    const redos: IMutationInfo[] = [];
    const undos: IMutationInfo[] = [];
    for (const target of workbook.getSheets()) {
      const targetId = target.getSheetId();
      // Univer drops the rules of a deleted sheet itself.
      if (fate.name === null && targetId === sheetId) continue;
      const scope: FormulaScope = { homeSheet: target.getName(), sheet: other => (other.toLowerCase() === name.toLowerCase() ? fate : undefined) };
      const maps = targetId === sheetId ? fate.maps : IDENTITY;
      for (const rule of validations?.getRules(unitId, targetId) ?? []) {
        const moved = moveDataValidation(rule, maps, scope);
        const update = (value: typeof rule) => ({
          id: UpdateDataValidationMutation.id,
          params: {
            unitId, subUnitId: targetId, ruleId: rule.uid, source: 'patched',
            payload: { type: UpdateRuleType.ALL, payload: { ranges: value.ranges, formula1: value.formula1, formula2: value.formula2 } },
          },
        });
        if (!moved) {
          if (UNIVER_MOVED_VALIDATIONS.has(rule.type)) continue;
          redos.push({ id: RemoveDataValidationMutation.id, params: { unitId, subUnitId: targetId, ruleId: rule.uid } });
          undos.push({ id: AddDataValidationMutation.id, params: { unitId, subUnitId: targetId, rule: { ...rule }, index: validations!.getRuleIndex(unitId, targetId, rule.uid) } });
        } else if (stable(moved) !== stable(rule)) {
          redos.push(update(moved));
          undos.push(update(rule));
        }
      }
      for (const rule of formats?.getSubunitRules(unitId, targetId) ?? []) {
        const moved = moveConditionalFormat(rule, maps, scope);
        if (!moved) {
          const removal = { unitId, subUnitId: targetId, cfId: rule.cfId };
          redos.push({ id: DeleteConditionalRuleMutation.id, params: removal });
          // Restored in list order, each rule finds the one it followed.
          undos.push(...DeleteConditionalRuleMutationUndoFactory(injector, removal));
        } else if (stable(moved) !== stable(rule)) {
          const change = { unitId, subUnitId: targetId, cfId: rule.cfId, rule: moved };
          redos.push({ id: SetConditionalRuleMutation.id, params: change });
          undos.push(...setConditionalRuleMutationUndoFactory(injector, change));
        }
      }
    }
    return { redos, undos };
  }

  /**
   * Excel's table AutoExpansion: an entry in the empty cells right below a table (without a total
   * row) or right beside it makes them part of the table. Noted before the values land, since only
   * empty cells grow a table.
   */
  private expansionFor(params: StructureCommandParams | undefined): typeof this.expansion {
    const range = params?.range;
    const sheetId = this.sheetIdOf(params);
    const ranges = range && sheetId ? this.grownRanges(sheetId, range) : undefined;
    return ranges && sheetId ? { sheetId, ranges } : undefined;
  }

  /** The tables an entry into the cells of `range` grows, with their new ranges (none when a target cell had content). */
  private grownRanges(sheetId: string, range: CellRange): Map<string, CellRange> | undefined {
    const worksheet = this.workbook()?.getSheetBySheetId(sheetId);
    const tables = this.info.sheets.get(sheetId)?.tables ?? [];
    if (!worksheet || !tables.length) return undefined;
    const current = currentTableRanges(this.info, this.log, this.extents);
    const empty = (area: CellRange) => {
      for (let row = area.startRow; row <= area.endRow; row++) {
        for (let column = area.startColumn; column <= area.endColumn; column++) if (headerText(worksheet, row, column)) return false;
      }
      return true;
    };
    const ranges = new Map<string, CellRange>();
    for (const table of tables) {
      const now = current.get(table.name);
      if (!now) continue;
      const columns = range.startColumn <= now.endColumn && range.endColumn >= now.startColumn;
      const rows = range.startRow <= now.endRow && range.endRow >= now.startRow;
      let grown: CellRange | undefined;
      if (!table.totalsRows && columns && range.startRow <= now.endRow + 1 && range.endRow > now.endRow
        && empty({ startRow: now.endRow + 1, endRow: range.endRow, startColumn: Math.max(range.startColumn, now.startColumn), endColumn: Math.min(range.endColumn, now.endColumn) })) {
        grown = { ...now, endRow: range.endRow };
      } else if (rows && range.startColumn <= now.endColumn + 1 && range.endColumn > now.endColumn
        && empty({ startRow: Math.max(range.startRow, now.startRow), endRow: Math.min(range.endRow, now.endRow), startColumn: now.endColumn + 1, endColumn: range.endColumn })) {
        grown = { ...now, endColumn: range.endColumn };
      }
      // A table never grows into another one on its sheet.
      const overlaps = grown && tables.some(other => {
        const range = other.name !== table.name ? current.get(other.name) : undefined;
        return range && range.startRow <= grown!.endRow && range.endRow >= grown!.startRow && range.startColumn <= grown!.endColumn && range.endColumn >= grown!.startColumn;
      });
      if (grown && !overlaps) ranges.set(table.name, grown);
    }
    return ranges.size ? ranges : undefined;
  }

  /** Excel grows a table when cells are pasted right below or beside it, as when they are typed there. */
  pasteExpansion(sheetId: string, range: CellRange, hasValues: boolean): { redos: IMutationInfo[]; undos: IMutationInfo[] } {
    const ranges = hasValues ? this.grownRanges(sheetId, range) : undefined;
    if (!ranges) return { redos: [], undos: [] };
    const pasted = (row: number, column: number) => row >= range.startRow && row <= range.endRow && column >= range.startColumn && column <= range.endColumn;
    return this.growTables(sheetId, ranges, pasted);
  }

  /**
   * The noted expansion, once the entry left a value: the tables' new extents, the calculated
   * columns' formulas in new rows and names for new columns, all undone with the entry.
   */
  private expansionMutations(params: { subUnitId?: string; cellValue?: Record<number, Record<number, Nullable<ICellData>>> } | undefined): { redos: IMutationInfo[]; undos: IMutationInfo[] } {
    const none = { redos: [], undos: [] };
    const expansion = this.expansion;
    this.expansion = undefined;
    const sheetId = this.sheetIdOf(params);
    const entered = params?.cellValue ?? {};
    if (!expansion || !sheetId || expansion.sheetId !== sheetId) return none;
    const filled = (cell: Nullable<ICellData>) => Boolean(cell && ((cell.v !== undefined && cell.v !== null && cell.v !== '') || cell.f || cell.p));
    if (!Object.values(entered).some(row => Object.values(row ?? {}).some(filled))) return none;
    return this.growTables(sheetId, expansion.ranges, (row, column) => entered[row]?.[column] !== undefined);
  }

  /**
   * Tables grown to `ranges`: their new extents, the calculated columns' formulas in new rows and
   * names for new columns (cells the edit itself fills keep its values), undone with the edit.
   */
  private growTables(sheetId: string, ranges: Map<string, CellRange>, entered: (row: number, column: number) => boolean): { redos: IMutationInfo[]; undos: IMutationInfo[] } {
    const none = { redos: [], undos: [] };
    const worksheet = this.workbook()?.getSheetBySheetId(sheetId);
    if (!worksheet) return none;
    const current = currentTableRanges(this.info, this.log, this.extents);
    const next = new Map(this.extents);
    const cells: Record<number, Record<number, ICellData>> = {};
    const cleared: Record<number, Record<number, ICellData>> = {};
    const set = (row: number, column: number, cell: ICellData, undo: ICellData) => {
      if (entered(row, column)) return;
      (cells[row] ??= {})[column] = cell;
      (cleared[row] ??= {})[column] = undo;
    };
    for (const [name, grown] of ranges) {
      const before = current.get(name);
      const table = this.imported.tables.find(item => item.name === name);
      if (!before || !table) continue;
      next.set(name, { range: grown, after: this.log.length });
      // New rows take the calculated columns' formulas, moved down from the row above.
      for (const column of this.calculatedColumns(table, before)) {
        const formula = this.formulaAt(worksheet, before.endRow, column);
        if (!formula) continue;
        for (let row = before.endRow + 1; row <= grown.endRow; row++) {
          if (!headerText(worksheet, row, column)) set(row, column, { f: `=${offsetFormula(formula, row - before.endRow, 0)}` }, { f: null, si: null, v: null });
        }
      }
      // New columns are named in the header row, as inserted ones are.
      if (table.showHeader && grown.endColumn > before.endColumn) {
        const names = new Set<string>();
        for (let column = before.startColumn; column <= grown.endColumn; column++) {
          const text = headerText(worksheet, before.startRow, column);
          if (text) names.add(text.toLowerCase());
        }
        for (let column = before.endColumn + 1; column <= grown.endColumn; column++) {
          if (headerText(worksheet, before.startRow, column)) continue;
          let index = 1;
          while (names.has(this.columnName(index).toLowerCase())) index++;
          names.add(this.columnName(index).toLowerCase());
          set(before.startRow, column, { v: this.columnName(index), t: CellValueType.STRING }, { v: null });
        }
      }
    }
    if (next.size === this.extents.size && [...next].every(([name, extent]) => this.extents.get(name) === extent)) return none;
    const unitId = this.imported.data.id;
    const redos: IMutationInfo[] = [{ id: SET_TABLE_EXTENTS_MUTATION, params: { extents: [...next] } }];
    const undos: IMutationInfo[] = [{ id: SET_TABLE_EXTENTS_MUTATION, params: { extents: [...this.extents] } }];
    if (Object.keys(cells).length) {
      redos.push({ id: SetRangeValuesMutation.id, params: { unitId, subUnitId: sheetId, cellValue: cells } });
      undos.push({ id: SetRangeValuesMutation.id, params: { unitId, subUnitId: sheetId, cellValue: cleared } });
    }
    return { redos, undos };
  }

  /** The sheet columns of a table's calculated columns now. */
  private calculatedColumns(table: EditorImport['tables'][number], range: CellRange): number[] {
    const maps = sheetMaps(this.log, table.sheetId);
    return (table.calculatedColumns ?? []).map(offset => maps.columns.index(table.range.startColumn + offset))
      .filter((column): column is number => column !== null && column >= range.startColumn && column <= range.endColumn);
  }

  /** A cell's formula text without its `=`: its own, or its shared formula group's moved to it. */
  private formulaAt(worksheet: Worksheet, row: number, column: number): string | undefined {
    const cell = worksheet.getCellRaw(row, column);
    if (typeof cell?.f === 'string' && cell.f) return cell.f.replace(/^=/, '');
    if (!cell?.si) return undefined;
    let anchor: { row: number; column: number; formula: string } | undefined;
    worksheet.getCellMatrix().forValue((r, c, other) => {
      const formula = other?.si === cell.si ? other?.f : undefined;
      if (typeof formula === 'string' && formula) anchor = { row: r, column: c, formula: formula.replace(/^=/, '') };
      return anchor ? false : undefined;
    });
    return anchor ? offsetFormula(anchor.formula, row - anchor.row, column - anchor.column) : undefined;
  }

  /**
   * Columns inserted inside a table become table columns named as Excel names them (Column1,
   * Column2 … in the workbook's language), in their header cells.
   */
  private tableHeaderMutation(op: StructureOp): IMutationInfo | undefined {
    const worksheet = this.workbook()?.getSheetBySheetId(op.sheetId);
    const tables = this.info.sheets.get(op.sheetId)?.tables ?? [];
    if (!worksheet || !tables.length) return undefined;
    const ranges = currentTableRanges(this.info, this.log, this.extents);
    const cellValue: Record<number, Record<number, ICellData>> = {};
    for (const table of tables) {
      const range = ranges.get(table.name);
      if (!range || table.headerRows < 1 || op.index <= range.startColumn || op.index > range.endColumn) continue;
      const names = new Set<string>();
      for (let column = range.startColumn; column <= range.endColumn; column++) names.add(headerText(worksheet, range.startRow, column).toLowerCase());
      for (let offset = 0; offset < op.count; offset++) {
        let index = 1;
        while (names.has(this.columnName(index).toLowerCase())) index++;
        const name = this.columnName(index);
        names.add(name.toLowerCase());
        (cellValue[range.startRow] ??= {})[op.index + offset] = { v: name, t: CellValueType.STRING };
      }
    }
    return Object.keys(cellValue).length ? { id: SetRangeValuesMutation.id, params: { unitId: this.imported.data.id, subUnitId: op.sheetId, cellValue } } : undefined;
  }

  /** Formulas resolve structured references through table ranges and columns, which follow row and column edits. */
  private syncTables(): void {
    try {
      const ranges = currentTableRanges(this.info, this.log, this.extents);
      for (const table of this.imported.tables) {
        const range = ranges.get(table.name);
        if (!range) continue;
        registerWorkbookTable(this.univer, this.imported.data.id, table.name, {
          sheetId: table.sheetId, range, titleMap: this.tableColumns(table, range), showHeader: table.showHeader, showFooter: table.showFooter,
        });
      }
    } catch (error) {
      console.warn('[SheetEditor] Could not update table ranges:', error);
    }
  }

  /** A table's column names and their offsets now: moved by column edits, new ones named by their header cells. */
  private tableColumns(table: EditorImport['tables'][number], range: CellRange): Map<string, number> {
    const maps = sheetMaps(this.log, table.sheetId);
    const columns = new Map<string, number>();
    const taken = new Set<number>();
    for (const [name, offset] of table.columns) {
      const column = maps.columns.index(table.range.startColumn + offset);
      if (column === null) continue;
      columns.set(name, column - range.startColumn);
      taken.add(column);
    }
    const worksheet = this.workbook()?.getSheetBySheetId(table.sheetId);
    if (worksheet && table.showHeader) {
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        const name = taken.has(column) ? '' : headerText(worksheet, range.startRow, column);
        if (name && !columns.has(name)) columns.set(name, column - range.startColumn);
      }
    }
    return columns;
  }

  /** Whether formulas use, by name, a table column among the given sheet columns. */
  private tableColumnsInUse(sheetId: string, start: number, end: number): boolean {
    const workbook = this.workbook();
    const worksheet = workbook?.getSheetBySheetId(sheetId);
    const tables = this.info.sheets.get(sheetId)?.tables ?? [];
    if (!workbook || !worksheet || !tables.length) return false;
    const ranges = currentTableRanges(this.info, this.log, this.extents);
    const names: string[] = [];
    for (const table of tables) {
      const range = ranges.get(table.name);
      if (!range || table.headerRows < 1 || start > range.endColumn || end < range.startColumn) continue;
      for (let column = Math.max(start, range.startColumn); column <= Math.min(end, range.endColumn); column++) {
        const name = headerText(worksheet, range.startRow, column).toLowerCase();
        if (name) names.push(name);
      }
    }
    if (!names.length) return false;
    let used = false;
    for (const sheet of workbook.getSheets()) {
      sheet.getCellMatrix().forValue((_row, _column, cell) => {
        const formula = typeof cell?.f === 'string' ? cell.f.toLowerCase() : '';
        // `[Amount]`, `[@Amount]` and `[@[Amount]]` all name the column in brackets.
        if (formula && names.some(name => formula.includes(`[${name}]`) || formula.includes(`[@${name}]`))) used = true;
        return used ? false : undefined;
      });
      if (used) break;
    }
    return used;
  }

  /** The workbook's Excel tables by name, with their ranges moved by the row and column edits so far. */
  tableRanges(): Map<string, CellRange> {
    return currentTableRanges(this.info, this.log, this.extents);
  }

  /** The current ranges of the tables that grew by typing next to them, for saving. */
  grownTables(): Map<string, CellRange> {
    const ranges = this.tableRanges();
    return new Map([...this.extents.keys()].flatMap(name => (ranges.has(name) ? [[name, ranges.get(name)!] as const] : [])));
  }

  /** The Excel table a cell belongs to (its current range), if one does. */
  tableAt(sheetId: string, row: number, column: number): string | undefined {
    const tables = this.info.sheets.get(sheetId)?.tables ?? [];
    if (!tables.length) return undefined;
    const ranges = currentTableRanges(this.info, this.log, this.extents);
    return tables.find(table => {
      const range = ranges.get(table.name);
      return range && row >= range.startRow && row <= range.endRow && column >= range.startColumn && column <= range.endColumn;
    })?.name;
  }

  /** Why a command cannot run on this workbook, if it cannot. */
  refusalFor(command: { id: string; params?: unknown }): StructureRefusal | undefined {
    if (BLOCKED_SHEET_COMMAND.test(command.id)) return StructureRefusal.Unsupported;
    // Charts and pictures made in the editor (and copies of them) are saved; pictures only in formats a workbook holds.
    if (command.id === INSERT_DRAWINGS_COMMAND) return insertRefusal(command.params);
    if (command.id === INSERT_PICTURE_COMMAND) return undefined;
    if (UNSUPPORTED_IMAGE_EDIT.test(command.id)) return StructureRefusal.ImageEdit;
    const kind = GUARDED_COMMANDS[command.id];
    if (kind) {
      const params = command.params as StructureCommandParams | undefined;
      const range = params?.range;
      const sheetId = this.sheetIdOf(params);
      if (!range || !sheetId) return undefined;
      const refusal = refuseRowsOrColumns(this.info, this.log, {
        sheetId, ...kind,
        start: kind.axis === StructureAxis.Rows ? range.startRow : range.startColumn,
        end: kind.axis === StructureAxis.Rows ? range.endRow : range.endColumn,
      }, this.extents);
      if (refusal) return refusal;
      if (kind === REMOVE_COLUMNS && this.tableColumnsInUse(sheetId, range.startColumn, range.endColumn)) return StructureRefusal.TableColumnInUse;
      return undefined;
    }
    if (command.id === SetWorksheetOrderCommand.id && this.info.threeDimensional) return StructureRefusal.ThreeDimensionalReferences;
    if (command.id === SORT_RANGE_COMMAND) {
      const params = command.params as StructureCommandParams | undefined;
      const sheetId = this.sheetIdOf(params);
      if (sheetId && params?.range && hasAttachments(this.info, this.log, sheetId, params.range)) return StructureRefusal.SortAttachments;
    }
    if (command.id === CopySheetCommand.id) {
      const sheetId = this.sheetIdOf(command.params as { subUnitId?: string } | undefined);
      if (sheetId && this.info.sheets.get(sheetId)?.keepsHiddenContent) return StructureRefusal.CopyWithContent;
    }
    if (command.id === RemoveSheetCommand.id) {
      const sheetId = this.sheetIdOf(command.params as { subUnitId?: string } | undefined);
      const tables = (sheetId && this.info.sheets.get(sheetId)?.tables) || [];
      const workbook = this.workbook();
      if (tables.length && workbook) {
        const formulas: string[] = [];
        for (const sheet of workbook.getSheets()) {
          if (sheet.getSheetId() === sheetId) continue;
          sheet.getCellMatrix().forValue((_row, _column, cell) => { if (cell?.f) formulas.push(cell.f.toLowerCase()); });
        }
        const text = formulas.join('\n');
        if (tables.some(table => table.name && text.includes(`${table.name.toLowerCase()}[`))) return StructureRefusal.TableInUse;
      }
    }
    return undefined;
  }
}
