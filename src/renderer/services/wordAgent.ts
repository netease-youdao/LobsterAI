import { createServerAutomationHost } from '@docx-editor.dev/core/automation';

import { type WordAgentRequest, WordAgentTool, type WordAgentToolResult } from '../../shared/artifactPreview/wordAgent';
import { WordFileError } from '../../shared/artifactPreview/wordEditing';
import { store } from '../store';
import { openArtifactPreviewTab, selectSessionArtifacts } from '../store/slices/artifactSlice';
import { normalizeShellFilePath } from './shellAppsCache';
import { applyWordEdits, readWordDocument, type WordAgentEdit, WordAgentError } from './wordAgentOperations';
import { WordSaveState } from './wordDocument';
import { acquireWordEditor } from './wordEditorSession';

const reply = (value: unknown): WordAgentToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message: string): WordAgentToolResult => ({ ...reply(message), isError: true });

const OPEN_FAILURE: Record<string, string> = {
  [WordFileError.InvalidFile]: 'The file is not a valid .docx package.',
  [WordFileError.TooLarge]: 'The document exceeds the editor limits (25 MB file, 100 MB expanded).',
  [WordFileError.Unsupported]: 'The editor cannot open this document (encrypted, ZIP64 or damaged).',
  [WordFileError.Forbidden]: 'The Word editor refused this request.',
  [WordFileError.Io]: 'The file could not be read. Check that it exists and is accessible.',
};

/** One call at a time per document, so two agent turns never interleave rounds. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch((): void => undefined).then(operation);
  queues.set(key, current);
  void current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
  return current;
}

/** Show the document in the right-side panel when the current task already lists it. */
function revealInPanel(filePath: string): void {
  const state = store.getState();
  const sessionId = state.cowork.currentSessionId;
  if (!sessionId) return;
  const target = normalizeShellFilePath(filePath);
  const artifact = selectSessionArtifacts(state, sessionId)
    .find(item => item.filePath && normalizeShellFilePath(item.filePath) === target);
  if (artifact) store.dispatch(openArtifactPreviewTab({ sessionId, artifactId: artifact.id }));
}

const numberArg = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

async function run(request: WordAgentRequest): Promise<WordAgentToolResult> {
  const args = request.args ?? {};
  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!filePath || !/\.docx$/i.test(filePath)) return failure('"path" must be the absolute path of a .docx file.');
  const opened = await acquireWordEditor(filePath);
  if (!opened.success) return failure(OPEN_FAILURE[opened.code] ?? 'The document could not be opened.');
  const session = opened.value;
  revealInPanel(filePath);
  const state = session.document.getSnapshot();

  if (request.tool === WordAgentTool.Read) {
    const document = session.withAutomation(host => readWordDocument(host, { offset: numberArg(args.offset), limit: numberArg(args.limit) }));
    return reply({
      path: session.document.file.filePath,
      ...document,
      ...(state.readOnlyReasons.length ? { readOnly: state.readOnlyReasons } : {}),
      ...(session.selectionSummary() ? { selection: session.selectionSummary() } : {}),
    });
  }

  if (state.readOnlyReasons.length) {
    return failure(`This document opened read-only because it contains ${state.readOnlyReasons.join(', ')}. Edit a copy or ask the user to use Word/WPS.`);
  }
  if (state.needsResolution) return failure('LobsterAI is waiting for the user to choose between two versions of this document. Ask them to resolve it first.');
  const edits = Array.isArray(args.edits) ? args.edits as WordAgentEdit[] : [];
  const expectedRevision = numberArg(args.expectedRevision);
  const liveRevision = session.withAutomation(host => host.revision());
  if (expectedRevision !== undefined && expectedRevision !== liveRevision) {
    return failure(`The document changed since revision ${expectedRevision} (now ${liveRevision}); the user may have edited it. Call word_read again.`);
  }
  // Rehearse on a headless copy: a refusal must leave the visible document untouched.
  const copy = createServerAutomationHost(await session.save());
  if (!copy.ok) return failure(`The current document could not be copied for editing (${copy.reason}).`);
  try {
    applyWordEdits(copy.host, { edits });
  } catch (error) {
    if (error instanceof WordAgentError) return failure(`${error.message} Nothing was changed.`);
    throw error;
  } finally {
    copy.host.dispose();
  }
  const result = session.withAutomation(host => {
    if (host.revision() !== liveRevision) throw new WordAgentError('The user edited the document while the change was prepared. Call word_read again.');
    return applyWordEdits(host, { edits });
  });
  session.recordAgentEdit(result.commits);
  if (result.paragraphs[0]) session.reveal(result.paragraphs[0].id);
  await session.document.flush();
  return reply({ ...result, saved: !session.document.dirty && session.document.getSnapshot().status !== WordSaveState.Error });
}

export async function handleWordAgentRequest(request: WordAgentRequest): Promise<WordAgentToolResult> {
  const key = typeof request.args?.path === 'string' ? normalizeShellFilePath(request.args.path) : '';
  try {
    return await serial(key, () => run(request));
  } catch (error) {
    if (error instanceof WordAgentError) return failure(error.message);
    throw error;
  }
}
