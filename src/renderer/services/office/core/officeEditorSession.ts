import type { OfficeFileBridge, OfficeOpenResult, OfficePackageInfo } from '../../../../shared/office/core/officeFile';
import { OfficeDocument, type OfficeEditorPort } from './officeDocument';

/** What a session gets from its editor registry. */
export interface OfficeSessionContext<TInfo extends OfficePackageInfo> {
  bridge: OfficeFileBridge<TInfo>;
  /** Offscreen element that holds the editor while no view shows it. */
  parking: HTMLElement;
  /** Tells the main process whether any open file has edits that are not safely on disk. */
  reportState: () => void;
  /** Frees idle sessions beyond the registry's cache, once the current React commit is over. */
  scheduleEviction: () => void;
}

export interface OfficeSessionOptions {
  hostClassName: string;
  autosaveDelayMs: number;
  /** Log tag of the document's saves, e.g. `[SheetDocument]`. */
  logTag: string;
}

/**
 * One open file. The live editor sits in a host element that moves between the visible panel and
 * an offscreen parking area, so switching views never reloads it or loses its undo history.
 */
export abstract class OfficeEditorSession<TInfo extends OfficePackageInfo> implements OfficeEditorPort {
  readonly host = document.createElement('div');
  readonly document: OfficeDocument<TInfo>;
  /** Paths this file was opened by, e.g. through links; each maps to this session. */
  readonly aliases = new Set<string>();
  mounted = false;
  private initialization?: Promise<void>;

  protected constructor(file: OfficeOpenResult<TInfo>, protected readonly context: OfficeSessionContext<TInfo>, options: OfficeSessionOptions) {
    this.host.className = options.hostClassName;
    context.parking.appendChild(this.host);
    this.document = new OfficeDocument(file, context.bridge, this, {
      autosaveDelayMs: options.autosaveDelayMs, logTag: options.logTag,
    }, context.reportState);
  }

  abstract load(bytes: Uint8Array): Promise<void>;
  abstract save(): Promise<Uint8Array>;
  abstract setReadOnly(readOnly: boolean): void;
  /** Tears the live editor down; the session is gone afterwards. */
  protected abstract disposeEditor(): void;

  /** Called when a view shows the editor; the returned function runs when the view lets it go. */
  protected shown(): (() => void) | undefined {
    return undefined;
  }

  initialize(): Promise<void> {
    this.initialization ??= this.document.initialize();
    return this.initialization;
  }

  /** Shows the editor in `container`; the returned function parks it again and saves. */
  mount(container: HTMLElement): () => void {
    this.mounted = true;
    container.appendChild(this.host);
    this.context.scheduleEviction();
    const hidden = this.shown();
    return () => {
      hidden?.();
      this.mounted = false;
      this.context.parking.appendChild(this.host);
      void this.document.flush();
      this.context.scheduleEviction();
    };
  }

  dispose(): void {
    this.document.dispose();
    this.disposeEditor();
    this.host.remove();
    void this.context.bridge.release(this.document.file.sessionId);
  }
}
