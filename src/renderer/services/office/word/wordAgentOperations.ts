import type {
  AutomationAlignment, AutomationBatchResponse, AutomationFontWrite, AutomationHandle, AutomationHost, AutomationOperation,
  AutomationOperationResult, AutomationParagraphFormatWrite, AutomationSpanRef,
} from '@docx-editor.dev/core/automation';

import {
  WordAlignment, WordDocumentEdge, WordEditType, WordInsertPosition,
} from '../../../../shared/office/word/wordAgent';
import { BODY_STYLE_NAME, HEADING_STYLE_NAME } from './wordStyles';

/**
 * Translates the agent's paragraph-addressed edits into the engine's automation protocol.
 *
 * One automation batch commits atomically, but the engine refuses a batch that touches one
 * paragraph in two incompatible ways (a text edit beside a format, two inserts at one anchor).
 * Edits are therefore scheduled into rounds: each round is one batch of compatible steps, and a
 * step that needs a paragraph created earlier waits for the round that creates it. Callers get
 * all-or-nothing behaviour by running the same edits on a headless copy first.
 */

export class WordAgentError extends Error {}

export interface WordAgentParagraph {
  id: string;
  index: number;
  style: string;
  text: string;
  table?: { table: number; row: number; cell: number };
}

export interface WordAgentDocument {
  revision: number;
  total: number;
  offset: number;
  paragraphs: WordAgentParagraph[];
}

export interface WordAgentEdit {
  type: string;
  paragraph?: string;
  anchor?: string;
  position?: string;
  find?: string;
  replace?: string;
  occurrence?: number;
  text?: string;
  style?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  size?: number;
  font?: string;
  alignment?: string;
  lineSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  firstLineIndent?: number;
  leftIndent?: number;
  rows?: string[][];
}

export interface WordAgentEditResult {
  revision: number;
  applied: number;
  /** Batches that changed the document; each is one step in the engine's undo history. */
  commits: number;
  paragraphs: { id: string; text: string }[];
  warnings: string[];
}

const DEFAULT_READ_LIMIT = 300;
const MAX_READ_LIMIT = 1000;
const MAX_PARAGRAPH_TEXT = 4000;
const MAX_TABLE_CELLS = 2000;
const MAX_ROUNDS = 64;
const PARAGRAPH_ID = /^[0-9a-f]{8}$/i;
/** Joins lines of one inserted block until the engine splits them into paragraphs. */
const LINE_DELIMITER = '\uE0B7';
const ALIGNMENT: Record<string, AutomationAlignment> = {
  [WordAlignment.Left]: 'Left', [WordAlignment.Center]: 'Centered', [WordAlignment.Right]: 'Right', [WordAlignment.Justify]: 'Justified',
};

type Value = {
  kind: string; handle?: AutomationHandle; handles?: AutomationHandle[]; text?: string; name?: string;
  spans?: AutomationSpanRef[]; span?: AutomationSpanRef;
};

function batch(host: AutomationHost, operations: unknown[], expectedRevision?: number): AutomationBatchResponse {
  return host.execute({ operations: operations as AutomationOperation[], ...(expectedRevision === undefined ? {} : { expectedRevision }) });
}

function reasonOf(result: AutomationOperationResult | undefined): string {
  if (result?.status === 'error') return `${result.error.message}${result.error.detail ? ` (${result.error.detail})` : ''}`;
  return result ? result.status : 'refused';
}

function valueOf(result: AutomationOperationResult | undefined, what: string): Value {
  if (!result || result.status !== 'ok') throw new WordAgentError(`Could not read ${what}: ${reasonOf(result)}`);
  return result.value as Value;
}

function queryAll(host: AutomationHost, operations: unknown[], what: string): Value[] {
  if (!operations.length) return [];
  return batch(host, operations).results.map(result => valueOf(result, what));
}

interface ParagraphIndex {
  revision: number;
  body: AutomationHandle;
  handles: AutomationHandle[];
  ids: string[];
  byId: Map<string, AutomationHandle>;
}

function indexParagraphs(host: AutomationHost): ParagraphIndex {
  const revision = host.revision();
  const [document] = queryAll(host, [{ op: 'getDocument' }], 'the document');
  const [body] = queryAll(host, [{ op: 'getBody', document: document.handle }], 'the document body');
  const [list] = queryAll(host, [{ op: 'getParagraphs', body: body.handle }], 'paragraphs');
  const handles = list.handles ?? [];
  const ids = queryAll(host, handles.map(paragraph => ({ op: 'getParagraphId', paragraph })), 'paragraph ids').map(value => value.text ?? '');
  return { revision, body: body.handle!, handles, ids, byId: new Map(ids.map((id, index) => [id.toUpperCase(), handles[index]])) };
}

/** Cell coordinates for paragraphs inside top-level tables. */
function tableCells(host: AutomationHost, body: AutomationHandle): Map<string, WordAgentParagraph['table']> {
  const cells = new Map<string, WordAgentParagraph['table']>();
  const [tables] = queryAll(host, [{ op: 'getTables', scope: { body } }], 'tables');
  const rows = queryAll(host, (tables.handles ?? []).map(table => ({ op: 'getTableRows', table })), 'table rows');
  const rowRefs = rows.flatMap((value, table) => (value.handles ?? []).map((row, rowIndex) => ({ row, table, rowIndex })));
  const cellValues = queryAll(host, rowRefs.map(ref => ({ op: 'getTableCells', row: ref.row })), 'table cells');
  const cellRefs = cellValues.flatMap((value, index) => (value.handles ?? []).map((cell, cellIndex) => ({ ...rowRefs[index], cell, cellIndex })))
    .slice(0, MAX_TABLE_CELLS);
  const bodies = queryAll(host, cellRefs.map(ref => ({ op: 'getTableCellBody', cell: ref.cell })), 'cell bodies');
  const paragraphs = queryAll(host, bodies.map(value => ({ op: 'getParagraphs', body: value.handle })), 'cell paragraphs');
  const owners = paragraphs.flatMap((value, index) => (value.handles ?? []).map(paragraph => ({ paragraph, ref: cellRefs[index] })));
  queryAll(host, owners.map(owner => ({ op: 'getParagraphId', paragraph: owner.paragraph })), 'cell paragraph ids').forEach((value, index) => {
    const { table, rowIndex, cellIndex } = owners[index].ref;
    cells.set((value.text ?? '').toUpperCase(), { table, row: rowIndex, cell: cellIndex });
  });
  return cells;
}

export function readWordDocument(host: AutomationHost, options: { offset?: number; limit?: number } = {}): WordAgentDocument {
  const index = indexParagraphs(host);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_READ_LIMIT)));
  const slice = index.handles.slice(offset, offset + limit);
  const details = queryAll(host, slice.flatMap(paragraph => [
    { op: 'getText', target: paragraph }, { op: 'getStyle', span: { paragraph } },
  ]), 'paragraph text');
  const cells = tableCells(host, index.body);
  const paragraphs = slice.map((_, position): WordAgentParagraph => {
    const id = index.ids[offset + position];
    const text = details[position * 2].text ?? '';
    const table = cells.get(id.toUpperCase());
    return {
      id, index: offset + position, style: details[position * 2 + 1].name ?? '',
      text: text.length > MAX_PARAGRAPH_TEXT ? `${text.slice(0, MAX_PARAGRAPH_TEXT)}…` : text,
      ...(table ? { table } : {}),
    };
  });
  return { revision: index.revision, total: index.handles.length, offset, paragraphs };
}

const StepKind = {
  Text: 'text', Font: 'font', Format: 'format', Insert: 'insert', Split: 'split', Delete: 'delete', Table: 'table',
} as const;
type StepKind = typeof StepKind[keyof typeof StepKind];

/** A paragraph known now, or one a previous step creates (a split yields several). */
type Target = { handle: AutomationHandle } | { step: number; part?: number };

interface Step {
  id: number;
  edit: number;
  kind: StepKind;
  target: Target;
  find?: { text: string; occurrence?: number };
  text?: string;
  where?: 'before' | 'after';
  font?: AutomationFontWrite;
  format?: AutomationParagraphFormatWrite;
  table?: { location: 'Before' | 'After'; rowCount: number; columnCount: number; values: string[][] };
  /** Styles of inserted paragraphs: a refusal becomes a warning, not a failed call. */
  optional?: boolean;
}

/** Which steps the engine accepts on one paragraph within one batch. */
function compatible(used: Set<StepKind>, kind: StepKind): boolean {
  if (!used.size) return true;
  if (used.has(StepKind.Insert) || used.has(StepKind.Delete) || used.has(StepKind.Split)) return false;
  if (kind === StepKind.Insert || kind === StepKind.Delete || kind === StepKind.Split) return false;
  if (kind === StepKind.Text) return [...used].every(existing => existing === StepKind.Text);
  if (used.has(StepKind.Text)) return false;
  return !used.has(kind);
}

function requireString(value: unknown, field: string, edit: number): string {
  if (typeof value !== 'string' || !value.length) throw new WordAgentError(`Edit #${edit + 1}: "${field}" is required.`);
  return value;
}

const lines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** Plan the agent's edits as steps; nothing is written here. */
function planSteps(host: AutomationHost, index: ParagraphIndex, edits: WordAgentEdit[]): Step[] {
  const steps: Step[] = [];
  const add = (step: Omit<Step, 'id'>): number => { steps.push({ ...step, id: steps.length }); return steps.length - 1; };
  const paragraph = (id: unknown, edit: number, field = 'paragraph'): AutomationHandle => {
    const text = requireString(id, field, edit);
    const handle = PARAGRAPH_ID.test(text) ? index.byId.get(text.toUpperCase()) : undefined;
    if (!handle) throw new WordAgentError(`Edit #${edit + 1}: paragraph "${text}" does not exist. Call word_read for current ids.`);
    return handle;
  };
  const anchor = (edit: WordAgentEdit, at: number): { handle: AutomationHandle; where: 'before' | 'after' } => {
    if (edit.anchor === WordDocumentEdge.Start) return { handle: index.handles[0], where: WordInsertPosition.Before };
    if (edit.anchor === WordDocumentEdge.End) return { handle: index.handles[index.handles.length - 1], where: WordInsertPosition.After };
    return { handle: paragraph(edit.anchor, at, 'anchor'), where: edit.position === WordInsertPosition.Before ? WordInsertPosition.Before : WordInsertPosition.After };
  };
  /** A block of lines lands as one paragraph, then splits into one paragraph per line. */
  const writeLines = (at: number, created: number, count: number, style?: string) => {
    let parts: Target[] = [{ step: created }];
    if (count > 1) {
      const split = add({ edit: at, kind: StepKind.Split, target: { step: created } });
      parts = Array.from({ length: count }, (_, part) => ({ step: split, part }));
    }
    if (style) for (const target of parts) add({ edit: at, kind: StepKind.Format, target, format: { style }, optional: true });
  };

  edits.forEach((edit, at) => {
    switch (edit?.type) {
      case WordEditType.ReplaceText:
        add({ edit: at, kind: StepKind.Text, target: { handle: paragraph(edit.paragraph, at) },
          find: { text: requireString(edit.find, 'find', at), occurrence: edit.occurrence }, text: typeof edit.replace === 'string' ? edit.replace : '' });
        break;
      case WordEditType.SetText: {
        const target = paragraph(edit.paragraph, at);
        const texts = lines(typeof edit.text === 'string' ? edit.text : '');
        const created = add({ edit: at, kind: StepKind.Text, target: { handle: target }, text: texts.join(LINE_DELIMITER) });
        if (texts.length > 1) add({ edit: at, kind: StepKind.Split, target: { step: created } });
        break;
      }
      case WordEditType.InsertParagraph: {
        const target = anchor(edit, at);
        const texts = lines(requireString(edit.text, 'text', at));
        const anchorStyle = queryAll(host, [{ op: 'getStyle', span: { paragraph: target.handle } }], 'anchor style')[0].name ?? '';
        // Word gives the paragraph after a heading its body style; do the same unless told otherwise.
        const style = edit.style ?? (HEADING_STYLE_NAME.test(anchorStyle) ? BODY_STYLE_NAME : undefined);
        const created = add({ edit: at, kind: StepKind.Insert, target: { handle: target.handle }, where: target.where, text: texts.join(LINE_DELIMITER) });
        writeLines(at, created, texts.length, style);
        break;
      }
      case WordEditType.DeleteParagraph:
        add({ edit: at, kind: StepKind.Delete, target: { handle: paragraph(edit.paragraph, at) } });
        break;
      case WordEditType.FormatText: {
        const font: AutomationFontWrite = {
          ...(edit.bold !== undefined ? { bold: edit.bold } : {}),
          ...(edit.italic !== undefined ? { italic: edit.italic } : {}),
          ...(edit.underline !== undefined ? { underline: edit.underline ? 'Single' : 'None' } : {}),
          ...(edit.strike !== undefined ? { strikeThrough: edit.strike } : {}),
          ...(edit.color ? { color: edit.color } : {}),
          ...(edit.highlight ? { highlightColor: edit.highlight.toLowerCase() === 'none' ? null : edit.highlight } : {}),
          ...(edit.size !== undefined ? { size: edit.size } : {}),
          ...(edit.font ? { name: edit.font } : {}),
        };
        if (!Object.keys(font).length) throw new WordAgentError(`Edit #${at + 1}: format_text needs at least one formatting field.`);
        add({ edit: at, kind: StepKind.Font, target: { handle: paragraph(edit.paragraph, at) }, font,
          ...(edit.find ? { find: { text: edit.find, occurrence: edit.occurrence } } : {}) });
        break;
      }
      case WordEditType.FormatParagraph: {
        if (edit.alignment && !ALIGNMENT[edit.alignment]) throw new WordAgentError(`Edit #${at + 1}: unknown alignment "${edit.alignment}".`);
        const format: AutomationParagraphFormatWrite = {
          ...(edit.style ? { style: edit.style } : {}),
          ...(edit.alignment ? { alignment: ALIGNMENT[edit.alignment] } : {}),
          ...(edit.lineSpacing !== undefined ? { lineSpacing: edit.lineSpacing } : {}),
          ...(edit.spaceBefore !== undefined ? { spaceBefore: edit.spaceBefore } : {}),
          ...(edit.spaceAfter !== undefined ? { spaceAfter: edit.spaceAfter } : {}),
          ...(edit.firstLineIndent !== undefined ? { firstLineIndent: edit.firstLineIndent } : {}),
          ...(edit.leftIndent !== undefined ? { leftIndent: edit.leftIndent } : {}),
        };
        if (!Object.keys(format).length) throw new WordAgentError(`Edit #${at + 1}: format_paragraph needs at least one field.`);
        add({ edit: at, kind: StepKind.Format, target: { handle: paragraph(edit.paragraph, at) }, format });
        break;
      }
      case WordEditType.InsertTable: {
        const rows = Array.isArray(edit.rows) ? edit.rows.map(row => (Array.isArray(row) ? row.map(cell => String(cell ?? '')) : [])) : [];
        const columnCount = Math.max(0, ...rows.map(row => row.length));
        if (!rows.length || !columnCount || rows.length > 200 || columnCount > 30) {
          throw new WordAgentError(`Edit #${at + 1}: rows must be a non-empty table of at most 200 rows and 30 columns.`);
        }
        const target = anchor(edit, at);
        add({ edit: at, kind: StepKind.Table, target: { handle: target.handle }, table: {
          location: target.where === WordInsertPosition.Before ? 'Before' : 'After', rowCount: rows.length, columnCount,
          values: rows.map(row => [...row, ...Array<string>(columnCount - row.length).fill('')]),
        } });
        break;
      }
      default:
        throw new WordAgentError(`Edit #${at + 1}: unknown edit type "${String(edit?.type)}".`);
    }
  });
  return steps;
}

/**
 * Apply one agent call. Rounds run in order; a refused round stops the call, so run the same
 * edits on a headless copy first when the live document must stay untouched on failure.
 */
export function applyWordEdits(host: AutomationHost, request: { expectedRevision?: number; edits: WordAgentEdit[] }): WordAgentEditResult {
  const edits = Array.isArray(request.edits) ? request.edits : [];
  if (!edits.length) throw new WordAgentError('No edits were provided.');
  const current = host.revision();
  if (request.expectedRevision !== undefined && request.expectedRevision !== current) {
    throw new WordAgentError(`The document changed since revision ${request.expectedRevision} (now ${current}). Call word_read again and retry with the new ids and revision.`);
  }
  const index = indexParagraphs(host);
  const steps = planSteps(host, index, edits);
  const produced = new Map<number, AutomationHandle[]>();
  const touched = new Map<string, AutomationHandle>();
  const deleted = new Set<string>();
  const warnings: string[] = [];
  let commits = 0;
  const resolve = (target: Target): AutomationHandle | undefined =>
    ('handle' in target ? target.handle : produced.get(target.step)?.[target.part ?? 0]);

  const runRound = (round: Step[]): void => {
    const searches = round.filter(step => step.find);
    const found = queryAll(host, searches.map(step => ({
      op: 'search', scope: { paragraph: resolve(step.target) }, text: step.find!.text, options: { matchCase: true },
    })), 'search results');
    const spans = new Map<number, AutomationSpanRef>();
    searches.forEach((step, position) => {
      const matches = found[position].spans ?? [];
      const { text, occurrence } = step.find!;
      const label = `Edit #${step.edit + 1}`;
      if (!matches.length) throw new WordAgentError(`${label}: "${text}" was not found in paragraph ${edits[step.edit].paragraph}.`);
      if (occurrence === undefined && matches.length > 1) {
        throw new WordAgentError(`${label}: "${text}" occurs ${matches.length} times in paragraph ${edits[step.edit].paragraph}; pass "occurrence" (1-based) or a longer phrase.`);
      }
      const span = matches[(occurrence ?? 1) - 1];
      if (!span) throw new WordAgentError(`${label}: occurrence ${occurrence} does not exist (${matches.length} found).`);
      spans.set(step.id, span);
    });
    const operations = round.map(step => {
      const paragraph = resolve(step.target)!;
      switch (step.kind) {
        case StepKind.Text: return { op: 'replaceSpan', span: spans.get(step.id) ?? { paragraph }, text: step.text };
        case StepKind.Font: return { op: 'setFont', span: spans.get(step.id) ?? { paragraph }, font: step.font };
        case StepKind.Format: return { op: 'setParagraphFormat', paragraph: { paragraph }, format: step.format };
        case StepKind.Insert: return { op: 'insertParagraph', anchor: { paragraph }, where: step.where, text: step.text };
        case StepKind.Split: return { op: 'splitParagraph', paragraph, delimiters: [LINE_DELIMITER], trimDelimiters: true };
        case StepKind.Delete: return { op: 'deleteParagraph', paragraph };
        case StepKind.Table: return { op: 'insertTable', span: { paragraph }, ...step.table };
      }
    });
    const response = batch(host, operations, host.revision());
    if (!response.ok) {
      const failed = Math.max(0, response.results.findIndex(result => result.status === 'error'));
      const step = round[failed];
      throw new WordAgentError(`Edit #${step.edit + 1} (${edits[step.edit].type}) was refused: ${reasonOf(response.results[failed])}.`);
    }
    if (response.changed) commits++;
    round.forEach((step, position) => {
      const value = (response.results[position] as { value?: Value }).value;
      if (step.kind === StepKind.Insert && value?.handle) produced.set(step.id, [value.handle]);
      if (step.kind === StepKind.Split) {
        const parts = (value?.spans ?? []).flatMap(span => ('start' in span && 'paragraph' in span.start ? [span.start.paragraph] : []));
        produced.set(step.id, parts);
      }
      const paragraph = resolve(step.target);
      if (step.kind === StepKind.Delete && paragraph) deleted.add(paragraph.ref);
      else if (paragraph) touched.set(paragraph.ref, paragraph);
      for (const handle of produced.get(step.id) ?? []) touched.set(handle.ref, handle);
    });
  };

  const schedule = (pending: Step[], optional: boolean): void => {
    let queue = pending;
    for (let round = 0; queue.length; round++) {
      if (round >= MAX_ROUNDS) throw new WordAgentError('Too many dependent edits in one call; split them into several word_edit calls.');
      const used = new Map<string, Set<StepKind>>();
      const blocked = new Set<string>();
      const batchSteps: Step[] = [];
      const deferred: Step[] = [];
      let solitary = false;
      for (const step of queue) {
        const paragraph = resolve(step.target);
        const key = paragraph?.ref ?? `step:${'step' in step.target ? step.target.step : ''}`;
        const kinds = used.get(key) ?? new Set<StepKind>();
        const fits = paragraph && !solitary && !blocked.has(key) && compatible(kinds, step.kind)
          && (step.kind !== StepKind.Table || !batchSteps.length);
        if (!fits) {
          // Later steps on the same paragraph keep their order behind this one.
          blocked.add(key);
          deferred.push(step);
          continue;
        }
        kinds.add(step.kind);
        used.set(key, kinds);
        batchSteps.push(step);
        if (step.kind === StepKind.Table) solitary = true;
      }
      if (!batchSteps.length) throw new WordAgentError('Some edits depend on paragraphs that were never created.');
      if (!optional) runRound(batchSteps);
      else {
        try {
          runRound(batchSteps);
        } catch {
          // Salvage what applies; report the styles the document does not define.
          for (const step of batchSteps) {
            try { runRound([step]); } catch { warnings.push(`Paragraph style "${step.format?.style}" could not be applied (edit #${step.edit + 1}). Use a style name defined in this document.`); }
          }
        }
      }
      queue = deferred;
    }
  };
  schedule(steps.filter(step => !step.optional), false);
  schedule(steps.filter(step => step.optional), true);

  const handles = [...touched.values()].filter(handle => !deleted.has(handle.ref));
  const details = handles.length ? batch(host, handles.flatMap(handle => [{ op: 'getParagraphId', paragraph: handle }, { op: 'getText', target: handle }])).results : [];
  const paragraphs = handles.flatMap((_, position) => {
    const id = details[position * 2];
    const text = details[position * 2 + 1];
    return id?.status === 'ok' && text?.status === 'ok' ? [{ id: (id.value as Value).text ?? '', text: (text.value as Value).text ?? '' }] : [];
  });
  return { revision: host.revision(), applied: edits.length, commits, paragraphs, warnings };
}
