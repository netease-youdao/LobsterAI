import type { FUniver } from '@univerjs/core/facade';
import type { FWorkbook } from '@univerjs/sheets/facade';

import { OfficeFileError } from '../../../../shared/office/core/officeFile';
import { SHEET_EDITOR } from '../../../../shared/office/editors';
import { SheetAgentTool } from '../../../../shared/office/sheet/sheetAgent';
import { agentFailure, agentReply, agentSaveOutcome, createOfficeAgentHandler } from '../core/officeAgentRunner';
import { applySheetEdits, formulaErrors, readSheet, SheetAgentError } from './sheetAgentOperations';
import { acquireSheetEditor, type SheetEditorSession } from './sheetEditorSession';
import { StructureRefusal } from './sheetStructureSupport';

const LOCKING_APPS = 'Excel or WPS';

const OPEN_FAILURE: Record<string, string> = {
  [OfficeFileError.InvalidFile]: 'The file is not a valid .xlsx workbook.',
  [OfficeFileError.TooLarge]: 'The workbook exceeds the editor limits (20 MB file, 500,000 stored cells).',
  [OfficeFileError.Unsupported]: 'The editor cannot open this workbook (encrypted, Strict Open XML, ZIP64 or damaged).',
  [OfficeFileError.Forbidden]: 'The Excel editor refused this request.',
  [OfficeFileError.InUse]: `The workbook is open in another program (such as ${LOCKING_APPS}) that locks it. Ask the user to close it there, then try again.`,
  [OfficeFileError.Io]: 'The file could not be read. Check that it exists and is accessible.',
};

/** Why the editor refused a structural edit, in words the agent can act on. */
const REFUSAL_TEXT: Record<StructureRefusal, string> = {
  [StructureRefusal.Unsupported]: 'this operation cannot be saved to the .xlsx file yet',
  [StructureRefusal.FormControls]: 'the sheet has form controls, so rows and columns cannot be inserted or deleted here; ask the user to do it in Excel or WPS',
  [StructureRefusal.UnsupportedContent]: 'the sheet has scenarios, custom views or embedded objects, so rows and columns cannot be inserted or deleted here',
  [StructureRefusal.ThreeDimensionalReferences]: 'the workbook has references across sheets (Sheet1:Sheet3!A1), so rows, columns and sheet order cannot change here',
  [StructureRefusal.TableColumns]: 'an Excel table must keep at least one column, so all of its columns cannot be deleted',
  [StructureRefusal.TableColumnInUse]: 'formulas use the table columns being deleted by name; change those formulas first',
  [StructureRefusal.TableRows]: 'an Excel table must keep its header row and at least one data row',
  [StructureRefusal.CopyWithContent]: 'the sheet has tables, shapes, links on numbers or extended content that a copy would lose',
  [StructureRefusal.TableInUse]: 'formulas on other sheets use a table on this sheet',
  [StructureRefusal.SortAttachments]: 'the range has hyperlinks on numbers or formulas, which the editor keeps in the file but cannot move with sorted cells',
  [StructureRefusal.ImageEdit]: 'grouping, cropping, flipping and restacking pictures, and pictures inside cells, cannot be saved yet',
  [StructureRefusal.ChartData]: 'the selected cells have no numbers to chart',
  [StructureRefusal.ImageFormat]: 'pictures can be saved only as PNG, JPEG, GIF or BMP',
};

/** The live workbook; a call that arrives while it is still opening is refused. */
function liveWorkbook(session: SheetEditorSession): { workbook: FWorkbook; api: FUniver } {
  const { workbook, api } = session;
  if (!workbook || !api) throw new SheetAgentError('The Excel editor is still opening this workbook; try again.');
  return { workbook, api };
}

export const handleSheetAgentRequest = createOfficeAgentHandler<SheetEditorSession>({
  editor: SHEET_EDITOR,
  tools: { read: SheetAgentTool.Read, edit: SheetAgentTool.Edit },
  noun: 'workbook',
  desktopApps: 'Excel/WPS',
  lockingApps: LOCKING_APPS,
  openFailures: OPEN_FAILURE,
  acquire: acquireSheetEditor,
  isRefusal: (error): error is SheetAgentError => error instanceof SheetAgentError,
  revision: session => session.document.currentRevision,

  read: async (session, args) => {
    const { workbook } = liveWorkbook(session);
    await session.waitForCalculation();
    const state = session.document.getSnapshot();
    const hidden = session.document.packageInfo.hidden;
    const result = readSheet(workbook, { sheet: args.sheet, range: args.range, maxCells: args.maxCells });
    const selection = session.selection();
    return {
      path: session.document.file.filePath,
      revision: session.document.currentRevision,
      ...result,
      ...(selection ? { selection } : {}),
      ...(state.readOnlyReasons.length ? { readOnly: state.readOnlyReasons } : {}),
      ...(hidden.length ? { keptButNotShown: hidden } : {}),
    };
  },

  edit: async (session, args, before) => {
    const { workbook, api } = liveWorkbook(session);
    let result: ReturnType<typeof applySheetEdits>;
    try {
      const refusedBefore = session.lastRefusal;
      result = await session.asUndoGroup(async () => applySheetEdits(workbook, api, args.edits, {
        mdw: session.maxDigitWidth,
        refusal: () => (session.lastRefusal !== refusedBefore ? REFUSAL_TEXT[session.lastRefusalReason] : undefined),
      }));
    } catch (error) {
      // Validation fails before anything changes; a failure while applying is rolled back as one step.
      const applied = session.document.currentRevision !== before;
      if (applied) await session.undoLast();
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof SheetAgentError)) console.warn('[SheetAgent] Applying edits failed:', error);
      return agentFailure(`${message} Nothing was changed.`);
    }
    await session.waitForCalculation();
    const errors = formulaErrors(workbook, result.changed);
    if (result.focus) session.reveal(result.focus.sheet, result.focus.range);
    await session.document.flush();
    const saved = session.document.getSnapshot();
    return agentReply({
      revision: session.document.currentRevision,
      applied: result.applied,
      changed: result.changed,
      ...agentSaveOutcome(session.document, LOCKING_APPS),
      ...(saved.issue ? { saveProblem: `The edits are in the editor but cannot be written to the file (${saved.issue}). Undo them or adjust the change.` } : {}),
      ...(Object.keys(errors).length ? { formulaErrors: errors } : {}),
    });
  },
});
