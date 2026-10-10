import { createServerAutomationHost } from '@docx-editor.dev/core/automation';

import { OfficeFileError } from '../../../../shared/office/core/officeFile';
import { WORD_EDITOR } from '../../../../shared/office/editors';
import { WordAgentTool } from '../../../../shared/office/word/wordAgent';
import { agentFailure, agentReply, agentSaveOutcome, createOfficeAgentHandler, numberArg } from '../core/officeAgentRunner';
import { applyWordEdits, readWordDocument, type WordAgentEdit, WordAgentError } from './wordAgentOperations';
import { acquireWordEditor, type WordEditorSession } from './wordEditorSession';

const LOCKING_APPS = 'Word or WPS';

const OPEN_FAILURE: Record<string, string> = {
  [OfficeFileError.InvalidFile]: 'The file is not a valid .docx package.',
  [OfficeFileError.TooLarge]: 'The document exceeds the editor limits (25 MB file, 100 MB expanded).',
  [OfficeFileError.Unsupported]: 'The editor cannot open this document (encrypted, ZIP64 or damaged).',
  [OfficeFileError.Forbidden]: 'The Word editor refused this request.',
  [OfficeFileError.InUse]: `The document is open in another program (such as ${LOCKING_APPS}) that locks it. Ask the user to close it there, then try again.`,
  [OfficeFileError.Io]: 'The file could not be read. Check that it exists and is accessible.',
};

export const handleWordAgentRequest = createOfficeAgentHandler<WordEditorSession>({
  editor: WORD_EDITOR,
  tools: { read: WordAgentTool.Read, edit: WordAgentTool.Edit },
  noun: 'document',
  desktopApps: 'Word/WPS',
  lockingApps: LOCKING_APPS,
  openFailures: OPEN_FAILURE,
  acquire: acquireWordEditor,
  isRefusal: (error): error is WordAgentError => error instanceof WordAgentError,
  revision: session => session.withAutomation(host => host.revision()),

  read: (session, args) => {
    const state = session.document.getSnapshot();
    const document = session.withAutomation(host => readWordDocument(host, { offset: numberArg(args.offset), limit: numberArg(args.limit) }));
    const selection = session.selectionSummary();
    return {
      path: session.document.file.filePath,
      ...document,
      ...(state.readOnlyReasons.length ? { readOnly: state.readOnlyReasons } : {}),
      ...(selection ? { selection } : {}),
    };
  },

  edit: async (session, args, revision) => {
    const edits = Array.isArray(args.edits) ? args.edits as WordAgentEdit[] : [];
    // Rehearse on a headless copy: a refusal must leave the visible document untouched.
    const copy = createServerAutomationHost(await session.save());
    if (!copy.ok) return agentFailure(`The current document could not be copied for editing (${copy.reason}).`);
    try {
      applyWordEdits(copy.host, { edits });
    } catch (error) {
      if (error instanceof WordAgentError) return agentFailure(`${error.message} Nothing was changed.`);
      throw error;
    } finally {
      copy.host.dispose();
    }
    const result = session.withAutomation(host => {
      if (host.revision() !== revision) throw new WordAgentError(`The user edited the document while the change was prepared. Call ${WordAgentTool.Read} again.`);
      return applyWordEdits(host, { edits });
    });
    session.recordAgentEdit(result.commits);
    if (result.paragraphs[0]) session.reveal(result.paragraphs[0].id);
    await session.document.flush();
    return agentReply({ ...result, ...agentSaveOutcome(session.document, LOCKING_APPS) });
  },
});
