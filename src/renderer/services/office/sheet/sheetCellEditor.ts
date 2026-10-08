import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, DOCS_NORMAL_EDITOR_UNIT_ID_KEY, ICommandService, IUniverInstanceService, type Univer, UniverInstanceType } from '@univerjs/core';
import { IEditorService } from '@univerjs/docs-ui';
import { DeviceInputEventType } from '@univerjs/engine-render';
import { SetCellEditVisibleOperation } from '@univerjs/sheets-ui';

/**
 * Start entering `text` into the active cell, as if it had been typed: Enter keeps it, Escape
 * drops it. Used for Excel's date and time shortcuts and to retry a refused entry.
 */
export function enterIntoActiveCell(univer: Univer, text: string): boolean {
  const injector = univer.__getInjector();
  const unitId = injector.get(IUniverInstanceService).getCurrentUnitOfType(UniverInstanceType.UNIVER_SHEET)?.getUnitId();
  if (!unitId) return false;
  injector.get(ICommandService).syncExecuteCommand(SetCellEditVisibleOperation.id, { visible: true, unitId, eventType: DeviceInputEventType.Keyboard });
  const editors = injector.get(IEditorService);
  editors.getEditor(DOCS_NORMAL_EDITOR_UNIT_ID_KEY)?.replaceText(text);
  editors.getEditor(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)?.replaceText(text, false);
  return true;
}
