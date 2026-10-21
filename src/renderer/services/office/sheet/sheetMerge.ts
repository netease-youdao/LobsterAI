import { Dimension, HorizontalAlign, ICommandService, IUndoRedoService, type Univer } from '@univerjs/core';
import { AddWorksheetMergeCommand, RemoveWorksheetMergeCommand, SetHorizontalTextAlignCommand } from '@univerjs/sheets';
import type { FWorkbook } from '@univerjs/sheets/facade';

/** Excel's merge menu. */
export const MergeAction = {
  /** Merge & Center: one cell per selected area, text centered across it. */
  Center: 'center',
  /** Merge Across: each row of the selection becomes one cell. */
  Across: 'across',
  Cells: 'cells',
  Unmerge: 'unmerge',
} as const;
export type MergeAction = typeof MergeAction[keyof typeof MergeAction];

/**
 * Merge or unmerge the selected areas as Excel does, as one undo step. Merging cells that hold
 * more than one value asks first (Univer's warning: only the top-left value is kept); declining
 * changes nothing. Resolves whether the workbook changed.
 */
export async function mergeSelection(univer: Univer, workbook: FWorkbook, action: MergeAction): Promise<boolean> {
  const sheet = workbook.getActiveSheet();
  const selection = sheet.getSelection();
  const ranges = (selection?.getActiveRangeList().length ? selection.getActiveRangeList() : [workbook.getActiveRange()])
    .filter((range): range is NonNullable<typeof range> => Boolean(range)).map(range => range.getRange());
  if (!ranges.length) return false;
  const injector = univer.__getInjector();
  const commands = injector.get(ICommandService);
  const target = { unitId: workbook.getId(), subUnitId: sheet.getSheetId() };
  if (action === MergeAction.Unmerge) return commands.executeCommand(RemoveWorksheetMergeCommand.id, { ...target, ranges });
  const group = injector.get(IUndoRedoService).beginUndoRedoGroup(target.unitId, `lobster-merge-${Date.now()}`, 'append');
  try {
    const single = ranges.every(range => range.startRow === range.endRow && range.startColumn === range.endColumn);
    // A single cell has nothing to merge; Merge & Center still centers it.
    const merged = single || await commands.executeCommand(AddWorksheetMergeCommand.id, {
      ...target, selections: ranges, defaultMerge: false, ...(action === MergeAction.Across ? { value: Dimension.ROWS } : {}),
    });
    if (!merged) return false;
    if (action === MergeAction.Center) await commands.executeCommand(SetHorizontalTextAlignCommand.id, { ...target, value: HorizontalAlign.CENTER });
    return !single || action === MergeAction.Center;
  } finally {
    group.dispose();
  }
}
