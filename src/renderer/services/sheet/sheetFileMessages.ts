import type { IWorkbookData } from '@univerjs/core';

import type { EditorImport } from './sheetEditorImport';
import type { SheetEdits } from './sheetExporter';
import type { SheetExportIssue } from './xlsxExport';
import type { ImportOptions, WorkbookFonts, XlsxImportError } from './xlsxImport';
import type { NumberFormatLocale } from './xlsxStyles';

/** Messages between the editor and its file worker (see sheetFileClient). */
export const FileWorkerMessage = { Open: 'open', Import: 'import', Adopt: 'adopt', Export: 'export' } as const;

export type FileWorkerRequest =
  | { kind: typeof FileWorkerMessage.Open; id: number; bytes: Uint8Array; formatLocale: NumberFormatLocale }
  | { kind: typeof FileWorkerMessage.Import; id: number; options: ImportOptions }
  | { kind: typeof FileWorkerMessage.Adopt; id: number; loaded: Pick<IWorkbookData, 'resources'> }
  | { kind: typeof FileWorkerMessage.Export; id: number; current: IWorkbookData; edits: SheetEdits };

export type FileWorkerResponse =
  | { id: number; ok: true; fonts?: WorkbookFonts; imported?: EditorImport; bytes?: Uint8Array }
  | { id: number; ok: false; message: string; issue?: SheetExportIssue; importIssue?: XlsxImportError['reason'] };
