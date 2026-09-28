import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/sheets-ui/lib/index.css';
import '@univerjs/sheets-formula-ui/lib/index.css';
import '@univerjs/sheets-numfmt-ui/lib/index.css';
import '@univerjs/find-replace/lib/index.css';
import '@univerjs/sheets-sort-ui/lib/index.css';
import '@univerjs/sheets-conditional-formatting-ui/lib/index.css';
import '@univerjs/sheets-data-validation-ui/lib/index.css';
import '@univerjs/sheets-filter-ui/lib/index.css';
import '@univerjs/sheets-hyper-link-ui/lib/index.css';
import '@univerjs/sheets-note-ui/lib/index.css';
import '@univerjs/drawing-ui/lib/index.css';
import '@univerjs/sheets-drawing-ui/lib/index.css';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-numfmt/facade';
import '@univerjs/ui/facade';
import '@univerjs/docs/facade';
import '@univerjs/docs-ui/facade';
import '@univerjs/sheets-ui/facade';
import '@univerjs/sheets-formula-ui/facade';
import '@univerjs/sheets-find-replace/facade';
import '@univerjs/sheets-sort/facade';
import '@univerjs/sheets-conditional-formatting/facade';
import '@univerjs/sheets-drawing-ui/facade';

import { Inject, Injector, mergeLocales, Plugin, Univer, UniverInstanceType } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverDataValidationPlugin } from '@univerjs/data-validation';
import DesignEnUS from '@univerjs/design/locale/en-US';
import DesignZhCN from '@univerjs/design/locale/zh-CN';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import DocsUIEnUS from '@univerjs/docs-ui/locale/en-US';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui';
import DrawingUIEnUS from '@univerjs/drawing-ui/locale/en-US';
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import FindReplaceEnUS from '@univerjs/find-replace/locale/en-US';
import FindReplaceZhCN from '@univerjs/find-replace/locale/zh-CN';
import { UniverRPCMainThreadPlugin } from '@univerjs/rpc';
import { InsertColCommand, InsertRowCommand, RefRangeService, RemoveColCommand, RemoveRowCommand, UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting';
import { UniverSheetsConditionalFormattingUIPlugin } from '@univerjs/sheets-conditional-formatting-ui';
import SheetsConditionalFormattingUIEnUS from '@univerjs/sheets-conditional-formatting-ui/locale/en-US';
import SheetsConditionalFormattingUIZhCN from '@univerjs/sheets-conditional-formatting-ui/locale/zh-CN';
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation';
import { UniverSheetsDataValidationUIPlugin } from '@univerjs/sheets-data-validation-ui';
import SheetsDataValidationUIEnUS from '@univerjs/sheets-data-validation-ui/locale/en-US';
import SheetsDataValidationUIZhCN from '@univerjs/sheets-data-validation-ui/locale/zh-CN';
import { UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing';
import { UniverSheetsDrawingUIPlugin } from '@univerjs/sheets-drawing-ui';
import SheetsDrawingUIEnUS from '@univerjs/sheets-drawing-ui/locale/en-US';
import SheetsDrawingUIZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { UniverSheetsFilterUIPlugin } from '@univerjs/sheets-filter-ui';
import SheetsFilterUIEnUS from '@univerjs/sheets-filter-ui/locale/en-US';
import SheetsFilterUIZhCN from '@univerjs/sheets-filter-ui/locale/zh-CN';
import { UniverSheetsFindReplacePlugin } from '@univerjs/sheets-find-replace';
import { FormulaRefRangeService, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui';
import SheetsFormulaUIEnUS from '@univerjs/sheets-formula-ui/locale/en-US';
import SheetsFormulaUIZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN';
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link';
import SheetsHyperLinkEnUS from '@univerjs/sheets-hyper-link/locale/en-US';
import SheetsHyperLinkZhCN from '@univerjs/sheets-hyper-link/locale/zh-CN';
import { UniverSheetsHyperLinkUIPlugin } from '@univerjs/sheets-hyper-link-ui';
import SheetsHyperLinkUIEnUS from '@univerjs/sheets-hyper-link-ui/locale/en-US';
import SheetsHyperLinkUIZhCN from '@univerjs/sheets-hyper-link-ui/locale/zh-CN';
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note';
import { UniverSheetsNoteUIPlugin } from '@univerjs/sheets-note-ui';
import SheetsNoteUIEnUS from '@univerjs/sheets-note-ui/locale/en-US';
import SheetsNoteUIZhCN from '@univerjs/sheets-note-ui/locale/zh-CN';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui';
import SheetsNumfmtUIEnUS from '@univerjs/sheets-numfmt-ui/locale/en-US';
import SheetsNumfmtUIZhCN from '@univerjs/sheets-numfmt-ui/locale/zh-CN';
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort';
import { UniverSheetsSortUIPlugin } from '@univerjs/sheets-sort-ui';
import SheetsSortUIEnUS from '@univerjs/sheets-sort-ui/locale/en-US';
import SheetsSortUIZhCN from '@univerjs/sheets-sort-ui/locale/zh-CN';
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui';
import SheetsUIEnUS from '@univerjs/sheets-ui/locale/en-US';
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN';
import { IconManager, UniverUIPlugin } from '@univerjs/ui';
import UIEnUS from '@univerjs/ui/locale/en-US';
import UIZhCN from '@univerjs/ui/locale/zh-CN';

import { SheetChart } from '../../components/artifacts/renderers/sheet/SheetChart';
import { SheetAddToChatIcon, SheetChatAction } from '../../components/artifacts/renderers/sheet/SheetChatAction';
import { SheetValidationPrompt } from '../../components/artifacts/renderers/sheet/SheetValidationPrompt';
import { SHEET_CHART_COMPONENT } from './sheetChartHost';
import { CHAT_ACTION_COMPONENT, CHAT_ICON_COMPONENT } from './sheetChatAction';
import { SHEET_MENU_CONFIG } from './sheetCommandPolicy';
import { ENGINE_LOCALES, FORMULA_CONFIG, type SheetLanguage, toUniverLocale } from './sheetUniverEngine';
import { VALIDATION_PROMPT_COMPONENT } from './sheetValidationPrompt';

const UI_LOCALES = {
  zh: [DesignZhCN, UIZhCN, DocsUIZhCN, SheetsUIZhCN, SheetsFormulaUIZhCN, SheetsNumfmtUIZhCN, FindReplaceZhCN, SheetsSortUIZhCN, SheetsConditionalFormattingUIZhCN,
    SheetsDataValidationUIZhCN, SheetsFilterUIZhCN, SheetsHyperLinkZhCN, SheetsHyperLinkUIZhCN, SheetsNoteUIZhCN, DrawingUIZhCN, SheetsDrawingUIZhCN],
  en: [DesignEnUS, UIEnUS, DocsUIEnUS, SheetsUIEnUS, SheetsFormulaUIEnUS, SheetsNumfmtUIEnUS, FindReplaceEnUS, SheetsSortUIEnUS, SheetsConditionalFormattingUIEnUS,
    SheetsDataValidationUIEnUS, SheetsFilterUIEnUS, SheetsHyperLinkEnUS, SheetsHyperLinkUIEnUS, SheetsNoteUIEnUS, DrawingUIEnUS, SheetsDrawingUIEnUS],
};

/** Link targets a workbook may open outside the app; other schemes could start local programs. */
const OPENABLE_LINK = /^(?:https?:|mailto:)/i;

function openLink(url: string): void {
  if (!OPENABLE_LINK.test(url)) {
    console.warn('[SheetEditor] Refused to open a link with an unsupported scheme');
    return;
  }
  void window.electron?.shell?.openExternal(url);
}

/** Row and column edits whose effect on rules the structure tracker applies (the ids interceptors see). */
const TRACKED_EDITS = new Set<string>([InsertRowCommand.id, RemoveRowCommand.id, InsertColCommand.id, RemoveColCommand.id]);

/**
 * Univer moves conditional-format ranges and formulas cell by cell (FormulaRefRangeService): a
 * rule splits where rows are inserted and absolute references stay where they were. Excel keeps
 * one rule and moves every reference, which is what the structure tracker does for row and column
 * edits; Univer keeps handling cell moves such as cut and paste.
 */
class RuleReferencesPlugin extends Plugin {
  static override pluginName = 'LOBSTER_SHEET_RULE_REFERENCES';
  static override type = UniverInstanceType.UNIVER_SHEET;

  constructor(_config: unknown, protected readonly _injector: Injector) {
    super();
  }

  override onStarting(): void {
    const formulas = this._injector.get(FormulaRefRangeService);
    const references = this._injector.get(RefRangeService);
    const register = formulas.registerRangeFormula.bind(formulas);
    formulas.registerRangeFormula = (...args) => {
      const watch = references.registerRefRange;
      references.registerRefRange = (range, callback, unitId, subUnitId) => watch(range, info => (TRACKED_EDITS.has(info.id) ? { redos: [], undos: [] } : callback(info)), unitId, subUnitId);
      try {
        return register(...args);
      } finally {
        references.registerRefRange = watch;
      }
    };
  }
}
Inject(Injector)(RuleReferencesPlugin, undefined, 1);

export interface SheetUniverOptions {
  container: HTMLElement;
  language: SheetLanguage;
  darkMode: boolean;
  /**
   * Where formulas are calculated: a worker running `sheetFormula.worker.ts` keeps large
   * recalculations off the grid's thread. Without one, they run on this thread.
   */
  formulaWorker?: Worker;
}

/** A worker for the editor's formula engine; the caller terminates it after disposing the instance. */
export function createSheetFormulaWorker(): Worker {
  return new Worker(new URL('./sheetFormula.worker.ts', import.meta.url), { type: 'module' });
}

/**
 * The editor's Univer instance: grid, formula bar and sheet tabs, without Univer's own ribbon —
 * LobsterAI shows a compact toolbar that only offers what can be saved back.
 */
export function createSheetUniver(options: SheetUniverOptions): { univer: Univer; api: FUniver } {
  const locale = toUniverLocale(options.language);
  const univer = new Univer({
    locale,
    darkMode: options.darkMode,
    locales: { [locale]: mergeLocales(...ENGINE_LOCALES[options.language], ...UI_LOCALES[options.language]) },
  });
  const remote = Boolean(options.formulaWorker);
  // Before the plugins whose mutations the worker must receive.
  if (options.formulaWorker) univer.registerPlugin(UniverRPCMainThreadPlugin, { workerURL: options.formulaWorker });
  univer.registerPlugin(UniverRenderEnginePlugin);
  univer.registerPlugin(UniverFormulaEnginePlugin, { notExecuteFormula: remote });
  univer.registerPlugin(UniverUIPlugin, {
    container: options.container,
    header: true,
    toolbar: false,
    footer: true,
    contextMenu: true,
    headerMenu: false,
    disableAutoFocus: true,
    menu: SHEET_MENU_CONFIG,
  });
  univer.registerPlugin(UniverDocsPlugin);
  univer.registerPlugin(UniverDocsUIPlugin);
  univer.registerPlugin(UniverSheetsPlugin, { notExecuteFormula: remote });
  univer.registerPlugin(UniverSheetsUIPlugin, {
    formulaBar: true,
    disableAutoFocus: true,
    menu: SHEET_MENU_CONFIG,
    clipboardConfig: { hidePasteOptions: true },
    // Excel flags text only when it would convert to a number; Univer also flags date-like text.
    disableForceStringMark: true,
    footer: { sheetBar: true, statisticBar: true, menus: true, zoomSlider: true, addSheetButtonConfig: { show: true, defaultColumnCount: 26 } },
  });
  univer.registerPlugin(UniverSheetsFormulaPlugin, { ...FORMULA_CONFIG, notExecuteFormula: remote });
  univer.registerPlugin(UniverSheetsFormulaUIPlugin);
  univer.registerPlugin(RuleReferencesPlugin);
  univer.registerPlugin(UniverSheetsNumfmtPlugin);
  univer.registerPlugin(UniverSheetsNumfmtUIPlugin);
  univer.registerPlugin(UniverFindReplacePlugin);
  univer.registerPlugin(UniverSheetsFindReplacePlugin);
  univer.registerPlugin(UniverSheetsSortPlugin);
  univer.registerPlugin(UniverSheetsSortUIPlugin);
  univer.registerPlugin(UniverSheetsConditionalFormattingPlugin);
  univer.registerPlugin(UniverSheetsConditionalFormattingUIPlugin);
  univer.registerPlugin(UniverDataValidationPlugin);
  univer.registerPlugin(UniverSheetsDataValidationPlugin);
  // Excel's dropdown has no edit button; the rule editor could make rules a file cannot hold.
  univer.registerPlugin(UniverSheetsDataValidationUIPlugin, { showEditOnDropdown: false });
  univer.registerPlugin(UniverSheetsFilterPlugin);
  univer.registerPlugin(UniverSheetsFilterUIPlugin);
  univer.registerPlugin(UniverSheetsHyperLinkPlugin);
  univer.registerPlugin(UniverSheetsHyperLinkUIPlugin, { urlHandler: { navigateToOtherWebsite: openLink } });
  univer.registerPlugin(UniverSheetsNotePlugin);
  univer.registerPlugin(UniverSheetsNoteUIPlugin);
  univer.registerPlugin(UniverDrawingPlugin);
  univer.registerPlugin(UniverDocsDrawingPlugin);
  univer.registerPlugin(UniverDrawingUIPlugin);
  univer.registerPlugin(UniverSheetsDrawingPlugin);
  univer.registerPlugin(UniverSheetsDrawingUIPlugin);
  const api = FUniver.newAPI(univer);
  // Charts from the file float over the grid like pictures and are drawn by LobsterAI.
  api.registerComponent(SHEET_CHART_COMPONENT, SheetChart);
  api.registerComponent(VALIDATION_PROMPT_COMPONENT, SheetValidationPrompt);
  api.registerComponent(CHAT_ACTION_COMPONENT, SheetChatAction);
  // Menu entries draw icons from Univer's icon registry.
  univer.__getInjector().get(IconManager).register(CHAT_ICON_COMPONENT, SheetAddToChatIcon);
  return { univer, api };
}
