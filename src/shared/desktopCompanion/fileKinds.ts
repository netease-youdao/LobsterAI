export const CompanionFileKind = {
  Document: 'document',
  Spreadsheet: 'spreadsheet',
  Presentation: 'presentation',
  Pdf: 'pdf',
  Image: 'image',
  Text: 'text',
  Folder: 'folder',
  Other: 'other',
} as const;
export type CompanionFileKind = typeof CompanionFileKind[keyof typeof CompanionFileKind];

export const CompanionDropAction = {
  Digest: 'digest',
  Translate: 'translate',
  Analyze: 'analyze',
  Chart: 'chart',
  Outline: 'outline',
  Script: 'script',
  Ocr: 'ocr',
  Describe: 'describe',
  Organize: 'organize',
  Ask: 'ask',
} as const;
export type CompanionDropAction = typeof CompanionDropAction[keyof typeof CompanionDropAction];

const K = CompanionFileKind;
const D = CompanionDropAction;

const EXTENSION_KINDS: Record<string, CompanionFileKind> = {
  doc: K.Document, docx: K.Document, wps: K.Document, pages: K.Document, rtf: K.Document, odt: K.Document, epub: K.Document, mobi: K.Document,
  xls: K.Spreadsheet, xlsx: K.Spreadsheet, xlsm: K.Spreadsheet, et: K.Spreadsheet, numbers: K.Spreadsheet, csv: K.Spreadsheet, tsv: K.Spreadsheet, ods: K.Spreadsheet,
  ppt: K.Presentation, pptx: K.Presentation, dps: K.Presentation, key: K.Presentation, odp: K.Presentation,
  pdf: K.Pdf,
  png: K.Image, jpg: K.Image, jpeg: K.Image, webp: K.Image, gif: K.Image, bmp: K.Image, heic: K.Image, tif: K.Image, tiff: K.Image,
  txt: K.Text, md: K.Text, markdown: K.Text, json: K.Text, html: K.Text, htm: K.Text, xml: K.Text, log: K.Text,
};

const MIME_KINDS: Array<[RegExp, CompanionFileKind]> = [
  [/wordprocessingml|msword|opendocument\.text|rtf|epub|mobipocket/i, K.Document],
  [/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv|tab-separated/i, K.Spreadsheet],
  [/presentationml|ms-powerpoint|opendocument\.presentation/i, K.Presentation],
  [/application\/pdf/i, K.Pdf],
  [/^image\//i, K.Image],
  [/^text\/|application\/json|markdown/i, K.Text],
];

export function companionFileKindFromName(name: string): CompanionFileKind {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? EXTENSION_KINDS[match[1].toLowerCase()] ?? K.Other : K.Other;
}

export function companionFileKindFromMime(mime: string): CompanionFileKind {
  if (!mime) return K.Other;
  return MIME_KINDS.find(([pattern]) => pattern.test(mime))?.[1] ?? K.Other;
}

/** Kinds worth offering a drop target for while a drag is still in flight. */
export function isCompanionDocumentKind(kind: CompanionFileKind): boolean {
  return kind !== K.Other && kind !== K.Folder;
}

/**
 * Three drop targets: two that start right away, and "ask" that opens the
 * panel with the files attached.
 */
export function companionDropActions(kinds: readonly CompanionFileKind[]): CompanionDropAction[] {
  const unique = [...new Set(kinds.filter(kind => kind !== K.Other))];
  if (unique.length === 0) return [D.Digest, D.Translate, D.Ask];
  if (unique.length > 1) {
    const readable = unique.every(kind => kind === K.Document || kind === K.Pdf || kind === K.Text);
    return readable ? [D.Digest, D.Translate, D.Ask] : [D.Digest, D.Organize, D.Ask];
  }
  switch (unique[0]) {
    case K.Spreadsheet: return [D.Analyze, D.Chart, D.Ask];
    case K.Presentation: return [D.Outline, D.Script, D.Ask];
    case K.Image: return [D.Ocr, D.Describe, D.Ask];
    case K.Folder: return [D.Organize, D.Digest, D.Ask];
    default: return [D.Digest, D.Translate, D.Ask];
  }
}

/** i18n keys for a drop target: title, detail, and the task prompt. */
export function companionDropCopyKeys(action: CompanionDropAction) {
  const base = `desktopCompanionDrop${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  return { title: base, detail: `${base}Detail`, prompt: `${base}Prompt` };
}
