import {
  DataValidationErrorStyle, DataValidationStatus, type IDisposable, InterceptorEffectEnum, type ISheetDataValidationRule, type Nullable, type Univer,
} from '@univerjs/core';
import { InterceptCellContentPriority, INTERCEPTOR_POINT, SheetInterceptorService, SheetsSelectionsService, VALIDATE_CELL } from '@univerjs/sheets';
import type { FWorkbook } from '@univerjs/sheets/facade';
import { SheetDataValidationModel, SheetsDataValidationValidatorService } from '@univerjs/sheets-data-validation';
import { SheetCanvasPopManagerService } from '@univerjs/sheets-ui';
import { IDialogService } from '@univerjs/ui';
import { createElement } from 'react';

import { SheetValidationAlertButtons, SheetValidationAlertMessage } from '../../components/artifacts/renderers/sheet/SheetValidationAlert';
import { enterIntoActiveCell } from './sheetCellEditor';
import { ValidationAlertChoice } from './sheetValidation';

/** The dialog Univer shows when a "stop" rule refuses what was typed (DataValidationRejectInputController). */
const REJECT_DIALOG = 'reject-input-dialog';
/** The red corner Univer draws on cells its rules refuse (dv-render.controller INVALID_MARK). */
const INVALID_MARK_COLOR = '#fe4b4b';
/** Excel's error alert for typed entries, which answers before Univer's refusal. */
const ALERT_DIALOG = 'lobster-validation-alert';
const ALERT_WIDTH = 400;

export interface ValidationMessageLabels {
  /** The alert's title when the rule has none. */
  alertTitle: string;
}

/** The floating component that shows a rule's input message (registered with Univer's UI). */
export const VALIDATION_PROMPT_COMPONENT = 'LOBSTER_SHEET_VALIDATION_PROMPT';

export interface ValidationPromptProps {
  title?: string;
  message?: string;
}

/**
 * Excel's data validation messages: selecting a cell whose rule has an input message shows its
 * title and text beside the cell until another cell is selected; typed entries a rule refuses get
 * Excel's error alert (see installValidationAlerts), under the rule's own error title; cells that
 * break their rule are not marked. Univer keeps the messages but never shows them.
 */
export function installValidationPrompts(univer: Univer, workbook: FWorkbook, labels: ValidationMessageLabels): IDisposable {
  const injector = univer.__getInjector();
  const popups = injector.get(SheetCanvasPopManagerService);
  const model = injector.get(SheetDataValidationModel);
  const activeRule = () => {
    const sheet = workbook.getActiveSheet();
    const cell = sheet.getSelection()?.getCurrentCell();
    return cell ? { cell, rule: model.getRuleByLocation(workbook.getId(), sheet.getSheetId(), cell.actualRow, cell.actualColumn) } : undefined;
  };
  let shown: IDisposable | undefined;
  const update = () => {
    shown?.dispose();
    shown = undefined;
    const sheet = workbook.getActiveSheet();
    const active = activeRule();
    if (!active) return;
    const { cell, rule } = active;
    if (!rule?.showInputMessage || !(rule.promptTitle?.trim() || rule.prompt?.trim())) return;
    const extraProps: ValidationPromptProps = { title: rule.promptTitle, message: rule.prompt };
    shown = popups.attachPopupToCell(cell.actualRow, cell.actualColumn, { componentKey: VALIDATION_PROMPT_COMPONENT, direction: 'right', extraProps: { ...extraProps } },
      workbook.getId(), sheet.getSheetId()) ?? undefined;
  };
  // Selections the user makes and the ones set in code (an agent revealing its edit).
  const selection = injector.get(SheetsSelectionsService).selectionChanged$.subscribe(update);
  const rules = model.ruleChange$.subscribe(update);
  // Univer titles every refusal "Alert"; Excel uses the rule's error title. Entries are typed into
  // the active cell. The service is a lazy proxy that caches its bound methods as own properties,
  // which is what the refusal controller calls: the cached method is replaced, not the instance's.
  const dialogs = injector.get(IDialogService);
  const open = dialogs.open;
  const titled: typeof open = params => {
    const title = params.id === REJECT_DIALOG ? activeRule()?.rule?.errorTitle?.trim() : undefined;
    return open.call(dialogs, title ? { ...params, title: { ...params.title, title } } : params);
  };
  const setOpen = (value: typeof open) => Object.defineProperty(dialogs, 'open', { value, configurable: true, writable: true });
  setOpen(titled);
  const alerts = installValidationAlerts(univer, workbook, labels);
  // Excel does not mark cells that break their rule (a red corner there means a note); drop Univer's
  // mark after its rule rendering and before the note's own corner.
  const marks = injector.get(SheetInterceptorService).intercept(INTERCEPTOR_POINT.CELL_CONTENT, {
    effect: InterceptorEffectEnum.Style,
    priority: InterceptCellContentPriority.DATA_VALIDATION - 1,
    handler: (cell, _location, next) => {
      if (cell?.markers?.tr?.color !== INVALID_MARK_COLOR) return next(cell);
      const { tr: _invalid, ...markers } = cell.markers;
      return next({ ...cell, markers });
    },
  });
  return {
    dispose: () => {
      selection.unsubscribe();
      rules.unsubscribe();
      shown?.dispose();
      alerts.dispose();
      marks.dispose();
      if (dialogs.open === titled) setOpen(open);
    },
  };
}

/** Excel's error alert for one refused entry; closing it drops the entry. */
function askAboutEntry(dialogs: IDialogService, rule: ISheetDataValidationRule, message: string, labels: ValidationMessageLabels): Promise<ValidationAlertChoice> {
  const errorStyle = rule.errorStyle ?? DataValidationErrorStyle.STOP;
  return new Promise(resolve => {
    let answered = false;
    const answer = (choice: ValidationAlertChoice) => {
      if (answered) return;
      answered = true;
      dialogs.close(ALERT_DIALOG);
      resolve(choice);
    };
    dialogs.open({
      id: ALERT_DIALOG,
      width: ALERT_WIDTH,
      title: { title: rule.errorTitle?.trim() || labels.alertTitle },
      children: { title: createElement(SheetValidationAlertMessage, { errorStyle, message }) },
      footer: { title: createElement(SheetValidationAlertButtons, { errorStyle, onChoose: answer }) },
      onClose: () => answer(ValidationAlertChoice.Discard),
    });
  });
}

/**
 * Excel's error alerts for typed entries: "stop" asks to retry or cancel, "warning" whether to
 * continue (yes keeps the entry, no edits it again), "information" to keep or cancel. Univer only
 * refuses "stop" entries and accepts the others silently. Runs before Univer's own refusal.
 */
function installValidationAlerts(univer: Univer, workbook: FWorkbook, labels: ValidationMessageLabels): IDisposable {
  const injector = univer.__getInjector();
  const model = injector.get(SheetDataValidationModel);
  const validators = injector.get(SheetsDataValidationValidatorService);
  const dialogs = injector.get(IDialogService);
  const accept = async (previous: Nullable<Promise<boolean>>, location: { unitId: string; subUnitId: string; row: number; col: number }): Promise<boolean> => {
    if (await previous === false) return false;
    const { unitId, subUnitId, row, col } = location;
    const rule = model.getRuleByLocation(unitId, subUnitId, row, col);
    if (!rule || rule.showErrorMessage === false) return true;
    if (await validators.validatorCell(unitId, subUnitId, row, col) === DataValidationStatus.VALID) return true;
    // The entry is in the cell until it is refused: keep what was typed for a retry.
    const range = workbook.getSheetBySheetId(subUnitId)?.getRange(row, col);
    const typed = range?.getFormula() || range?.getDisplayValue() || '';
    const message = model.getValidator(rule.type)?.getRuleFinalError(rule, { row, col, unitId, subUnitId }) ?? '';
    const choice = await askAboutEntry(dialogs, rule, message, labels);
    if (choice === ValidationAlertChoice.Keep && rule.errorStyle !== undefined && rule.errorStyle !== DataValidationErrorStyle.STOP) return true;
    // Univer rolls the entry back once this answers.
    if (choice === ValidationAlertChoice.Retry) setTimeout(() => enterIntoActiveCell(univer, typed), 0);
    return false;
  };
  const remove = injector.get(SheetInterceptorService).writeCellInterceptor.intercept(VALIDATE_CELL, {
    priority: 100,
    handler: (lastResult, context, next) => next(accept(lastResult, context)),
  });
  return { dispose: () => { remove(); } };
}
