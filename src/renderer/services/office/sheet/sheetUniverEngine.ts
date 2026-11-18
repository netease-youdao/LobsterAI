import '@univerjs/engine-formula/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-numfmt/facade';

import { ICommandService, type ILocales, LocaleType, mergeLocales, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverDataValidationPlugin } from '@univerjs/data-validation';
import DataValidationEnUS from '@univerjs/data-validation/locale/en-US';
import DataValidationZhCN from '@univerjs/data-validation/locale/zh-CN';
import { type ISetSuperTableMutationParam, type ISuperTable, SetSuperTableMutation, UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import EngineFormulaEnUS from '@univerjs/engine-formula/locale/en-US';
import EngineFormulaZhCN from '@univerjs/engine-formula/locale/zh-CN';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import SheetsEnUS from '@univerjs/sheets/locale/en-US';
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN';
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting';
import SheetsConditionalFormattingEnUS from '@univerjs/sheets-conditional-formatting/locale/en-US';
import SheetsConditionalFormattingZhCN from '@univerjs/sheets-conditional-formatting/locale/zh-CN';
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation';
import SheetsDataValidationEnUS from '@univerjs/sheets-data-validation/locale/en-US';
import SheetsDataValidationZhCN from '@univerjs/sheets-data-validation/locale/zh-CN';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import SheetsFilterEnUS from '@univerjs/sheets-filter/locale/en-US';
import SheetsFilterZhCN from '@univerjs/sheets-filter/locale/zh-CN';
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import SheetsFormulaEnUS from '@univerjs/sheets-formula/locale/en-US';
import SheetsFormulaZhCN from '@univerjs/sheets-formula/locale/zh-CN';
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';

import type { ImportedTable } from './xlsxImport';

/**
 * The model half of the spreadsheet engine: data, commands, formulas and number formats,
 * without rendering. The editor adds its UI plugins on top; tests and the agent's dry runs
 * use it headless.
 */

export type SheetLanguage = 'zh' | 'en';

export const toUniverLocale = (language: SheetLanguage): LocaleType => (language === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US);

export const ENGINE_LOCALES: Record<SheetLanguage, ILocales[string][]> = {
  zh: [SheetsZhCN, SheetsFormulaZhCN, EngineFormulaZhCN, SheetsConditionalFormattingZhCN, DataValidationZhCN, SheetsDataValidationZhCN, SheetsFilterZhCN],
  en: [SheetsEnUS, SheetsFormulaEnUS, EngineFormulaEnUS, SheetsConditionalFormattingEnUS, DataValidationEnUS, SheetsDataValidationEnUS, SheetsFilterEnUS],
};

/**
 * Formulas with a cached result keep it until an input changes: the file's own results stay
 * visible even for functions the engine does not implement. Only empty results are computed.
 */
export const FORMULA_CONFIG = { initialFormulaComputing: CalculationMode.WHEN_EMPTY } as const;

export function createHeadlessSheetUniver(language: SheetLanguage): { univer: Univer; api: FUniver } {
  const locale = toUniverLocale(language);
  const univer = new Univer({ locale, locales: { [locale]: mergeLocales(...ENGINE_LOCALES[language]) } });
  univer.registerPlugin(UniverFormulaEnginePlugin);
  univer.registerPlugin(UniverSheetsPlugin);
  univer.registerPlugin(UniverSheetsFormulaPlugin, FORMULA_CONFIG);
  univer.registerPlugin(UniverSheetsNumfmtPlugin);
  univer.registerPlugin(UniverSheetsConditionalFormattingPlugin);
  univer.registerPlugin(UniverDataValidationPlugin);
  univer.registerPlugin(UniverSheetsDataValidationPlugin);
  univer.registerPlugin(UniverSheetsFilterPlugin);
  univer.registerPlugin(UniverSheetsNotePlugin);
  return { univer, api: FUniver.newAPI(univer) };
}

/**
 * Tell the formula engine where a table is, so `Table[Column]` resolves. As a mutation, it also
 * reaches an engine running in a worker.
 */
export function registerWorkbookTable(univer: Univer, unitId: string, tableName: string, reference: ISuperTable): void {
  const params: ISetSuperTableMutationParam = { unitId, tableName, reference };
  univer.__getInjector().get(ICommandService).syncExecuteCommand(SetSuperTableMutation.id, params, { onlyLocal: true });
}

/** Let formulas resolve structured references (`Table[Column]`) to the workbook's Excel tables. */
export function registerWorkbookTables(univer: Univer, unitId: string, tables: ImportedTable[]): void {
  for (const table of tables) {
    registerWorkbookTable(univer, unitId, table.name, {
      sheetId: table.sheetId,
      range: table.range,
      titleMap: new Map(table.columns),
      showHeader: table.showHeader,
      showFooter: table.showFooter,
    });
  }
}
