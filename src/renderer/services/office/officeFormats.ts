import type { OfficeEditorId, OfficeEditorSpec } from '../../../shared/office/core/officeEditor';
import type { OfficeAgentRequest, OfficeAgentToolResult } from '../../../shared/office/core/officeFile';
import { type OfficeBridges, officeEditorForPath, SHEET_EDITOR, SLIDES_EDITOR, WORD_EDITOR } from '../../../shared/office/editors';

/** One editor's renderer side. Its engine loads on first use, so app startup does not pay for it. */
export interface RendererOfficeFormat {
  spec: OfficeEditorSpec;
  agentLogTag: string;
  loadAgent: () => Promise<(request: OfficeAgentRequest) => Promise<OfficeAgentToolResult>>;
  /** Reloads an open file from disk through its live editor; resolves false when it is not open. */
  loadRefresh: () => Promise<(filePath: string) => Promise<boolean>>;
}

/** The renderer side of every editor in OFFICE_EDITORS. */
export const RENDERER_OFFICE_FORMATS: readonly RendererOfficeFormat[] = [
  {
    spec: WORD_EDITOR,
    agentLogTag: '[WordAgent]',
    loadAgent: () => import('./word/wordAgent').then(module => module.handleWordAgentRequest),
    loadRefresh: () => import('./word/wordEditorSession').then(module => module.refreshOpenWordEditor),
  },
  {
    spec: SHEET_EDITOR,
    agentLogTag: '[SheetAgent]',
    loadAgent: () => import('./sheet/sheetAgent').then(module => module.handleSheetAgentRequest),
    loadRefresh: () => import('./sheet/sheetEditorSession').then(module => module.refreshOpenSheetEditor),
  },
  {
    spec: SLIDES_EDITOR,
    agentLogTag: '[SlidesAgent]',
    loadAgent: () => import('./slides/slidesAgent').then(module => module.handleSlidesAgentRequest),
    loadRefresh: () => import('./slides/slidesEditorSession').then(module => module.refreshOpenSlidesEditor),
  },
];

/** An editor's preload bridge; missing where the page runs outside the desktop app. */
export function officeBridge<TId extends OfficeEditorId>(id: TId): OfficeBridges[TId] | undefined {
  return window.electron?.artifact?.office?.[id];
}

/** The format of a file that has a live editor in this window, by extension. */
export function officeFormatForPath(filePath: string): RendererOfficeFormat | undefined {
  const editor = officeEditorForPath(filePath);
  return editor && officeBridge(editor.id) ? RENDERER_OFFICE_FORMATS.find(format => format.spec.id === editor.id) : undefined;
}

/** Answers agent tool calls from the main process with the live editors. */
export function installOfficeAgentBridges(): () => void {
  const stops = RENDERER_OFFICE_FORMATS.map(format => {
    const bridge = officeBridge(format.spec.id);
    if (!bridge?.onAgentRequest) return () => undefined;
    return bridge.onAgentRequest(request => {
      void format.loadAgent()
        .then(handle => handle(request))
        .catch((error: unknown): OfficeAgentToolResult => {
          console.error(`${format.agentLogTag} Tool call failed:`, error);
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: `The LobsterAI ${format.spec.editorName} editor failed: ${message}` }], isError: true };
        })
        .then(result => bridge.respondAgent({ requestId: request.requestId, result }));
    });
  });
  return () => { for (const stop of stops) stop(); };
}

/** Routes a panel refresh through the file's live editor; false when no editor has it open. */
export async function refreshOpenOfficeEditor(filePath: string): Promise<boolean> {
  const format = officeFormatForPath(filePath);
  if (!format) return false;
  const refresh = await format.loadRefresh();
  return refresh(filePath);
}
