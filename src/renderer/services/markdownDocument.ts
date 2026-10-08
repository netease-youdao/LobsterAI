import {
  type MarkdownFileApi,
  MarkdownFileError,
  type MarkdownFileSnapshot,
} from '../../shared/artifactPreview/markdownEditing';
import { installMarkdownDocumentLifecycle } from './markdownDocumentLifecycle';
import { normalizeShellFilePath } from './shellAppsCache';

export const MarkdownSaveState = {
  Loading: 'loading',
  Saved: 'saved',
  Pending: 'pending',
  Saving: 'saving',
  Error: 'error',
  Conflict: 'conflict',
} as const;
export type MarkdownSaveState = typeof MarkdownSaveState[keyof typeof MarkdownSaveState];

export interface MarkdownDocumentState {
  content: string;
  ready: boolean;
  status: MarkdownSaveState;
  errorCode?: MarkdownFileError;
  draftSafe: boolean;
  restored: boolean;
}

interface MarkdownDraft {
  content: string;
  baseVersion: string;
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const AUTOSAVE_DELAY_MS = 600;
const DRAFT_KEY_PREFIX = 'lobster:markdown-draft:v1:';

/** One document owns its save queue even while its React editor is unmounted. */
export class MarkdownDocument {
  private state: MarkdownDocumentState = {
    content: '', ready: false, status: MarkdownSaveState.Loading, draftSafe: true, restored: false,
  };
  private base?: MarkdownFileSnapshot;
  private expectedVersion = '';
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private writingContent?: string;
  private reading?: Promise<void>;

  constructor(
    readonly filePath: string,
    private api: MarkdownFileApi,
    private storage: () => DraftStorage,
    private onStateChange?: () => void,
  ) {}

  getSnapshot = (): MarkdownDocumentState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get dirty(): boolean {
    return Boolean(this.base && (this.state.content !== this.base.content
      || (this.writingContent !== undefined && this.state.content !== this.writingContent)));
  }

  get canEvict(): boolean {
    return this.state.ready && !this.dirty && !this.saving && !this.reading && this.listeners.size === 0;
  }

  private publish(update: Partial<MarkdownDocumentState>): void {
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener());
    this.onStateChange?.();
  }

  private persistDraft(): void {
    try {
      const key = DRAFT_KEY_PREFIX + this.filePath;
      if (this.dirty) {
        this.storage().setItem(key, JSON.stringify({
          content: this.state.content,
          baseVersion: this.expectedVersion,
        } satisfies MarkdownDraft));
      } else {
        this.storage().removeItem(key);
      }
      if (!this.state.draftSafe) this.publish({ draftSafe: true });
    } catch {
      this.publish({ draftSafe: false });
    }
  }

  private scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, AUTOSAVE_DELAY_MS);
  }

  setContent = (content: string): void => {
    if (!this.state.ready || content === this.state.content) return;
    const conflict = this.state.status === MarkdownSaveState.Conflict;
    this.publish({
      content,
      status: conflict ? MarkdownSaveState.Conflict : MarkdownSaveState.Pending,
      errorCode: conflict ? MarkdownFileError.Conflict : undefined,
    });
    // Synchronous draft persistence covers closing/crashing before the debounce fires.
    this.persistDraft();
    if (!conflict) this.scheduleSave();
  };

  refresh = (): Promise<void> => {
    if (this.reading) return this.reading;
    this.reading = this.readFromDisk().finally(() => { this.reading = undefined; });
    return this.reading;
  };

  private async readFromDisk(): Promise<void> {
    if (this.saving) await this.saving;
    const versionAtRead = this.base?.version;
    try {
      const result = await this.api.read(this.filePath);
      // A save completed (or started) during this read. Its snapshot is newer.
      if (this.saving || this.base?.version !== versionAtRead) return;
      if (!result.success) {
        this.publish({ status: MarkdownSaveState.Error, errorCode: result.code });
        return;
      }
      const file = result.file;
      if (!this.base) {
        this.base = file;
        this.expectedVersion = file.version;
        let draft: MarkdownDraft | undefined;
        try {
          const raw = this.storage().getItem(DRAFT_KEY_PREFIX + this.filePath);
          if (raw) {
            const parsed = JSON.parse(raw) as MarkdownDraft;
            if (typeof parsed.content === 'string' && typeof parsed.baseVersion === 'string') draft = parsed;
          }
        } catch {
          this.publish({ draftSafe: false });
        }
        if (draft && draft.content !== file.content) {
          this.expectedVersion = draft.baseVersion;
          const conflict = file.version !== draft.baseVersion;
          this.publish({
            content: draft.content, ready: true, restored: true,
            status: conflict ? MarkdownSaveState.Conflict : MarkdownSaveState.Pending,
            errorCode: conflict ? MarkdownFileError.Conflict : undefined,
          });
          if (!conflict) this.scheduleSave();
          return;
        }
      } else if (this.dirty && file.content !== this.state.content) {
        if (file.version !== this.expectedVersion) {
          this.publish({ status: MarkdownSaveState.Conflict, errorCode: MarkdownFileError.Conflict });
        }
        return;
      }
      if (this.state.ready && !this.dirty && file.version === this.base.version
        && this.state.status === MarkdownSaveState.Saved) return;
      this.base = file;
      this.writingContent = undefined;
      this.expectedVersion = file.version;
      this.publish({ content: file.content, ready: true, status: MarkdownSaveState.Saved, errorCode: undefined });
      this.persistDraft();
    } catch {
      this.publish({ status: MarkdownSaveState.Error, errorCode: MarkdownFileError.Io });
    }
  }

  flush = (): Promise<void> => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.saving) return this.saving;
    this.saving = this.saveChanges().finally(() => { this.saving = undefined; });
    return this.saving;
  };

  private async saveChanges(): Promise<void> {
    if (!this.base || this.state.status === MarkdownSaveState.Conflict) return;
    while (this.dirty) {
      const content = this.state.content;
      this.writingContent = content;
      this.publish({ status: MarkdownSaveState.Saving, errorCode: undefined });
      try {
        const result = await this.api.save({ filePath: this.filePath, content, expectedVersion: this.expectedVersion });
        if (!result.success) {
          this.publish({
            status: result.code === MarkdownFileError.Conflict ? MarkdownSaveState.Conflict : MarkdownSaveState.Error,
            errorCode: result.code,
          });
          return;
        }
        this.base = result.file;
        this.expectedVersion = result.file.version;
        this.writingContent = undefined;
        // A newer edit may have arrived while the previous write was in flight.
        this.persistDraft();
      } catch {
        this.publish({ status: MarkdownSaveState.Error, errorCode: MarkdownFileError.Io });
        return;
      }
    }
    this.publish({ status: MarkdownSaveState.Saved, errorCode: undefined });
    this.persistDraft();
  }

  /** Called only after the user has explicitly chosen which version to keep. */
  resolveConflict = async (keepMine: boolean): Promise<void> => {
    if (this.saving) await this.saving;
    try {
      const result = await this.api.read(this.filePath);
      if (!result.success) {
        this.publish({ errorCode: result.code });
        return;
      }
      this.base = result.file;
      this.writingContent = undefined;
      this.expectedVersion = result.file.version;
      this.publish({
        content: keepMine ? this.state.content : result.file.content,
        status: MarkdownSaveState.Pending, errorCode: undefined, restored: false,
      });
      this.persistDraft();
      await this.flush();
    } catch {
      this.publish({ errorCode: MarkdownFileError.Io });
    }
  };
}

export class MarkdownDocumentRegistry {
  private documents = new Map<string, MarkdownDocument>();
  private reportedUnsafe?: boolean;

  constructor(
    private createDocument: (filePath: string, onStateChange: () => void) => MarkdownDocument,
    private reportUnsafe: (hasUnsafeEdits: boolean) => void = () => {},
  ) {}

  hasUnsafeEdits = (): boolean => [...this.documents.values()]
    .some(document => document.dirty && !document.getSnapshot().draftSafe);

  private reportState = (): void => {
    const unsafe = this.hasUnsafeEdits();
    if (unsafe === this.reportedUnsafe) return;
    try {
      this.reportUnsafe(unsafe);
      this.reportedUnsafe = unsafe;
    } catch (error) {
      console.warn('[MarkdownDocument] failed to report unsaved edits:', error);
    }
  };

  get(filePath: string): MarkdownDocument {
    const normalizedPath = normalizeShellFilePath(filePath);
    if (this.documents.size >= 12) {
      for (const [key, cached] of this.documents) {
        if (key !== normalizedPath && cached.canEvict) this.documents.delete(key);
      }
    }
    let document = this.documents.get(normalizedPath);
    if (!document) {
      document = this.createDocument(normalizedPath, this.reportState);
      this.documents.set(normalizedPath, document);
      this.reportState();
    }
    return document;
  }

  getContent(filePath: string): string | undefined {
    const state = this.documents.get(normalizeShellFilePath(filePath))?.getSnapshot();
    return state?.ready ? state.content : undefined;
  }

  flush = async (): Promise<void> => {
    await Promise.all([...this.documents.values()].filter(document => document.dirty)
      .map(document => document.flush()));
  };
}

const documents = new MarkdownDocumentRegistry(
  (filePath, onStateChange) => new MarkdownDocument(filePath, {
    read: path => window.electron.artifact.markdown.read(path),
    save: request => window.electron.artifact.markdown.save(request),
  }, () => window.localStorage, onStateChange),
  unsafe => window.electron?.artifact?.markdown?.setHasUnsafeEdits?.(unsafe),
);
let disposeLifecycle: (() => void) | undefined;

export function getMarkdownDocument(filePath: string): MarkdownDocument {
  disposeLifecycle ??= installMarkdownDocumentLifecycle(window, documents);
  return documents.get(filePath);
}

/** Copy the live buffer, including empty and unsaved content, without opening a document. */
export const getMarkdownDocumentContent = (filePath: string): string | undefined => documents.getContent(filePath);

if (import.meta.hot) import.meta.hot.dispose(() => disposeLifecycle?.());
