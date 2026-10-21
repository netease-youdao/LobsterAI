import {
  type OfficeFileBridge, OfficeFileError, type OfficeOpenResult, type OfficePackageInfo, type OfficeResult,
} from '../../../../shared/office/core/officeFile';
import { installDocumentLifecycle } from '../../documentLifecycle';
import { normalizeShellFilePath } from '../../shellAppsCache';
import type { OfficeEditorSession, OfficeSessionContext } from './officeEditorSession';

export interface OfficeEditorRegistryOptions<TInfo extends OfficePackageInfo, TSession extends OfficeEditorSession<TInfo>> {
  bridge: () => OfficeFileBridge<TInfo>;
  create: (file: OfficeOpenResult<TInfo>, context: OfficeSessionContext<TInfo>) => TSession;
  /** Idle sessions kept open for switching back quickly; more are closed, least recently opened first. */
  maxCachedSessions: number;
  /** Log tag such as `[SheetEditor]`. */
  logTag: string;
  /** The calling module's hot context and a key in it, so the registry survives development updates. */
  hot: ImportMeta['hot'];
  hotKey: string;
}

export interface OfficeEditorRegistry<TSession> {
  /** The live session of a file, opening it on first use; concurrent calls share one open. */
  acquire: (filePath: string) => Promise<OfficeResult<TSession>>;
  /** Reloads an open file from disk through its session instead of replacing it; false when not open. */
  refresh: (filePath: string) => Promise<boolean>;
}

interface RegistryState<TSession> {
  /** Sessions by file handle. */
  sessions: Map<string, TSession>;
  /** Opens by normalized path, including links to the same file. */
  paths: Map<string, Promise<OfficeResult<TSession>>>;
  parking?: HTMLDivElement;
  disposeLifecycle?: () => void;
  disposeChanges?: () => void;
  reportedUnsafe: boolean;
}

/**
 * Keeps one live editor per open file of a format: handles, the offscreen parking area, exit
 * protection, external-change refreshes and eviction of idle editors.
 */
export function createOfficeEditorRegistry<TInfo extends OfficePackageInfo, TSession extends OfficeEditorSession<TInfo>>(
  options: OfficeEditorRegistryOptions<TInfo, TSession>,
): OfficeEditorRegistry<TSession> {
  const { logTag } = options;
  // Handles, hosts, listeners and exit protection stay together across development updates;
  // a new registry could open a second model of the same file.
  const state: RegistryState<TSession> = options.hot?.data[options.hotKey] ?? { sessions: new Map(), paths: new Map(), reportedUnsafe: false };
  const { sessions, paths } = state;

  const parking = (): HTMLDivElement => {
    if (!state.parking) {
      const element = document.createElement('div');
      element.style.cssText = 'position:fixed;left:-100000px;top:0;width:1000px;height:800px;visibility:hidden;pointer-events:none;';
      element.setAttribute('aria-hidden', 'true');
      element.inert = true;
      document.body.appendChild(element);
      state.parking = element;
    }
    return state.parking;
  };

  const hasUnsafeEdits = (): boolean => [...sessions.values()].some(session => session.document.unsafe);
  const reportState = (): void => {
    const unsafe = hasUnsafeEdits();
    if (unsafe === state.reportedUnsafe) return;
    try {
      options.bridge().setHasUnsafeEdits(unsafe);
      state.reportedUnsafe = unsafe;
    } catch (error) {
      console.warn(`${logTag} Could not report unsaved edits:`, error);
    }
  };

  const evictIdleSessions = (): void => {
    for (const [id, session] of sessions) {
      if (sessions.size <= options.maxCachedSessions) break;
      if (session.mounted || session.document.dirty || session.document.busy) continue;
      session.dispose();
      sessions.delete(id);
      for (const alias of session.aliases) paths.delete(alias);
    }
  };
  // Views mount and unmount editors while React commits; disposing an editor then could unmount
  // its own React root mid-commit, so eviction runs afterwards.
  const scheduleEviction = (): void => { setTimeout(evictIdleSessions, 0); };

  const open = async (filePath: string): Promise<OfficeResult<TSession>> => {
    const bridge = options.bridge();
    const opened = await bridge.open(filePath);
    if (!opened.success) return opened;
    let session = sessions.get(opened.value.sessionId);
    if (!session) {
      session = options.create(opened.value, { bridge, parking: parking(), reportState, scheduleEviction });
      sessions.set(opened.value.sessionId, session);
    }
    await session.initialize();
    session.aliases.add(filePath);
    const snapshot = session.document.getSnapshot();
    if (!snapshot.ready) {
      session.dispose();
      sessions.delete(opened.value.sessionId);
      return { success: false, code: snapshot.errorCode ?? OfficeFileError.Unsupported };
    }
    return { success: true, value: session };
  };

  const acquire = (filePath: string): Promise<OfficeResult<TSession>> => {
    state.disposeChanges ??= options.bridge().onChanged(sessionId => {
      void sessions.get(sessionId)?.document.refresh();
    });
    state.disposeLifecycle ??= installDocumentLifecycle(window, {
      hasUnsafeEdits,
      flush: async () => { await Promise.all([...sessions.values()].map(session => session.document.flush())); },
    });
    const normalized = normalizeShellFilePath(filePath);
    let pending = paths.get(normalized);
    if (!pending) {
      pending = open(normalized).catch(error => {
        console.error(`${logTag} Could not open file:`, error);
        return { success: false, code: OfficeFileError.Io } as const;
      });
      paths.set(normalized, pending);
      void pending.then(result => { if (!result.success) paths.delete(normalized); });
    }
    return pending;
  };

  const refresh = async (filePath: string): Promise<boolean> => {
    const pending = paths.get(normalizeShellFilePath(filePath));
    if (!pending) return false;
    const result = await pending;
    if (!result.success) return false;
    await result.value.document.refresh();
    return true;
  };

  if (options.hot) {
    options.hot.data[options.hotKey] = state;
    options.hot.dispose(() => {
      for (const session of sessions.values()) void session.document.flush();
    });
  }
  return { acquire, refresh };
}
