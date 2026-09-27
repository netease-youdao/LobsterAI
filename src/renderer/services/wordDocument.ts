import {
  type WordFileApi, WordFileError, type WordOpenResult, type WordPackageInfo, type WordReadOnlyReason, type WordWriteRequest,
} from '../../shared/artifactPreview/wordEditing';

export const WordSaveState = {
  Loading: 'loading', Saved: 'saved', Pending: 'pending', Saving: 'saving',
  Conflict: 'conflict', Error: 'error',
} as const;
export type WordSaveState = typeof WordSaveState[keyof typeof WordSaveState];

export interface WordDocumentState {
  ready: boolean;
  status: WordSaveState;
  errorCode?: WordFileError;
  draftSafe: boolean;
  restored: boolean;
  needsResolution: boolean;
  originalCopyPath?: string;
  /** Review, protected or embedded content keeps the document in viewing mode. */
  readOnlyReasons: WordReadOnlyReason[];
}

export interface WordEditorPort {
  load: (bytes: Uint8Array) => Promise<void>;
  save: () => Promise<Uint8Array>;
  setReadOnly: (readOnly: boolean) => void;
}

const AUTOSAVE_DELAY_MS = 700;

/** A document owns its revisions and save queue independently of the React view. */
export class WordDocument {
  private state: WordDocumentState = {
    ready: false, status: WordSaveState.Loading, draftSafe: true, restored: false, needsResolution: false, readOnlyReasons: [],
  };
  /** Admission facts for the bytes currently shown: read-only reasons and declared fonts. */
  packageInfo: WordPackageInfo;
  private listeners = new Set<() => void>();
  private revision: number;
  private savedRevision: number;
  private durableRevision: number;
  private baseVersion: string;
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private refreshing?: Promise<void>;
  private loading = false;
  private resolving = false;
  private disposed = false;

  constructor(
    readonly file: WordOpenResult,
    private readonly api: WordFileApi,
    private readonly editor: WordEditorPort,
    private readonly onStateChange: () => void = () => undefined,
  ) {
    this.revision = file.recovery?.revision ?? 0;
    this.savedRevision = file.recovery ? this.revision - 1 : this.revision;
    this.durableRevision = this.revision;
    this.baseVersion = file.recovery?.baseVersion ?? file.version;
    this.state.needsResolution = Boolean(file.recovery);
    this.packageInfo = { readOnly: file.readOnly, fonts: file.fonts };
    this.state.readOnlyReasons = file.readOnly;
  }

  get locked(): boolean { return this.packageInfo.readOnly.length > 0; }

  private adopt(info: WordPackageInfo): void {
    this.packageInfo = { readOnly: info.readOnly, fonts: info.fonts };
  }

  getSnapshot = (): WordDocumentState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get dirty(): boolean { return this.revision !== this.savedRevision; }
  get unsafe(): boolean { return this.revision > this.durableRevision; }
  get busy(): boolean { return this.loading || this.resolving || Boolean(this.saving || this.refreshing); }

  private publish(update: Partial<WordDocumentState>): void {
    this.state = { ...this.state, ...update, draftSafe: !this.unsafe };
    this.listeners.forEach(listener => listener());
    this.onStateChange();
  }

  async initialize(): Promise<void> {
    this.loading = true;
    try {
      await this.editor.load(this.file.recovery?.bytes ?? this.file.bytes);
      this.editor.setReadOnly(this.locked);
      const restored = Boolean(this.file.recovery);
      // Recovery is shown for an explicit choice. Opening a file must never overwrite it.
      this.publish({ ready: true, restored, status: restored ? WordSaveState.Conflict : WordSaveState.Saved,
        readOnlyReasons: this.packageInfo.readOnly });
    } catch (error) {
      console.warn('[WordDocument] Could not initialize editor:', error);
      this.publish({ status: WordSaveState.Error, errorCode: WordFileError.Unsupported });
    } finally {
      this.loading = false;
    }
  }

  changed = (): void => {
    if (this.loading || this.disposed) return;
    this.revision++;
    this.publish({
      status: this.state.needsResolution ? WordSaveState.Conflict : WordSaveState.Pending,
      errorCode: undefined,
    });
    this.schedule();
  };

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, AUTOSAVE_DELAY_MS);
  }

  private async capture(): Promise<WordWriteRequest | undefined> {
    const revision = this.revision;
    const bytes = await this.editor.save();
    // The engine may await pending image/input work. Never label a later export as an
    // earlier revision, nor mark edits arriving during that await as saved.
    if (revision !== this.revision) return undefined;
    return { sessionId: this.file.sessionId, bytes, baseVersion: this.baseVersion, revision };
  }

  flush = (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    if (!this.state.ready || !this.dirty || this.loading || this.resolving || this.disposed) return Promise.resolve();
    this.saving = this.saveLoop().finally(() => {
      this.saving = undefined;
      this.onStateChange();
    });
    return this.saving;
  };

  private async saveLoop(): Promise<void> {
    try {
      while (this.dirty) {
        const checkpoint = await this.capture();
        if (!checkpoint) { this.schedule(); return; }
        const draft = await this.api.checkpoint(checkpoint);
        if (!draft.success) {
          this.publish({ status: WordSaveState.Error, errorCode: draft.code });
          return;
        }
        this.durableRevision = checkpoint.revision;
        this.publish({});
        if (this.state.needsResolution) {
          this.publish({ status: WordSaveState.Conflict, errorCode: undefined });
          if (this.unsafe) continue;
          return;
        }
        this.publish({ status: WordSaveState.Saving });
        const result = await this.api.save(checkpoint);
        if (!result.success) {
          const conflicted = result.code === WordFileError.Conflict;
          this.publish({ status: conflicted ? WordSaveState.Conflict : WordSaveState.Error, errorCode: result.code,
            needsResolution: conflicted || this.state.needsResolution });
          // A newer edit still needs a recovery checkpoint even when this save conflicts.
          if (this.unsafe) this.schedule();
          return;
        }
        this.baseVersion = result.value.version;
        this.savedRevision = checkpoint.revision;
        this.publish({ status: this.dirty ? WordSaveState.Pending : WordSaveState.Saved, errorCode: undefined,
          restored: false, originalCopyPath: result.value.originalCopyPath ?? this.state.originalCopyPath });
      }
    } catch (error) {
      console.error('[WordDocument] Could not save document:', error);
      this.publish({ status: WordSaveState.Error, errorCode: WordFileError.Io });
    }
  }

  refresh = (): Promise<void> => {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshFromDisk().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  };

  private async refreshFromDisk(): Promise<void> {
    if (!this.state.ready || this.loading || this.resolving || this.disposed) return;
    await this.saving;
    // Most refreshes follow our own saves or window focus and find nothing new; only a real
    // reload locks the editor and releases it again.
    let reloading = false;
    try {
      const baseVersion = this.baseVersion;
      const result = await this.api.read(this.file.sessionId);
      // A slow read may arrive after a newer save receipt. It cannot roll the
      // visible model back to the snapshot preceding that save.
      if (baseVersion !== this.baseVersion) return;
      if (!result.success) {
        this.publish({ status: WordSaveState.Error, errorCode: result.code });
        return;
      }
      if (result.value.version === this.baseVersion) return;
      if (this.dirty) {
        this.publish({ status: WordSaveState.Conflict, needsResolution: true });
        void this.flush();
        return;
      }
      this.loading = true;
      reloading = true;
      this.editor.setReadOnly(true);
      this.adopt(result.value);
      await this.editor.load(result.value.bytes);
      this.baseVersion = result.value.version;
      this.publish({ status: WordSaveState.Saved, errorCode: undefined, readOnlyReasons: this.packageInfo.readOnly });
    } catch (error) {
      console.warn('[WordDocument] Could not refresh document:', error);
      this.publish({ status: WordSaveState.Error, errorCode: WordFileError.Io });
    } finally {
      this.loading = false;
      if (reloading) this.editor.setReadOnly(this.locked);
    }
  }

  /** Explicitly approved by the user after showing the conflict/recovery choices. */
  async resolveConflict(keepMine: boolean): Promise<void> {
    if (this.resolving || this.loading || !this.state.ready) return;
    this.resolving = true;
    clearTimeout(this.timer);
    this.editor.setReadOnly(true);
    try {
      await this.saving;
      await this.refreshing;
      const current = await this.api.read(this.file.sessionId);
      if (!current.success) {
        this.publish({ status: WordSaveState.Conflict, errorCode: current.code });
        return;
      }
      if (!keepMine) {
        this.loading = true;
        this.adopt(current.value);
        await this.editor.load(current.value.bytes);
        this.revision++;
        this.savedRevision = this.revision;
        this.durableRevision = this.revision;
        const discarded = await this.api.discardDraft(this.file.sessionId);
        if (!discarded.success) {
          this.publish({ status: WordSaveState.Error, errorCode: discarded.code });
          return;
        }
      }
      this.baseVersion = current.value.version;
      this.publish({ status: keepMine ? WordSaveState.Pending : WordSaveState.Saved,
        restored: false, needsResolution: false, errorCode: undefined, readOnlyReasons: this.packageInfo.readOnly });
    } catch (error) {
      console.error('[WordDocument] Could not resolve document conflict:', error);
      this.publish({ status: WordSaveState.Conflict, errorCode: WordFileError.Io });
    } finally {
      this.loading = false;
      this.resolving = false;
      this.editor.setReadOnly(this.locked);
    }
    if (keepMine) await this.flush();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposed = true;
  }
}
