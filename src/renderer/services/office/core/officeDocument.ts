import {
  type OfficeFileApi, OfficeFileError, type OfficeFileSnapshot, type OfficeOpenResult, type OfficePackageInfo, type OfficeWriteRequest,
} from '../../../../shared/office/core/officeFile';

/**
 * Revisions, recovery drafts, saving and external-change arbitration for one open Office file,
 * independent of the React view and of the format.
 */

export const OfficeSaveState = {
  Loading: 'loading', Saved: 'saved', Pending: 'pending', Saving: 'saving',
  Conflict: 'conflict', Error: 'error',
} as const;
export type OfficeSaveState = typeof OfficeSaveState[keyof typeof OfficeSaveState];

export interface OfficeDocumentState<TReason extends string = string> {
  ready: boolean;
  status: OfficeSaveState;
  errorCode?: OfficeFileError;
  /** Why the editor refused to export, e.g. an edit the file format writer cannot represent. */
  issue?: string;
  draftSafe: boolean;
  restored: boolean;
  needsResolution: boolean;
  originalCopyPath?: string;
  readOnlyReasons: TReason[];
  /** Another program, such as Excel or WPS, holds the file open; edits wait here until it closes it. */
  inUse: boolean;
}

export interface OfficeEditorPort {
  load: (bytes: Uint8Array) => Promise<void>;
  save: () => Promise<Uint8Array>;
  setReadOnly: (readOnly: boolean) => void;
}

/** Thrown by an editor port's save() for a change the format writer refuses to write. */
export class OfficeExportRefusal extends Error {
  constructor(readonly issue: string, message: string) {
    super(message);
  }
}

export interface OfficeDocumentOptions {
  autosaveDelayMs: number;
  logTag: string;
}

/** The file a document belongs to; its bytes live in the editor, not here. */
export interface OfficeDocumentFile {
  sessionId: string;
  filePath: string;
}

/**
 * A snapshot's admission facts without its bytes. A document outlives many reloads, and keeping
 * each snapshot would pin every version of the file in memory.
 */
function packageInfoOf<TInfo extends OfficePackageInfo>(snapshot: OfficeFileSnapshot<TInfo>): TInfo {
  const { bytes: _bytes, filePath: _filePath, version: _version, inUse: _inUse, ...rest } = snapshot as OfficeFileSnapshot<TInfo> & Partial<OfficeOpenResult<TInfo>>;
  const { sessionId: _sessionId, recovery: _recovery, ...info } = rest;
  return info as unknown as TInfo;
}

export class OfficeDocument<TInfo extends OfficePackageInfo> {
  private state: OfficeDocumentState<TInfo['readOnly'][number]>;
  /** Admission facts for the bytes currently shown. */
  packageInfo: TInfo;
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
  readonly file: OfficeDocumentFile;
  /** What was opened, until the editor has shown it. */
  private opened?: OfficeOpenResult<TInfo>;

  constructor(
    file: OfficeOpenResult<TInfo>,
    private readonly api: OfficeFileApi<TInfo>,
    private readonly editor: OfficeEditorPort,
    private readonly options: OfficeDocumentOptions,
    private readonly onStateChange: () => void = () => undefined,
  ) {
    this.file = { sessionId: file.sessionId, filePath: file.filePath };
    this.opened = file;
    this.revision = file.recovery?.revision ?? 0;
    this.savedRevision = file.recovery ? this.revision - 1 : this.revision;
    this.durableRevision = this.revision;
    this.baseVersion = file.recovery?.baseVersion ?? file.version;
    this.packageInfo = packageInfoOf(file);
    this.state = {
      ready: false, status: OfficeSaveState.Loading, draftSafe: true, restored: false,
      needsResolution: Boolean(file.recovery), readOnlyReasons: file.readOnly, inUse: Boolean(file.inUse),
    };
  }

  get locked(): boolean { return this.packageInfo.readOnly.length > 0; }
  get dirty(): boolean { return this.revision !== this.savedRevision; }
  get unsafe(): boolean { return this.revision > this.durableRevision; }
  get busy(): boolean { return this.loading || this.resolving || Boolean(this.saving || this.refreshing); }
  /** Monotonic counter of edits; agents use it to detect intervening user edits. */
  get currentRevision(): number { return this.revision; }

  getSnapshot = (): OfficeDocumentState<TInfo['readOnly'][number]> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(update: Partial<OfficeDocumentState<TInfo['readOnly'][number]>>): void {
    this.state = { ...this.state, ...update, draftSafe: !this.unsafe };
    this.listeners.forEach(listener => listener());
    this.onStateChange();
  }

  async initialize(): Promise<void> {
    const opened = this.opened;
    if (!opened) return;
    this.loading = true;
    try {
      await this.editor.load(opened.recovery?.bytes ?? opened.bytes);
      this.editor.setReadOnly(this.locked);
      const restored = Boolean(opened.recovery);
      // Recovery is shown for an explicit choice. Opening a file must never overwrite it.
      this.publish({ ready: true, restored, status: restored ? OfficeSaveState.Conflict : OfficeSaveState.Saved,
        readOnlyReasons: this.packageInfo.readOnly });
    } catch (error) {
      console.warn(`${this.options.logTag} Could not initialize editor:`, error);
      this.publish({ status: OfficeSaveState.Error, errorCode: OfficeFileError.Unsupported });
    } finally {
      this.opened = undefined;
      this.loading = false;
    }
  }

  changed = (): void => {
    if (this.loading || this.disposed) return;
    this.revision++;
    this.publish({
      status: this.state.needsResolution ? OfficeSaveState.Conflict : OfficeSaveState.Pending,
      errorCode: undefined,
      issue: undefined,
    });
    this.schedule();
  };

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.options.autosaveDelayMs);
  }

  private async capture(): Promise<OfficeWriteRequest | undefined> {
    const revision = this.revision;
    const bytes = await this.editor.save();
    // Never label a later export as an earlier revision, nor mark edits arriving during the
    // export as saved.
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
          this.publish({ status: OfficeSaveState.Error, errorCode: draft.code });
          return;
        }
        this.durableRevision = checkpoint.revision;
        this.publish({});
        if (this.state.needsResolution) {
          this.publish({ status: OfficeSaveState.Conflict, errorCode: undefined });
          if (this.unsafe) continue;
          return;
        }
        this.publish({ status: OfficeSaveState.Saving });
        const result = await this.api.save(checkpoint);
        if (!result.success) {
          if (result.code === OfficeFileError.InUse) {
            // Not a failure: the edits wait in the recovery copy until a refresh finds the file free.
            this.publish({ status: OfficeSaveState.Pending, errorCode: undefined, inUse: true });
          } else {
            const conflicted = result.code === OfficeFileError.Conflict;
            this.publish({ status: conflicted ? OfficeSaveState.Conflict : OfficeSaveState.Error, errorCode: result.code,
              needsResolution: conflicted || this.state.needsResolution });
          }
          // A newer edit still needs a recovery checkpoint even when this save conflicts.
          if (this.unsafe) this.schedule();
          return;
        }
        this.baseVersion = result.value.version;
        this.savedRevision = checkpoint.revision;
        this.publish({ status: this.dirty ? OfficeSaveState.Pending : OfficeSaveState.Saved, errorCode: undefined, inUse: false,
          restored: false, originalCopyPath: result.value.originalCopyPath ?? this.state.originalCopyPath });
      }
    } catch (error) {
      if (error instanceof OfficeExportRefusal) {
        console.warn(`${this.options.logTag} Export refused:`, error.message);
        this.publish({ status: OfficeSaveState.Error, errorCode: OfficeFileError.Unsupported, issue: error.issue });
        return;
      }
      console.error(`${this.options.logTag} Could not save document:`, error);
      this.publish({ status: OfficeSaveState.Error, errorCode: OfficeFileError.Io });
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
      // A slow read may arrive after a newer save receipt. It cannot roll the visible model
      // back to the snapshot preceding that save.
      if (baseVersion !== this.baseVersion) return;
      if (!result.success) {
        // A program that does not even share reading leaves the shown content as it is.
        this.publish(result.code === OfficeFileError.InUse ? { inUse: true } : { status: OfficeSaveState.Error, errorCode: result.code });
        return;
      }
      const inUse = Boolean(result.value.inUse);
      const released = this.state.inUse && !inUse;
      if (inUse !== this.state.inUse) this.publish({ inUse });
      if (result.value.version === this.baseVersion) {
        // Unchanged after the program holding it closed it, as its lock file going away reports,
        // or as found on returning to this window: the edits that waited can be written now.
        if (released && this.dirty) void this.flush();
        return;
      }
      if (this.dirty) {
        this.publish({ status: OfficeSaveState.Conflict, needsResolution: true });
        void this.flush();
        return;
      }
      this.loading = true;
      reloading = true;
      this.editor.setReadOnly(true);
      this.packageInfo = packageInfoOf(result.value);
      await this.editor.load(result.value.bytes);
      this.baseVersion = result.value.version;
      this.publish({ status: OfficeSaveState.Saved, errorCode: undefined, issue: undefined, readOnlyReasons: this.packageInfo.readOnly });
    } catch (error) {
      console.warn(`${this.options.logTag} Could not refresh document:`, error);
      this.publish({ status: OfficeSaveState.Error, errorCode: OfficeFileError.Io });
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
        this.publish({ status: OfficeSaveState.Conflict, errorCode: current.code, inUse: current.code === OfficeFileError.InUse || this.state.inUse });
        return;
      }
      if (!keepMine) {
        this.loading = true;
        this.packageInfo = packageInfoOf(current.value);
        await this.editor.load(current.value.bytes);
        this.revision++;
        this.savedRevision = this.revision;
        this.durableRevision = this.revision;
        const discarded = await this.api.discardDraft(this.file.sessionId);
        if (!discarded.success) {
          this.publish({ status: OfficeSaveState.Error, errorCode: discarded.code });
          return;
        }
      }
      this.baseVersion = current.value.version;
      this.publish({ status: keepMine ? OfficeSaveState.Pending : OfficeSaveState.Saved, restored: false, needsResolution: false,
        errorCode: undefined, issue: undefined, readOnlyReasons: this.packageInfo.readOnly, inUse: Boolean(current.value.inUse) });
    } catch (error) {
      console.error(`${this.options.logTag} Could not resolve document conflict:`, error);
      this.publish({ status: OfficeSaveState.Conflict, errorCode: OfficeFileError.Io });
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
