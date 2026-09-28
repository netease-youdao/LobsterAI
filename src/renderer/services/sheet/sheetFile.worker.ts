import { editorImport } from './sheetEditorImport';
import { SheetExporter } from './sheetExporter';
import { FileWorkerMessage, type FileWorkerRequest, type FileWorkerResponse } from './sheetFileMessages';
import { XlsxExportError } from './xlsxExport';
import { importXlsxPackage, readXlsxPackage, workbookFonts, XlsxImportError } from './xlsxImport';
import type { XlsxPackage } from './xlsxPackage';

/**
 * Opens and saves a workbook off the grid's thread, one worker per editor session: it imports the
 * file once, sends the editor its snapshot and keeps the import as the baseline of every save.
 */
let bytes: Uint8Array | undefined;
let pkg: XlsxPackage | undefined;
let exporter: SheetExporter | undefined;

function opened(): { bytes: Uint8Array; pkg: XlsxPackage } {
  if (!bytes || !pkg) throw new Error('The workbook is not open');
  return { bytes, pkg };
}

function imported(): SheetExporter {
  if (!exporter) throw new Error('The workbook is not imported');
  return exporter;
}

self.onmessage = (event: MessageEvent<FileWorkerRequest>) => {
  const request = event.data;
  const reply = (response: FileWorkerResponse, transfer: Transferable[] = []) => self.postMessage(response, { transfer });
  try {
    switch (request.kind) {
      case FileWorkerMessage.Open:
        bytes = request.bytes;
        pkg = readXlsxPackage(bytes);
        reply({ id: request.id, ok: true, fonts: workbookFonts(pkg, request.formatLocale) });
        return;
      case FileWorkerMessage.Import: {
        const file = opened();
        const workbook = importXlsxPackage(file.pkg, request.options);
        exporter = new SheetExporter(file.bytes, workbook.baseline);
        reply({ id: request.id, ok: true, imported: editorImport(workbook) });
        return;
      }
      case FileWorkerMessage.Adopt:
        imported().adopt(request.loaded);
        reply({ id: request.id, ok: true });
        return;
      case FileWorkerMessage.Export: {
        const file = imported().export(request.current, request.edits);
        reply({ id: request.id, ok: true, bytes: file }, [file.buffer]);
        return;
      }
    }
  } catch (error) {
    reply({
      id: request.id, ok: false,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof XlsxExportError ? { issue: error.issue } : {}),
      ...(error instanceof XlsxImportError ? { importIssue: error.reason } : {}),
    });
  }
};
