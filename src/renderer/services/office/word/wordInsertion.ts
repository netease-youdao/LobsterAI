import type { EditorCommand, SemanticPosition } from '@docx-editor.dev/core/contracts/editor';
import { type DocxEditorInstance, selectedDrawingOverlayTargetOf } from '@docx-editor.dev/core/editor';

import type { WordImage } from './wordImages';
import { BODY_STYLE_NAME, HEADING_STYLE_NAME } from './wordStyles';

/**
 * Tables and pictures inserted at the caret the way Word inserts them. The engine provides the
 * insertions; these helpers place the caret around them where the engine's own choice differs.
 */

/** What the engine's paragraph text shows for a picture or another inline object. */
const OBJECT_REPLACEMENT = '\uFFFC';
const UNDO = { type: 'undo' } as const;
/** The engine's refusal to insert a picture right before an inline object. */
const BEFORE_OBJECT_REFUSAL = 'invalid-range';

/** A picture a click landed on without the engine selecting it, and where the click left the caret. */
export interface MissedPicture {
  drawingNodeId: string;
  caret: SemanticPosition;
}

const sameCaret = (a: SemanticPosition, b: SemanticPosition) => a.paragraphId === b.paragraphId && a.offset === b.offset;
const caretAt = (position: SemanticPosition) => ({ type: 'setSelection', range: { anchor: position, head: position } }) as const;
/**
 * Resolves once the next paint has happened and the tasks it queued have run. A repaint makes
 * the browser report a selection change, and the engine then reads the caret back from the
 * browser's selection, overriding a caret set just before.
 */
const afterRepaint = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** The caret's paragraph as the engine lists it, with the id of the paragraph after it. */
function caretParagraph(editor: DocxEditorInstance): { text: string; styleId?: string; next?: string } | undefined {
  const range = editor.query({ type: 'selection' });
  const id = range && 'paraId' in range.to ? range.to.paraId : undefined;
  const paragraphs = editor.query({ type: 'paragraphs' });
  const index = id ? paragraphs.findIndex(paragraph => paragraph.paraId === id) : -1;
  return index < 0 ? undefined : { ...paragraphs[index], next: paragraphs[index + 1]?.paraId };
}

/**
 * Moves the caret to the start of a paragraph outside any table, where an inserted table follows
 * the line above without an empty paragraph between. Restores the caret and returns false when
 * there is no such paragraph.
 */
function caretToStartOf(editor: DocxEditorInstance, paraId: string | undefined, table: EditorCommand, caret: EditorCommand): boolean {
  if (!paraId) return false;
  if (editor.exec({ type: 'setSelection', anchor: { paraId } }).ok
    && !editor.query({ type: 'tableContext' }) && editor.can(table).ok) return true;
  editor.exec(caret);
  return false;
}

/** The body style's id when the given paragraph style is a heading or a title. */
function bodyStyleAfter(editor: DocxEditorInstance, styleId: string | undefined): string | undefined {
  const styles = editor.getDocumentStyles().filter(style => style.type === 'paragraph');
  const style = styles.find(candidate => candidate.styleId === styleId);
  if (!style || !HEADING_STYLE_NAME.test(style.name)) return undefined;
  return styles.find(candidate => candidate.name.toLowerCase() === BODY_STYLE_NAME.toLowerCase())?.styleId;
}

/**
 * Word's table grid: a table of this size at the caret, its columns sharing the text width. The
 * engine puts a table before the caret's paragraph; Word puts it at the caret: before a paragraph
 * the caret starts, after one it ends, and between the halves of one it splits. Returns the engine
 * undo steps taken, 0 when nothing was inserted.
 */
export function insertTableAtCaret(editor: DocxEditorInstance, rows: number, cols: number): number {
  const table = { type: 'insertTable', rows, cols } as const;
  if (!editor.surface || !editor.can(table).ok) return 0;
  const { head } = editor.surface.state().selection;
  const caret = caretAt(head);
  editor.exec(caret);
  let steps = 0;
  if (head.offset > 0) {
    const paragraph = caretParagraph(editor);
    const atEnd = Boolean(paragraph && head.offset >= paragraph.text.length);
    const inTable = editor.query({ type: 'tableContext' }) !== null;
    if (!atEnd || inTable || !caretToStartOf(editor, paragraph?.next, table, caret)) {
      // A plain paste of a line break splits the paragraph; its second half keeps the style, as in Word.
      if (!editor.exec({ type: 'paste', text: '\n' }).ok) return 0;
      steps += 1;
      // An empty paragraph left after a heading takes the body style, as Enter gives it in Word.
      const body = atEnd ? bodyStyleAfter(editor, paragraph?.styleId) : undefined;
      if (body && editor.exec({ type: 'setParagraphStyle', styleId: body }).ok) steps += 1;
    }
  }
  if (editor.exec(table).ok) return steps + 1;
  if (steps) for (let step = 0; step < steps; step++) editor.exec(UNDO);
  else editor.exec(caret);
  return 0;
}

/** Moves a collapsed caret past the inline objects that start at it. */
function caretPastObjects(editor: DocxEditorInstance): void {
  const selection = editor.surface?.state().selection;
  if (!selection || !sameCaret(selection.anchor, selection.head)) return;
  const text = caretParagraph(editor)?.text ?? '';
  let { offset } = selection.head;
  while (text[offset] === OBJECT_REPLACEMENT) offset += 1;
  if (offset !== selection.head.offset) editor.exec(caretAt({ paragraphId: selection.head.paragraphId, offset }));
}

/**
 * Inserts a picture at the caret. The engine refuses to insert one right before a picture or
 * another inline object, so a caret there, as after clicking a picture, moves past it first. The
 * engine then leaves the caret before the new picture; Word puts it after, so typing continues
 * after the picture and pictures inserted one after another line up.
 */
export async function insertPictureAtCaret(editor: DocxEditorInstance, image: WordImage): Promise<{ ok: true } | { ok: false; reason: string }> {
  const command = {
    type: 'insertImage', data: image.bytes, mime: image.mime, widthPoints: image.widthPoints, heightPoints: image.heightPoints,
  } as const;
  const insert = async () => {
    caretPastObjects(editor);
    const allowed = editor.canExecuteImageCommand(command);
    return allowed.ok ? editor.executeImageCommand(command) : allowed;
  };
  let result = await insert();
  // The caret moved past an object can be read back before the insertion lands; once settled, retry.
  if (!result.ok && result.reason === BEFORE_OBJECT_REFUSAL) {
    await afterRepaint();
    result = await insert();
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  const picture = editor.surface?.state().selection.head;
  await afterRepaint();
  const selection = editor.surface?.state().selection;
  if (picture && selection && sameCaret(selection.anchor, selection.head) && selection.head.paragraphId === picture.paragraphId
    && caretParagraph(editor)?.text[picture.offset] === OBJECT_REPLACEMENT) {
    editor.exec(caretAt({ paragraphId: picture.paragraphId, offset: picture.offset + 1 }));
  }
  return { ok: true };
}

/**
 * A click on an inline picture that wrapped onto a line of its own leaves the caret before it,
 * which the engine places at the end of the line above, where it finds no picture. Returns that
 * picture when the selection shows such a click.
 */
export function missedPicture(editor: DocxEditorInstance): MissedPicture | undefined {
  const surface = editor.surface;
  const intent = surface?.drawingSelectionIntent();
  if (!surface || intent?.kind !== 'pointer' || selectedDrawingOverlayTargetOf(surface)) return undefined;
  const { anchor, head } = surface.state().selection;
  return sameCaret(anchor, head) ? { drawingNodeId: intent.drawingNodeId, caret: head } : undefined;
}

/**
 * Selects a missed picture from just after it, where the engine finds it. Run once the click is
 * over: until then the engine reads the caret back from the browser's selection.
 */
export function selectMissedPicture(editor: DocxEditorInstance, picture: MissedPicture): void {
  const surface = editor.surface;
  if (!surface || selectedDrawingOverlayTargetOf(surface)) return;
  const { anchor, head } = surface.state().selection;
  if (!sameCaret(anchor, picture.caret) || !sameCaret(head, picture.caret)) return;
  if (!editor.exec(caretAt({ paragraphId: head.paragraphId, offset: head.offset + 1 })).ok) return;
  if (selectedDrawingOverlayTargetOf(surface)?.id !== picture.drawingNodeId) editor.exec(caretAt(head));
}
