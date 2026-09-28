import type { OfficeEditorSpec } from '../../../../shared/office/core/officeEditor';
import type { OfficeAgentRequest, OfficeAgentToolResult, OfficePackageInfo, OfficeResult } from '../../../../shared/office/core/officeFile';
import { store } from '../../../store';
import { openArtifactPreviewTab, selectSessionArtifacts } from '../../../store/slices/artifactSlice';
import { normalizeShellFilePath } from '../../shellAppsCache';
import type { OfficeEditorSession } from './officeEditorSession';

export const agentReply = (value: unknown): OfficeAgentToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
export const agentFailure = (message: string): OfficeAgentToolResult => ({ ...agentReply(message), isError: true });

/** A finite number argument, or undefined. */
export const numberArg = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** How one format answers its agent tools. */
export interface OfficeAgentAdapter<TSession> {
  editor: OfficeEditorSpec;
  tools: { read: string; edit: string };
  /** What the agent calls an open file, e.g. `workbook`. */
  noun: string;
  /** Desktop apps to suggest for files that open read only, e.g. `Excel/WPS`. */
  desktopApps: string;
  /** Answers for files that cannot be opened, by error code. */
  openFailures: Partial<Record<string, string>>;
  acquire: (filePath: string) => Promise<OfficeResult<TSession>>;
  /** Errors a call is refused with; their message is the answer. Anything else is a failure of the editor. */
  isRefusal: (error: unknown) => error is Error;
  /** The revision edits must name, as the read tool reports it. */
  revision: (session: TSession) => number;
  read: (session: TSession, args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Applies checked edits; `revision` is the one the agent named. */
  edit: (session: TSession, args: Record<string, unknown>, revision: number) => Promise<OfficeAgentToolResult>;
}

/** Show the file in the right-side panel when the current task already lists it. */
function revealInPanel(filePath: string): void {
  const state = store.getState();
  const sessionId = state.cowork.currentSessionId;
  if (!sessionId) return;
  const target = normalizeShellFilePath(filePath);
  const artifact = selectSessionArtifacts(state, sessionId)
    .find(item => item.filePath && normalizeShellFilePath(item.filePath) === target);
  if (artifact) store.dispatch(openArtifactPreviewTab({ sessionId, artifactId: artifact.id }));
}

/**
 * Answers a format's agent tool calls against the live editor: one call at a time per file (two
 * agent turns never interleave), the file shown in the panel, and the checks every edit passes
 * before it reaches the document.
 */
export function createOfficeAgentHandler<TSession extends OfficeEditorSession<OfficePackageInfo>>(
  adapter: OfficeAgentAdapter<TSession>,
): (request: OfficeAgentRequest) => Promise<OfficeAgentToolResult> {
  const { editor, tools, noun } = adapter;
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch((): void => undefined).then(operation);
    queues.set(key, current);
    void current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
    return current;
  };

  const run = async (request: OfficeAgentRequest): Promise<OfficeAgentToolResult> => {
    if (request.tool !== tools.read && request.tool !== tools.edit) return agentFailure(`Unknown ${editor.editorName} tool "${request.tool}".`);
    const args = request.args ?? {};
    const filePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!filePath.toLowerCase().endsWith(editor.extension)) return agentFailure(`"path" must be the absolute path of a ${editor.extension} file.`);
    const opened = await adapter.acquire(filePath);
    if (!opened.success) return agentFailure(adapter.openFailures[opened.code] ?? `The ${noun} could not be opened.`);
    const session = opened.value;
    revealInPanel(filePath);
    if (request.tool === tools.read) return agentReply(await adapter.read(session, args));

    const state = session.document.getSnapshot();
    if (state.readOnlyReasons.length) {
      return agentFailure(`This ${noun} opened read-only because it contains ${state.readOnlyReasons.join(', ')}. Edit a copy with other tools or ask the user to use ${adapter.desktopApps}.`);
    }
    if (state.needsResolution) return agentFailure(`LobsterAI is waiting for the user to choose between two versions of this ${noun}. Ask them to resolve it first.`);
    const revision = adapter.revision(session);
    const expected = numberArg(args.expectedRevision);
    if (expected !== undefined && expected !== revision) {
      return agentFailure(`The ${noun} changed since revision ${expected} (now ${revision}); the user may have edited it. Call ${tools.read} again.`);
    }
    return adapter.edit(session, args, revision);
  };

  return async request => {
    const key = typeof request.args?.path === 'string' ? normalizeShellFilePath(request.args.path) : '';
    try {
      return await serial(key, () => run(request));
    } catch (error) {
      if (adapter.isRefusal(error)) return agentFailure(error.message);
      throw error;
    }
  };
}
