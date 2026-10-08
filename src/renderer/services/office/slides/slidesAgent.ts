import { OfficeFileError } from '../../../../shared/office/core/officeFile';
import { SLIDES_EDITOR } from '../../../../shared/office/editors';
import { SlidesAgentTool } from '../../../../shared/office/slides/slidesAgent';
import { agentFailure, agentReply, createOfficeAgentHandler } from '../core/officeAgentRunner';
import { OfficeSaveState } from '../core/officeDocument';
import { SlidesEditError } from './slidesDeck';
import { acquireSlidesEditor, type SlidesEditorSession } from './slidesEditorSession';

const OPEN_FAILURE: Record<string, string> = {
  [OfficeFileError.InvalidFile]: 'The file is not a valid .pptx presentation.',
  [OfficeFileError.TooLarge]: 'The presentation exceeds the editor limits (80 MB file, 400 MB expanded).',
  [OfficeFileError.Unsupported]: 'The editor cannot open this presentation (encrypted, Strict Open XML, ZIP64 or damaged).',
  [OfficeFileError.Forbidden]: 'The PowerPoint editor refused this request.',
  [OfficeFileError.Io]: 'The file could not be read. Check that it exists and is accessible.',
};

export const handleSlidesAgentRequest = createOfficeAgentHandler<SlidesEditorSession>({
  editor: SLIDES_EDITOR,
  tools: { read: SlidesAgentTool.Read, edit: SlidesAgentTool.Edit },
  noun: 'presentation',
  desktopApps: 'PowerPoint/WPS/Keynote',
  openFailures: OPEN_FAILURE,
  acquire: acquireSlidesEditor,
  isRefusal: (error): error is SlidesEditError => error instanceof SlidesEditError,
  revision: session => session.document.currentRevision,

  read: (session, args) => {
    const state = session.document.getSnapshot();
    const slides = session.agentRead(args);
    return {
      path: session.document.file.filePath,
      revision: session.document.currentRevision,
      ...slides,
      ...(state.readOnlyReasons.length ? { readOnly: state.readOnlyReasons } : {}),
    };
  },

  edit: async (session, args, revision) => {
    let result: ReturnType<SlidesEditorSession['applyAgentEdits']>;
    try {
      result = session.applyAgentEdits(args.edits, revision);
    } catch (error) {
      if (error instanceof SlidesEditError) return agentFailure(`${error.message} Nothing was changed.`);
      throw error;
    }
    await session.document.flush();
    return agentReply({
      ...result,
      revision: session.document.currentRevision,
      saved: !session.document.dirty && session.document.getSnapshot().status !== OfficeSaveState.Error,
    });
  },
});
