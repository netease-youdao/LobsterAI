import type { WorkBook } from 'xlsx';

const DelimitedTextExtension = {
  Csv: '.csv',
  Tsv: '.tsv',
} as const;

export function isDelimitedTextFile(fileName: string): boolean {
  const name = fileName.toLowerCase();
  return Object.values(DelimitedTextExtension).some(extension => name.endsWith(extension));
}

/** Full paths keep same-named files separate; session IDs scope remembered choices to a chat. */
export function getSheetPreviewKey(sessionId: string, filePath: string | undefined, artifactId: string): string {
  let pathKey = filePath?.replace(/\\/g, '/');
  // Windows links can change casing without identifying a different file. Preserve POSIX case.
  if (pathKey && (/^[A-Za-z]:\//.test(pathKey) || pathKey.startsWith('//'))) pathKey = pathKey.toLowerCase();
  return JSON.stringify([sessionId, pathKey ?? null, filePath ? null : artifactId]);
}

/** Text has already been decoded from the original bytes; binary workbooks retain their own codecs. */
export function readSheetPreview(XLSX: Pick<typeof import('xlsx'), 'read'>, data: ArrayBuffer | string, fileName: string): WorkBook {
  return typeof data === 'string'
    ? XLSX.read(data, { type: 'string', FS: fileName.toLowerCase().endsWith(DelimitedTextExtension.Tsv) ? '\t' : undefined })
    : XLSX.read(new Uint8Array(data), { type: 'array', cellStyles: true });
}
