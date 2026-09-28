import { type OfficeAgentRequest, type OfficeAgentToolResult, OfficeFileError } from '../../../shared/artifactPreview/officeEditing';
import { SheetAgentTool } from '../../../shared/artifactPreview/sheetAgent';
import { store } from '../../store';
import { openArtifactPreviewTab, selectSessionArtifacts } from '../../store/slices/artifactSlice';
import { OfficeSaveState } from '../officeDocument';
import { normalizeShellFilePath } from '../shellAppsCache';
import { applySheetEdits, formulaErrors, readSheet, SheetAgentError } from './sheetAgentOperations';
import { acquireSheetEditor } from './sheetEditorSession';
import { StructureRefusal } from './sheetStructureSupport';

const reply = (value: unknown): OfficeAgentToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message: string): OfficeAgentToolResult => ({ ...reply(message), isError: true });

const OPEN_FAILURE: Record<string, string> = {
  [OfficeFileError.InvalidFile]: 'The file is not a valid .xlsx workbook.',
  [OfficeFileError.TooLarge]: 'The workbook exceeds the editor limits (20 MB file, 500,000 stored cells).',
  [OfficeFileError.Unsupported]: 'The editor cannot open this workbook (encrypted, Strict Open XML, ZIP64 or damaged).',
  [OfficeFileError.Forbidden]: 'The Excel editor refused this request.',
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

/** One call at a time per workbook, so two agent turns never interleave. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch((): void => undefined).then(operation);
  queues.set(key, current);
  void current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
  return current;
}

/** Show the workbook in the right-side panel when the current task already lists it. */
function revealInPanel(filePath: string): void {
  const state = store.getState();
  const sessionId = state.cowork.currentSessionId;
  if (!sessionId) return;
  const target = normalizeShellFilePath(filePath);
  const artifact = selectSessionArtifacts(state, sessionId)
    .find(item => item.filePath && normalizeShellFilePath(item.filePath) === target);
  if (artifact) store.dispatch(openArtifactPreviewTab({ sessionId, artifactId: artifact.id }));
}

async function run(request: OfficeAgentRequest): Promise<OfficeAgentToolResult> {
  const args = request.args ?? {};
  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!filePath || !/\.xlsx$/i.test(filePath)) return failure('"path" must be the absolute path of a .xlsx file.');
  const opened = await acquireSheetEditor(filePath);
  if (!opened.success) return failure(OPEN_FAILURE[opened.code] ?? 'The workbook could not be opened.');
  const session = opened.value;
  revealInPanel(filePath);
  const { workbook, api } = session;
  if (!workbook || !api) return failure('The Excel editor is still opening this workbook; try again.');
  const state = session.document.getSnapshot();
  const hidden = session.document.packageInfo.hidden;

  if (request.tool === SheetAgentTool.Read) {
    await session.waitForCalculation();
    const result = readSheet(workbook, { sheet: args.sheet, range: args.range, maxCells: args.maxCells });
    const selection = session.selection();
    return reply({
      path: session.document.file.filePath,
      revision: session.document.currentRevision,
      ...result,
      ...(selection ? { selection } : {}),
      ...(state.readOnlyReasons.length ? { readOnly: state.readOnlyReasons } : {}),
      ...(hidden.length ? { keptButNotShown: hidden } : {}),
    });
  }

  if (state.readOnlyReasons.length) {
    return failure(`This workbook opened read-only because it contains ${state.readOnlyReasons.join(', ')}. Edit a copy with other tools or ask the user to use Excel/WPS.`);
  }
  if (state.needsResolution) return failure('LobsterAI is waiting for the user to choose between two versions of this workbook. Ask them to resolve it first.');
  const expectedRevision = typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined;
  const before = session.document.currentRevision;
  if (expectedRevision !== undefined && expectedRevision !== before) {
    return failure(`The workbook changed since revision ${expectedRevision} (now ${before}); the user may have edited it. Call excel_read again.`);
  }
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
    return failure(`${message} Nothing was changed.`);
  }
  await session.waitForCalculation();
  const errors = formulaErrors(workbook, result.changed);
  if (result.focus) session.reveal(result.focus.sheet, result.focus.range);
  await session.document.flush();
  const saved = session.document.getSnapshot();
  return reply({
    revision: session.document.currentRevision,
    applied: result.applied,
    changed: result.changed,
    saved: !session.document.dirty && saved.status !== OfficeSaveState.Error,
    ...(saved.issue ? { saveProblem: `The edits are in the editor but cannot be written to the file (${saved.issue}). Undo them or adjust the change.` } : {}),
    ...(Object.keys(errors).length ? { formulaErrors: errors } : {}),
  });
}

export async function handleSheetAgentRequest(request: OfficeAgentRequest): Promise<OfficeAgentToolResult> {
  const key = typeof request.args?.path === 'string' ? normalizeShellFilePath(request.args.path) : '';
  try {
    return await serial(key, () => run(request));
  } catch (error) {
    if (error instanceof SheetAgentError) return failure(error.message);
    throw error;
  }
}
