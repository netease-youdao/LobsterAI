import type { IWorkbookData } from '@univerjs/core';

import { type EditorImport, editorImport } from './sheetEditorImport';
import { type SheetEdits, SheetExporter } from './sheetExporter';
import { FileWorkerMessage, type FileWorkerRequest, type FileWorkerResponse } from './sheetFileMessages';
import { cellSlices, SLICED_EXPORT_CELLS, snapshotCellCount, withoutCells } from './sheetSnapshotSlices';
import { XlsxExportError } from './xlsxExport';
import { type ImportOptions, importXlsxPackage, readXlsxPackage, type WorkbookFonts, workbookFonts, XlsxImportError } from './xlsxImport';
import type { XlsxPackage } from './xlsxPackage';
import type { NumberFormatLocale } from './xlsxStyles';

/**
 * Opening and saving a workbook file off the grid's thread: a worker unzips and imports the file
 * once, hands the editor its snapshot and keeps the import as the baseline of every save, so
 * neither opening nor saving a large workbook freezes the app. Where workers are unavailable
 * (tests) or the worker fails, the same steps run on this thread.
 */

/** The editor's workbook as a save needs it. */
export interface SheetSnapshotSource {
  /** The model's own snapshot with its current resources, for sending to the worker (which copies it). */
  live(): IWorkbookData;
  /** A copy the export may keep while the grid changes. */
  copy(): IWorkbookData;
  /** Changes with every edit, so a snapshot sent in parts can tell it stayed the same. */
  revision?(): number;
}

/** Attempts at sending a large snapshot in parts while edits keep arriving, before sending it whole. */
const SLICED_EXPORT_ATTEMPTS = 3;

/** Lets the grid draw and take input between the parts of a snapshot. */
const nextTask = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

export interface SheetFileClient {
  /** The workbook's default font and the fonts its cells use (loaded before measuring column widths). */
  fonts(): Promise<WorkbookFonts>;
  /** The editor's import of the workbook; opening, the fonts, comes first. */
  import(options: ImportOptions): Promise<EditorImport>;
  /** The model's resources right after loading (the adopt baselines); before the first save. */
  adopt(loaded: Pick<IWorkbookData, 'resources'>): void;
  export(source: SheetSnapshotSource, edits: SheetEdits): Promise<Uint8Array>;
  dispose(): void;
}

class InlineFileClient implements SheetFileClient {
  private pkg?: XlsxPackage;
  private exporter?: SheetExporter;

  constructor(private readonly bytes: Uint8Array, private readonly formatLocale: NumberFormatLocale) {}

  get imported(): boolean { return Boolean(this.exporter); }

  private opened(): XlsxPackage {
    this.pkg ??= readXlsxPackage(this.bytes);
    return this.pkg;
  }

  async fonts(): Promise<WorkbookFonts> {
    return workbookFonts(this.opened(), this.formatLocale);
  }

  async import(options: ImportOptions): Promise<EditorImport> {
    const workbook = importXlsxPackage(this.opened(), options);
    this.exporter = new SheetExporter(this.bytes, workbook.baseline);
    return editorImport(workbook);
  }

  adopt(loaded: Pick<IWorkbookData, 'resources'>): void {
    this.exporter?.adopt(loaded);
  }

  async export(source: SheetSnapshotSource, edits: SheetEdits): Promise<Uint8Array> {
    if (!this.exporter) throw new Error('The workbook is not imported');
    return this.exporter.export(source.copy(), edits);
  }

  dispose(): void {
    this.pkg = undefined;
    this.exporter = undefined;
  }
}

type Reply = Extract<FileWorkerResponse, { ok: true }>;

class WorkerFileClient implements SheetFileClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private pass = 0;
  private broken = false;
  private disposed = false;
  private fallback?: InlineFileClient;
  private options?: ImportOptions;
  private loaded?: Pick<IWorkbookData, 'resources'>;

  constructor(private readonly bytes: Uint8Array, private readonly formatLocale: NumberFormatLocale) {
    this.worker = new Worker(new URL('./sheetFile.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FileWorkerResponse>) => {
      const response = event.data;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (response.ok) request.resolve(response);
      else if (response.importIssue) request.reject(new XlsxImportError(response.importIssue, response.message));
      else request.reject(response.issue ? new XlsxExportError(response.issue, response.message) : new Error(response.message));
    };
    this.worker.onerror = event => this.fail(new Error(event.message || 'The workbook file worker stopped'));
  }

  private call(request: FileWorkerRequest, transfer: Transferable[] = []): Promise<Reply> {
    if (this.broken) return Promise.reject(new Error('The workbook file worker stopped'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...request, id }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error): void {
    this.broken = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  /** From a worker failure on, the file is opened, imported and saved here. */
  private inline(error: unknown): InlineFileClient {
    // A workbook closed while opening or saving stops there.
    if (this.disposed) throw error instanceof Error ? error : new Error(String(error));
    if (!this.fallback) {
      console.warn('[SheetEditor] The workbook file worker failed; continuing on the main thread:', error);
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.fallback = new InlineFileClient(this.bytes, this.formatLocale);
    }
    return this.fallback;
  }

  async fonts(): Promise<WorkbookFonts> {
    if (!this.fallback) {
      try {
        const bytes = this.bytes.slice();
        const { fonts } = await this.call({ kind: FileWorkerMessage.Open, id: 0, bytes, formatLocale: this.formatLocale }, [bytes.buffer]);
        if (fonts) return fonts;
        throw new Error('The workbook file worker returned no fonts');
      } catch (error) {
        // A file that cannot be read is refused here too.
        if (error instanceof XlsxImportError) throw error;
        return this.inline(error).fonts();
      }
    }
    return this.fallback.fonts();
  }

  async import(options: ImportOptions): Promise<EditorImport> {
    this.options = options;
    if (!this.fallback) {
      try {
        const { imported } = await this.call({ kind: FileWorkerMessage.Import, id: 0, options });
        if (imported) return imported;
        throw new Error('The workbook file worker returned no workbook');
      } catch (error) {
        if (error instanceof XlsxImportError) throw error;
        return this.inline(error).import(options);
      }
    }
    return this.fallback.import(options);
  }

  adopt(loaded: Pick<IWorkbookData, 'resources'>): void {
    this.loaded = loaded;
    if (this.fallback) this.fallback.adopt(loaded);
    // The worker handles messages in order, so the next save sees it; a failure shows at that save.
    else this.call({ kind: FileWorkerMessage.Adopt, id: 0, loaded }).catch(() => undefined);
  }

  /**
   * Sends a large snapshot's cells in parts, one task each, and then the rest of it. An edit while
   * the parts go out restarts the pass, so the saved file never mixes two states of the grid; after
   * a few restarts the snapshot goes whole. Resolves undefined when it was not sent in parts.
   */
  private async exportInParts(source: SheetSnapshotSource, edits: SheetEdits): Promise<Uint8Array | undefined> {
    if (!source.revision) return undefined;
    for (let attempt = 0; attempt < SLICED_EXPORT_ATTEMPTS; attempt++) {
      const revision = source.revision();
      const snapshot = source.live();
      if (snapshotCellCount(snapshot) < SLICED_EXPORT_CELLS) return undefined;
      const pass = ++this.pass;
      let changed = false;
      for (const slice of cellSlices(snapshot)) {
        this.worker.postMessage({ kind: FileWorkerMessage.ExportPart, id: 0, pass, ...slice } satisfies FileWorkerRequest);
        await nextTask();
        if (this.broken || source.revision() !== revision) {
          changed = true;
          break;
        }
      }
      if (this.broken) throw new Error('The workbook file worker stopped');
      if (changed) continue;
      const { bytes } = await this.call({ kind: FileWorkerMessage.Export, id: 0, current: withoutCells(snapshot), edits, pass });
      if (!bytes) throw new Error('The workbook file worker returned no file');
      return bytes;
    }
    return undefined;
  }

  async export(source: SheetSnapshotSource, edits: SheetEdits): Promise<Uint8Array> {
    if (!this.fallback) {
      try {
        const sliced = await this.exportInParts(source, edits);
        if (sliced) return sliced;
        // Posting copies the snapshot, so the model's own is read right before it is sent.
        const { bytes } = await this.call({ kind: FileWorkerMessage.Export, id: 0, current: source.live(), edits });
        if (bytes) return bytes;
        throw new Error('The workbook file worker returned no file');
      } catch (error) {
        // What the writer refuses is refused here too.
        if (error instanceof XlsxExportError) throw error;
        this.inline(error);
      }
    }
    const fallback = this.fallback!;
    // Saving here needs this thread's own import of the file, once.
    if (!fallback.imported) {
      if (!this.options) throw new Error('The workbook is not imported');
      await fallback.import(this.options);
      if (this.loaded) fallback.adopt(this.loaded);
    }
    return fallback.export(source, edits);
  }

  dispose(): void {
    this.disposed = true;
    this.fail(new Error('The workbook was closed'));
    this.fallback?.dispose();
  }
}

export function createSheetFileClient(bytes: Uint8Array, formatLocale: NumberFormatLocale): SheetFileClient {
  if (typeof Worker !== 'undefined') {
    try {
      return new WorkerFileClient(bytes, formatLocale);
    } catch (error) {
      console.warn('[SheetEditor] Could not start the workbook file worker; opening on the main thread:', error);
    }
  }
  return new InlineFileClient(bytes, formatLocale);
}
