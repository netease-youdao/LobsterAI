import type { IWorkbookData } from '@univerjs/core';

import { cellReference, parseCellReference } from './sheetAddress';
import type { SheetMaps } from './sheetStructure';
import {
  addContentType, addDefaultContentType, nextPartName, relationshipsPath, relativeTarget, removeContentType, type XlsxPackage,
} from './xlsxPackage';
import { mapElements, RelationshipTypes } from './xlsxStructureExport';
import {
  addElementPrefix, decodeXml, elementPrefix, encodeExcelString, encodeXmlText, firstXmlElement, plainText, setXmlAttributes, xmlAttribute, type XmlElement, xmlElements,
} from './xlsxXml';

/**
 * Cell notes: Excel's comments (legacy notes, and threaded comments shown as their conversation)
 * in Univer's note model. The comment and VML parts keep their markup; only notes added, edited,
 * shown, hidden or deleted in the editor are rewritten.
 */

/** Resource the note plugin stores its notes in (SHEET_NOTE_PLUGIN). */
export const NOTES_RESOURCE = 'SHEET_NOTE_PLUGIN';
const PERSON_RELATIONSHIP = 'http://schemas.microsoft.com/office/2017/10/relationships/person';
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml';
const VML_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.vmlDrawing';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const VML_NS = 'urn:schemas-microsoft-com:vml';
const OFFICE_NS = 'urn:schemas-microsoft-com:office:office';
const EXCEL_NS = 'urn:schemas-microsoft-com:office:excel';
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Excel's default note box: 108pt × 59.25pt. */
const DEFAULT_WIDTH = 144;
const DEFAULT_HEIGHT = 79;
const NEW_AUTHOR = 'LobsterAI';
/** Worksheet children that follow `<legacyDrawing>`, in schema order. */
const AFTER_LEGACY_DRAWING = ['legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

export interface SheetNote {
  id: string;
  row: number;
  col: number;
  width: number;
  height: number;
  note: string;
  show?: boolean;
}

export interface ImportedNote {
  note: SheetNote;
  /** Shown from a threaded comment (its conversation); edits turn it into a plain note. */
  threaded: boolean;
}

const cellKey = (row: number, column: number) => `${row}:${column}`;

/** A CSS length in pixels (`108pt`, `144px`, `1.5in`). */
function pixels(value: string | undefined): number | undefined {
  const match = value?.trim().match(/^(-?[\d.]+)\s*(pt|px|in|cm|mm)?$/);
  if (!match) return undefined;
  const number = Number(match[1]);
  const factor = { pt: 96 / 72, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[match[2] ?? 'px'] ?? 1;
  return Number.isFinite(number) ? Math.round(number * factor) : undefined;
}

function styleProperties(style: string | undefined): Map<string, string> {
  const properties = new Map<string, string>();
  for (const part of (style ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) properties.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
  }
  return properties;
}

/** Note boxes of a VML part by cell: size and whether the note is always shown. */
function noteShapes(vml: string | undefined): Map<string, { width?: number; height?: number; show: boolean }> {
  const shapes = new Map<string, { width?: number; height?: number; show: boolean }>();
  for (const shape of vml ? xmlElements(vml, 'shape') : []) {
    const data = shape.inner ? firstXmlElement(shape.inner, 'ClientData') : undefined;
    if (!data?.inner || xmlAttribute(data.open, 'ObjectType') !== 'Note') continue;
    const row = Number(decodeXml(firstXmlElement(data.inner, 'Row')?.inner ?? ''));
    const column = Number(decodeXml(firstXmlElement(data.inner, 'Column')?.inner ?? ''));
    if (!Number.isInteger(row) || !Number.isInteger(column)) continue;
    const style = styleProperties(xmlAttribute(shape.open, 'style'));
    shapes.set(cellKey(row, column), {
      width: pixels(style.get('width')),
      height: pixels(style.get('height')),
      show: Boolean(firstXmlElement(data.inner, 'Visible')) || style.get('visibility') === 'visible',
    });
  }
  return shapes;
}

/** Threaded conversations by cell, as "Name: text" lines. */
function threads(pkg: XlsxPackage, part: string | undefined, people: Map<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  const xml = part ? pkg.text(part) : undefined;
  for (const comment of xml ? xmlElements(xml, 'threadedComment') : []) {
    const ref = xmlAttribute(comment.open, 'ref');
    const cell = ref ? parseCellReference(ref) : undefined;
    if (!cell) continue;
    const text = decodeXml(firstXmlElement(comment.inner ?? '', 'text')?.inner ?? '');
    const person = people.get(xmlAttribute(comment.open, 'personId') ?? '');
    const line = person ? `${person}: ${text}` : text;
    const key = cellKey(cell.row, cell.column);
    result.set(key, result.has(key) ? `${result.get(key)}\n${line}` : line);
  }
  return result;
}

function people(pkg: XlsxPackage, workbookPart: string): Map<string, string> {
  const part = pkg.relationships(workbookPart).find(item => item.type === PERSON_RELATIONSHIP && !item.external)?.target;
  const xml = part ? pkg.text(part) : undefined;
  const result = new Map<string, string>();
  for (const person of xml ? xmlElements(xml, 'person') : []) {
    const id = xmlAttribute(person.open, 'id');
    const name = xmlAttribute(person.open, 'displayName');
    if (id && name) result.set(id, name);
  }
  return result;
}

/** A worksheet's notes, legacy and threaded. */
export function importNotes(pkg: XlsxPackage, workbookPart: string, sheetPart: string, sheetId: string): ImportedNote[] {
  const relations = pkg.relationships(sheetPart);
  const target = (type: string) => relations.find(item => item.type === type && !item.external)?.target;
  const commentsPart = target(RelationshipTypes.Comments);
  const threadedPart = target(RelationshipTypes.ThreadedComments);
  if (!commentsPart && !threadedPart) return [];
  const shapes = noteShapes(target(RelationshipTypes.VmlDrawing) ? pkg.text(target(RelationshipTypes.VmlDrawing)!) : undefined);
  const conversations = threads(pkg, threadedPart, threadedPart ? people(pkg, workbookPart) : new Map());
  const notes = new Map<string, ImportedNote>();
  const add = (row: number, column: number, text: string, threaded: boolean) => {
    const shape = shapes.get(cellKey(row, column));
    notes.set(cellKey(row, column), {
      threaded,
      note: {
        id: `lobster-note-${sheetId}-${row}-${column}`, row, col: column, note: text,
        width: shape?.width ?? DEFAULT_WIDTH, height: shape?.height ?? DEFAULT_HEIGHT,
        ...(shape?.show ? { show: true } : {}),
      },
    });
  };
  const comments = commentsPart ? pkg.text(commentsPart) : undefined;
  for (const comment of comments ? xmlElements(comments, 'comment') : []) {
    const cell = parseCellReference(xmlAttribute(comment.open, 'ref') ?? '');
    if (!cell) continue;
    const conversation = conversations.get(cellKey(cell.row, cell.column));
    const text = conversation ?? plainText(firstXmlElement(comment.inner ?? '', 'text')?.inner ?? '');
    add(cell.row, cell.column, text, conversation !== undefined);
  }
  for (const [key, conversation] of conversations) {
    if (notes.has(key)) continue;
    const [row, column] = key.split(':').map(Number);
    add(row, column, conversation, true);
  }
  return [...notes.values()];
}

/** Notes of a Univer snapshot per sheet id and cell; undefined when the plugin is not loaded. */
export function notesOf(snapshot: IWorkbookData): Record<string, Record<string, Record<string, SheetNote>>> | undefined {
  const resource = snapshot.resources?.find(item => item.name === NOTES_RESOURCE);
  if (!resource) return undefined;
  if (!resource.data) return {};
  try {
    const parsed = JSON.parse(resource.data) as Record<string, Record<string, Record<string, SheetNote>>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Compare later saves against the notes as the model holds them right after loading. */
export function adoptLoadedNotes(imported: Map<string, ImportedNote[]>, snapshot: IWorkbookData): void {
  const model = notesOf(snapshot);
  if (!model) return;
  for (const [sheetId, list] of imported) {
    for (const item of list) {
      const loaded = model[sheetId]?.[item.note.row]?.[item.note.col];
      if (loaded) item.note = { ...loaded };
    }
  }
}

/** Notes in the shape the note plugin loads: sheet → row → column. */
export function notesResource(notes: Map<string, ImportedNote[]>): string {
  const result: Record<string, Record<number, Record<number, SheetNote>>> = {};
  for (const [sheetId, list] of notes) {
    const sheet: Record<number, Record<number, SheetNote>> = {};
    for (const { note } of list) (sheet[note.row] ??= {})[note.col] = note;
    result[sheetId] = sheet;
  }
  return JSON.stringify(result);
}

/** What happens to a note the file has. */
export interface KeptNote {
  /** Its cell now: another than in the file when sorting or cut and paste moved it. */
  to: string;
  /** Its new text, when edited. */
  text?: string;
  /** The text replaces the comment whole: a thread that became a plain note. */
  replace?: boolean;
  /** Its new "always show" setting, when changed. */
  show?: boolean;
}

export interface NoteChanges {
  /** Notes the file has, by cell (moved through row and column edits), that stay: moved, edited or shown. */
  kept: Map<string, KeptNote>;
  /** Cells (moved through row and column edits) whose note was deleted. */
  removed: Set<string>;
  /** Notes added in the editor. */
  added: SheetNote[];
}

/** How a sheet's notes differ from what was loaded, moved through the row and column edits. */
export function noteChanges(imported: ImportedNote[], current: Record<string, Record<string, SheetNote>> | undefined, maps: SheetMaps): NoteChanges | undefined {
  const now = new Map<string, SheetNote>();
  for (const row of Object.values(current ?? {})) for (const note of Object.values(row ?? {})) if (note) now.set(cellKey(note.row, note.col), note);
  const cellOf = new Map<string, string>();
  for (const [key, note] of now) if (note.id) cellOf.set(note.id, key);
  const loadedIds = new Set(imported.map(item => item.note.id).filter(Boolean));
  const changes: NoteChanges = { kept: new Map(), removed: new Set(), added: [] };
  const claimed = new Set<string>();
  for (const { note, threaded } of imported) {
    const row = maps.rows.index(note.row);
    const column = maps.columns.index(note.col);
    if (row === null || column === null) continue;
    const from = cellKey(row, column);
    // A note stays in its place, or is where its id went (sorting and cut and paste move notes);
    // a note in its place that no loaded note claims is the same note under a new id.
    const there = now.get(from);
    let to: string | undefined;
    if (there && there.id === note.id) to = from;
    else if (note.id && cellOf.has(note.id)) to = cellOf.get(note.id);
    else if (there && !(there.id && loadedIds.has(there.id))) to = from;
    if (to === undefined || claimed.has(to)) {
      changes.removed.add(from);
      continue;
    }
    claimed.add(to);
    const next = now.get(to)!;
    const kept: KeptNote = { to };
    if (next.note !== note.note) Object.assign(kept, { text: next.note, ...(threaded ? { replace: true } : {}) });
    if (Boolean(next.show) !== Boolean(note.show)) kept.show = Boolean(next.show);
    if (to !== from || kept.text !== undefined || kept.show !== undefined) changes.kept.set(from, kept);
  }
  for (const [key, note] of now) if (!claimed.has(key)) changes.added.push(note);
  return changes.kept.size || changes.removed.size || changes.added.length ? changes : undefined;
}

const cellOfKey = (key: string): { row: number; column: number } => {
  const [row, column] = key.split(':').map(Number);
  return { row, column };
};

const referenceOfKey = (key: string): string => {
  const { row, column } = cellOfKey(key);
  return cellReference(row, column);
};

/** A thread that became a plain note, as a new note at its cell. */
function convertedNote(kept: KeptNote): SheetNote {
  const { row, column } = cellOfKey(kept.to);
  return { id: '', row, col: column, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, note: kept.text ?? '', ...(kept.show ? { show: true } : {}) };
}

/** An element with another `ref`. */
function withRef(element: XmlElement, key: string): string {
  const open = setXmlAttributes(element.open, { ref: referenceOfKey(key) });
  return element.inner === undefined ? open : `${open}${element.inner}</${element.name}>`;
}

interface TextRun {
  /** The run's formatting as written (`<rPr>…</rPr>`); undefined for plain text. */
  properties?: string;
  text: string;
}

/**
 * Change a rich text's words as little as possible: the text between the common start and end is
 * replaced inside one run, so the author's bold name and other formatting stay where they were.
 * Replacing text keeps its formatting, typed text takes the formatting of the character before
 * it, and text replacing everything takes the last run's. `prefix` is the part's element prefix
 * (`x:` or empty).
 */
export function editRichText(inner: string, text: string, prefix: string): string {
  const withoutPhonetics = inner.replace(/<((?:[\w.-]+:)?rPh)\b[\s\S]*?<\/\1>/g, '');
  const tail = [...xmlElements(withoutPhonetics, 'phoneticPr')].map(element => withoutPhonetics.slice(element.start, element.end)).join('');
  const rich = [...xmlElements(withoutPhonetics, 'r')];
  const runs: TextRun[] = rich.length
    ? rich.map(run => {
      const properties = run.inner ? firstXmlElement(run.inner, 'rPr') : undefined;
      return { properties: properties && run.inner ? run.inner.slice(properties.start, properties.end) : undefined, text: plainText(run.inner ?? '') };
    })
    : [{ text: plainText(withoutPhonetics) }];
  const before = runs.map(run => run.text).join('');
  let start = 0;
  while (start < before.length && start < text.length && before[start] === text[start]) start++;
  let common = 0;
  while (common < before.length - start && common < text.length - start && before[before.length - 1 - common] === text[text.length - 1 - common]) common++;
  const end = before.length - common;
  const insert = text.slice(start, text.length - common);
  const runAt = (position: number, after: boolean): number => {
    let runStart = 0;
    for (let index = 0; index < runs.length; index++) {
      const runEnd = runStart + runs[index].text.length;
      if (after ? position >= runStart && position < runEnd : position > runStart && position <= runEnd) return index;
      runStart = runEnd;
    }
    return runs.length - 1;
  };
  const target = start === 0 && end === before.length ? runs.length - 1 // all replaced: the body's formatting
    : end > start ? runAt(start, true) // replaced text: the formatting of what it replaces
      : start > 0 ? runAt(start, false) : 0; // typed text: the formatting of the character before it
  let offset = 0;
  const edited = runs.map((run, index) => {
    const runStart = offset;
    offset += run.text.length;
    const cutStart = Math.min(Math.max(start - runStart, 0), run.text.length);
    const cutEnd = Math.min(Math.max(end - runStart, 0), run.text.length);
    let next = run.text.slice(0, cutStart) + run.text.slice(cutEnd);
    if (index === target) next = next.slice(0, cutStart) + insert + next.slice(cutStart);
    return { ...run, text: next };
  });
  const kept = edited.filter(run => run.text);
  const element = (name: string) => `${prefix}${name}`;
  const t = (value: string) => `<${element('t')} xml:space="preserve">${encodeXmlText(encodeExcelString(value))}</${element('t')}>`;
  const markup = rich.length
    ? (kept.length ? kept : edited.slice(0, 1)).map(run => `<${element('r')}>${run.properties ?? ''}${t(run.text)}</${element('r')}>`).join('')
    : t(text);
  return markup + tail;
}

/** A kept comment with new text (formatting kept) at a cell. */
function editedComment(element: XmlElement, key: string, text: string, prefix: string): string {
  const open = setXmlAttributes(element.open, { ref: referenceOfKey(key) });
  const body = element.inner ? firstXmlElement(element.inner, 'text') : undefined;
  if (!element.inner || !body) return `${open}${addElementPrefix(`<text><t xml:space="preserve">${encodeXmlText(encodeExcelString(text))}</t></text>`, prefix)}</${element.name}>`;
  const inner = element.inner.slice(0, body.start) + `${body.open}${editRichText(body.inner ?? '', text, prefix)}</${body.name}>` + element.inner.slice(body.end);
  return `${open}${inner}</${element.name}>`;
}

/** Prefixes a VML part uses for the VML, Office and Excel namespaces. */
function vmlPrefixes(vml: string): { v: string; o: string; x: string } {
  const prefix = (namespace: string, fallback: string) => {
    const match = new RegExp(`xmlns:([\\w.-]+)="${namespace.replace(/[.]/g, '\\.')}"`).exec(vml);
    return match ? match[1] : fallback;
  };
  return { v: prefix(VML_NS, 'v'), o: prefix(OFFICE_NS, 'o'), x: prefix(EXCEL_NS, 'x') };
}

function noteShape(note: SheetNote, id: number, prefixes: { v: string; o: string; x: string }): string {
  const { v, o, x } = prefixes;
  const width = `${Math.round((note.width || DEFAULT_WIDTH) * 72 / 96 * 100) / 100}pt`;
  const height = `${Math.round((note.height || DEFAULT_HEIGHT) * 72 / 96 * 100) / 100}pt`;
  return `<${v}:shape id="_x0000_s${id}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:${width};height:${height};z-index:${id};visibility:${note.show ? 'visible' : 'hidden'}" fillcolor="#ffffe1" ${o}:insetmode="auto">`
    + `<${v}:fill color2="#ffffe1"/><${v}:shadow on="t" color="black" obscured="t"/><${v}:path ${o}:connecttype="none"/>`
    + `<${v}:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></${v}:textbox>`
    + `<${x}:ClientData ObjectType="Note"><${x}:MoveWithCells/><${x}:SizeWithCells/>`
    + `<${x}:Anchor>${note.col + 1}, 15, ${Math.max(0, note.row - 1)}, 10, ${note.col + 3}, 15, ${note.row + 3}, 4</${x}:Anchor>`
    + `<${x}:AutoFill>False</${x}:AutoFill><${x}:Row>${note.row}</${x}:Row><${x}:Column>${note.col}</${x}:Column>${note.show ? `<${x}:Visible/>` : ''}</${x}:ClientData></${v}:shape>`;
}

const NEW_VML = `<xml xmlns:v="${VML_NS}" xmlns:o="${OFFICE_NS}" xmlns:x="${EXCEL_NS}"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>`
  + '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>';

function commentMarkup(prefix: string, ref: string, authorId: number, text: string): string {
  return addElementPrefix(`<comment ref="${ref}" authorId="${authorId}"><text><t xml:space="preserve">${encodeXmlText(text)}</t></text></comment>`, prefix);
}

/** A note box's cell and anchor moved from one cell to another. */
function moveNoteShape(inner: string, from: { row: number; column: number }, to: { row: number; column: number }): string {
  const replace = (text: string, element: XmlElement | undefined, value: string) => (element?.inner === undefined ? text : text.slice(0, element.start) + `${element.open}${value}</${element.name}>` + text.slice(element.end));
  let next = replace(inner, firstXmlElement(inner, 'Row'), String(to.row));
  next = replace(next, firstXmlElement(next, 'Column'), String(to.column));
  const anchor = firstXmlElement(next, 'Anchor');
  const values = anchor?.inner?.split(',').map(value => Number(value.trim()));
  if (anchor && values?.length === 8 && values.every(Number.isFinite)) {
    const [rows, columns] = [to.row - from.row, to.column - from.column];
    const moved = [values[0] + columns, values[1], values[2] + rows, values[3], values[4] + columns, values[5], values[6] + rows, values[7]].map(value => Math.max(0, value));
    next = replace(next, anchor, ` ${moved.join(', ')}`);
  }
  return next;
}

/**
 * Apply a sheet's note changes to its comment, threaded comment and VML parts in `files`,
 * creating the parts (and the worksheet's `<legacyDrawing>`) for a sheet's first note. Returns
 * the worksheet part, changed when a legacy drawing had to be added.
 */
export function rewriteNotes(files: Map<string, Uint8Array>, sheetPart: string, sheetXml: string, changes: NoteChanges): string {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const read = (part: string) => { const bytes = files.get(part); return bytes ? decoder.decode(bytes).replace(/^\uFEFF/, '') : undefined; };
  const write = (part: string, text: string) => files.set(part, encoder.encode(text));
  const relsPath = relationshipsPath(sheetPart);
  let rels = read(relsPath);
  const relationship = (type: string): { id: string; part: string } | undefined => {
    for (const element of rels ? xmlElements(rels, 'Relationship') : []) {
      if (xmlAttribute(element.open, 'Type') !== type || xmlAttribute(element.open, 'TargetMode')?.toLowerCase() === 'external') continue;
      const value = xmlAttribute(element.open, 'Target') ?? '';
      const segments = value.startsWith('/') ? [] : sheetPart.split('/').slice(0, -1);
      for (const segment of value.replace(/^\//, '').split('/')) {
        if (segment === '..') segments.pop();
        else if (segment && segment !== '.') segments.push(segment);
      }
      return { id: xmlAttribute(element.open, 'Id') ?? '', part: segments.join('/') };
    }
    return undefined;
  };
  const target = (type: string): string | undefined => relationship(type)?.part;
  let sheet = sheetXml;
  /** A part left empty goes with its relationship and content type (and, for VML, the worksheet's reference). */
  const dropPart = (type: string) => {
    const found = relationship(type);
    if (!found) return;
    files.delete(found.part);
    rels = rels && mapElements(rels, 'Relationship', element => (xmlAttribute(element.open, 'Id') === found.id ? null : undefined));
    removeContentType(files, `/${found.part}`);
    if (type === RelationshipTypes.VmlDrawing) sheet = mapElements(sheet, 'legacyDrawing', element => (xmlAttribute(element.open, 'r:id') === found.id ? null : undefined));
  };
  const relationIds = new Set([...(rels ?? '').matchAll(/\bId="([^"]+)"/g)].map(match => match[1]));
  const addRelationship = (type: string, part: string): string => {
    let number = 1;
    while (relationIds.has(`rId${number}`)) number++;
    const id = `rId${number}`;
    relationIds.add(id);
    const element = `<Relationship Id="${id}" Type="${type}" Target="${relativeTarget(sheetPart, part)}"/>`;
    rels = rels
      ? rels.replace(/<\/((?:[\w.-]+:)?Relationships)>\s*$/, `${element}</$1>`)
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${element}</Relationships>`;
    return id;
  };

  const keyOf = (element: XmlElement): string | undefined => {
    const cell = parseCellReference(xmlAttribute(element.open, 'ref') ?? '');
    return cell ? cellKey(cell.row, cell.column) : undefined;
  };

  // Threaded conversations: deleted and converted ones leave the thread part, moved ones follow their cells.
  const threadedPart = target(RelationshipTypes.ThreadedComments);
  const threaded = threadedPart ? read(threadedPart) : undefined;
  if (threadedPart && threaded) {
    const next = mapElements(threaded, 'threadedComment', element => {
      const key = keyOf(element);
      const kept = key === undefined ? undefined : changes.kept.get(key);
      if (key === undefined || (!kept && !changes.removed.has(key))) return undefined;
      if (!kept || kept.replace) return null;
      return kept.to === key ? undefined : withRef(element, kept.to);
    });
    if (!firstXmlElement(next, 'threadedComment')) dropPart(RelationshipTypes.ThreadedComments);
    else if (next !== threaded) write(threadedPart, next);
  }

  // Comments: drop, move or rewrite each; append new ones (and threads without a legacy copy that became notes).
  const consumed = new Set<string>();
  const pending = (): SheetNote[] => [
    ...[...changes.kept].filter(([key, kept]) => kept.replace && !consumed.has(key)).map(([, kept]) => convertedNote(kept)),
    ...changes.added,
  ];
  let commentsPart = target(RelationshipTypes.Comments);
  let comments = commentsPart ? read(commentsPart) : undefined;
  if (!comments && pending().length) {
    commentsPart = nextPartName(files, index => `xl/comments${index}.xml`);
    comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="${SHEET_NS}"><authors><author>${NEW_AUTHOR}</author></authors><commentList></commentList></comments>`;
    addRelationship(RelationshipTypes.Comments, commentsPart);
    addContentType(files, `/${commentsPart}`, COMMENTS_CONTENT_TYPE);
  }
  if (commentsPart && comments) {
    const prefix = elementPrefix(firstXmlElement(comments, 'comments')?.name ?? '');
    let next = mapElements(comments, 'comment', element => {
      const key = keyOf(element);
      if (key === undefined) return undefined;
      if (changes.removed.has(key)) return null;
      const kept = changes.kept.get(key);
      if (!kept) return undefined;
      consumed.add(key);
      if (kept.text !== undefined && kept.replace) {
        const authorId = Number(xmlAttribute(element.open, 'authorId') ?? 0);
        return commentMarkup(prefix, referenceOfKey(kept.to), Number.isInteger(authorId) ? authorId : 0, kept.text);
      }
      if (kept.text !== undefined) return editedComment(element, kept.to, kept.text, prefix);
      return kept.to === key ? undefined : withRef(element, kept.to);
    });
    const additions = pending();
    if (additions.length) {
      // New notes are signed by the editor's author entry.
      const authors = firstXmlElement(next, 'authors');
      const names = authors?.inner ? [...xmlElements(authors.inner, 'author')].map(author => decodeXml(author.inner ?? '')) : [];
      let authorId = names.indexOf(NEW_AUTHOR);
      if (authorId < 0 && authors) {
        authorId = names.length;
        const close = authors.start + authors.open.length + (authors.inner ?? '').length;
        next = authors.inner === undefined
          ? next.slice(0, authors.start) + addElementPrefix(`<authors><author>${NEW_AUTHOR}</author></authors>`, prefix) + next.slice(authors.end)
          : next.slice(0, close) + addElementPrefix(`<author>${NEW_AUTHOR}</author>`, prefix) + next.slice(close);
      }
      const markup = additions.map(note => commentMarkup(prefix, cellReference(note.row, note.col), Math.max(0, authorId), note.note)).join('');
      const list = firstXmlElement(next, 'commentList');
      if (list?.inner !== undefined) {
        const close = list.start + list.open.length + list.inner.length;
        next = next.slice(0, close) + markup + next.slice(close);
      } else if (list) {
        next = next.slice(0, list.start) + addElementPrefix('<commentList>', prefix) + markup + addElementPrefix('</commentList>', prefix) + next.slice(list.end);
      }
    }
    if (!firstXmlElement(next, 'comment')) dropPart(RelationshipTypes.Comments);
    else if (next !== comments) write(commentsPart, next);
  }

  // Note boxes: deleted ones go, moved ones follow their cells, shown/hidden ones switch, new ones appear.
  let vmlPart = target(RelationshipTypes.VmlDrawing);
  let vml = vmlPart ? read(vmlPart) : undefined;
  const newNotes = [
    ...[...changes.kept.values()].filter(kept => kept.replace).map(convertedNote),
    ...changes.added,
  ];
  if (!vml && newNotes.length) {
    vmlPart = nextPartName(files, index => `xl/drawings/vmlDrawing${index}.vml`);
    vml = NEW_VML;
    const id = addRelationship(RelationshipTypes.VmlDrawing, vmlPart);
    addDefaultContentType(files, 'vml', VML_CONTENT_TYPE);
    const worksheet = firstXmlElement(sheet, 'worksheet');
    const prefix = elementPrefix(worksheet?.name ?? '');
    const nextElement = AFTER_LEGACY_DRAWING.map(name => firstXmlElement(sheet, name)).filter(Boolean).sort((a, b) => a!.start - b!.start)[0];
    const at = nextElement ? nextElement.start : sheet.lastIndexOf('</');
    sheet = sheet.slice(0, at) + addElementPrefix(`<legacyDrawing r:id="${id}"/>`, prefix) + sheet.slice(at);
    if (worksheet && !/\sxmlns:r=/.test(worksheet.open)) sheet = sheet.replace(worksheet.open, worksheet.open.replace(/>$/, ` xmlns:r="${RELATIONSHIPS_NS}">`));
  }
  if (vmlPart && vml) {
    const prefixes = vmlPrefixes(vml);
    const existing = new Set<string>();
    let next = mapElements(vml, 'shape', element => {
      const data = element.inner ? firstXmlElement(element.inner, 'ClientData') : undefined;
      if (!data?.inner || xmlAttribute(data.open, 'ObjectType') !== 'Note') return undefined;
      const key = cellKey(Number(decodeXml(firstXmlElement(data.inner, 'Row')?.inner ?? '')), Number(decodeXml(firstXmlElement(data.inner, 'Column')?.inner ?? '')));
      if (changes.removed.has(key)) return null;
      const kept = changes.kept.get(key);
      existing.add(kept?.to ?? key);
      if (!kept || (kept.to === key && kept.show === undefined)) return undefined;
      let open = element.open;
      let inner = element.inner!;
      if (kept.to !== key) inner = moveNoteShape(inner, cellOfKey(key), cellOfKey(kept.to));
      if (kept.show !== undefined) {
        const style = (xmlAttribute(open, 'style') ?? '').replace(/visibility:\s*\w+/, `visibility:${kept.show ? 'visible' : 'hidden'}`);
        const visible = firstXmlElement(inner, 'Visible');
        if (kept.show && !visible) inner = inner.replace(/<\/((?:[\w.-]+:)?ClientData)>/, `<${prefixes.x}:Visible/></$1>`);
        if (!kept.show && visible) inner = inner.slice(0, visible.start) + inner.slice(visible.end);
        open = open.replace(/\sstyle="[^"]*"/, ` style="${style}"`);
      }
      return `${open}${inner}</${element.name}>`;
    });
    const ids = [...next.matchAll(/_x0000_s(\d+)/g)].map(match => Number(match[1]));
    let id = Math.max(1024, ...ids);
    const added = newNotes.filter(note => !existing.has(cellKey(note.row, note.col))).map(note => noteShape(note, ++id, prefixes)).join('');
    if (added) next = next.replace(/<\/xml>\s*$/, `${added}</xml>`);
    if (!firstXmlElement(next, 'shape')) dropPart(RelationshipTypes.VmlDrawing);
    else if (next !== vml) write(vmlPart, next);
  }
  if (rels !== undefined && rels !== read(relsPath)) write(relsPath, rels);
  return sheet;
}
