import { SlidesAlignment, SlidesEditType, SlidesShapeKind } from '../../../../shared/office/slides/slidesAgent';
import {
  addSlide, deleteSlide, duplicateSlide, layoutAfter, layoutName, layoutOf, layouts, moveSlide, notesText, setNotes, type SlideRef, slideRefs,
  SlidesEditError, slideSize,
} from './slidesDeck';
import { shapeBoxEmu } from './slidesModel';
import type { SlidesPackage } from './slidesPackage';
import {
  addTextBox, cellBody, deleteShape, ensureTextBody, findShape, placeholderOf, setShapeBounds, shapeIdOf, shapeNameOf, shapesIn, shapeText,
  slideTree, tableOf, textBodies,
} from './slidesShapes';
import {
  bodyText, countInBody, findInBody, formatLines, formatRange, linesOf, paragraphsOf, replaceRange, setAlignment, setBodyText, setLevel, SlidesAlign,
  type TextStyleChange,
} from './slidesText';
import { el, elements, emuFromPt, named, ptFromEmu } from './slidesXml';

/** A shape as ppt_read reports it. */
export interface SlidesShapeSummary {
  id: string;
  name: string;
  kind: SlidesShapeKind;
  placeholder?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  table?: string[][];
  group?: string;
}

export interface SlidesSummary {
  slideCount: number;
  slideWidth: number;
  slideHeight: number;
  layouts: string[];
  slides: {
    slide: number;
    layout: string;
    hidden?: boolean;
    notes?: string;
    shapes: SlidesShapeSummary[];
  }[];
}

const PLACEHOLDER_ROLE: Record<string, string> = {
  title: 'title', ctrTitle: 'title', subTitle: 'subtitle', body: 'body', obj: 'body', dt: 'date', ftr: 'footer', sldNum: 'slideNumber',
  pic: 'picture', tbl: 'table', chart: 'chart', dgm: 'diagram', media: 'media', clipArt: 'picture', hdr: 'header', sldImg: 'slideImage',
};

function kindOf(shape: Element): SlidesShapeKind {
  switch (shape.localName) {
    case 'pic': return SlidesShapeKind.Picture;
    case 'grpSp': return SlidesShapeKind.Group;
    case 'graphicFrame': {
      const uri = el(named(shape, 'graphic'), 'a:graphicData')?.getAttribute('uri') ?? '';
      if (uri.endsWith('/table')) return SlidesShapeKind.Table;
      if (uri.endsWith('/chart')) return SlidesShapeKind.Chart;
      return SlidesShapeKind.Other;
    }
    default: {
      const textBox = named(elements(shape)[0], 'cNvSpPr')?.getAttribute('txBox') === '1';
      return placeholderOf(shape) || textBox ? SlidesShapeKind.Text : SlidesShapeKind.Shape;
    }
  }
}

/** Parse "1-3,5" into positions from 0; everything when unset. */
export function slideSelection(spec: unknown, count: number): number[] {
  if (spec === undefined || spec === null || spec === '') return Array.from({ length: count }, (_, index) => index);
  const selected = new Set<number>();
  for (const part of String(spec).split(',')) {
    const range = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!range) throw new SlidesEditError(`"${String(spec)}" is not a slide list such as "1-3,5".`);
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    for (let slide = from; slide <= to; slide++) if (slide >= 1 && slide <= count) selected.add(slide - 1);
  }
  return [...selected].sort((a, b) => a - b);
}

function summarize(pkg: SlidesPackage, ref: SlideRef, shape: Element, group: Element | undefined): SlidesShapeSummary {
  const box = shapeBoxEmu(pkg, ref.part, shape);
  const ph = placeholderOf(shape);
  const table = tableOf(shape);
  const text = named(shape, 'txBody') ? shapeText(shape) : undefined;
  return {
    id: shapeIdOf(shape),
    name: shapeNameOf(shape),
    kind: kindOf(shape),
    ...(ph ? { placeholder: PLACEHOLDER_ROLE[ph.getAttribute('type') ?? 'obj'] ?? ph.getAttribute('type') ?? 'body' } : {}),
    ...(box ? { x: ptFromEmu(box.x), y: ptFromEmu(box.y), width: ptFromEmu(box.w), height: ptFromEmu(box.h) } : {}),
    ...(text?.trim() ? { text } : {}),
    ...(table ? { table: elements(table, 'a:tr').map(row => elements(row, 'a:tc').map(cell => formatLines(bodyText(el(cell, 'a:txBody'))))) } : {}),
    ...(group ? { group: shapeIdOf(group) } : {}),
  };
}

export function readSlides(pkg: SlidesPackage, options: { slides?: unknown } = {}): SlidesSummary {
  const refs = slideRefs(pkg);
  const size = slideSize(pkg);
  return {
    slideCount: refs.length,
    slideWidth: ptFromEmu(size.cx),
    slideHeight: ptFromEmu(size.cy),
    layouts: [...new Set(layouts(pkg).map(layout => layout.name).filter(Boolean))],
    slides: slideSelection(options.slides, refs.length).map(index => {
      const ref = refs[index];
      const layout = layoutOf(pkg, ref.part);
      const notes = notesText(pkg, ref.part);
      return {
        slide: index + 1,
        layout: layout ? layoutName(pkg, layout) : '',
        ...(ref.hidden ? { hidden: true } : {}),
        ...(notes.trim() ? { notes } : {}),
        shapes: shapesIn(slideTree(pkg.xml(ref.part))).map(({ shape, group }) => summarize(pkg, ref, shape, group)),
      };
    }),
  };
}

/** One edit as the agent sends it; the fields each type uses are checked when it runs. */
export type SlidesAgentEdit = Record<string, unknown> & { type?: unknown };

export interface SlidesEditResult {
  applied: number;
  /** Slides (from 1, after all edits) and shapes the call changed. */
  changed: { slide: number; shape?: string }[];
  /** The slide to show afterwards, and the shape on it to select. */
  focus?: { slide: number; shape?: string };
}

const ALIGN: Record<string, typeof SlidesAlign[keyof typeof SlidesAlign]> = {
  [SlidesAlignment.Left]: SlidesAlign.Left, [SlidesAlignment.Center]: SlidesAlign.Center,
  [SlidesAlignment.Right]: SlidesAlign.Right, [SlidesAlignment.Justify]: SlidesAlign.Justify,
};

/** Typed access to one edit's fields, with the agent-facing messages for wrong ones. */
class EditReader {
  constructor(private readonly edit: SlidesAgentEdit) {}

  private value(name: string, required: boolean): unknown {
    const value = this.edit[name];
    if ((value === undefined || value === null) && required) throw new SlidesEditError(`"${name}" is required.`);
    return value ?? undefined;
  }

  text(name: string, required = true): string | undefined {
    const value = this.value(name, required);
    if (value !== undefined && typeof value !== 'string') throw new SlidesEditError(`"${name}" must be a string.`);
    return value as string | undefined;
  }

  number(name: string, required = true): number | undefined {
    const value = this.value(name, required);
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new SlidesEditError(`"${name}" must be a number.`);
    return value as number | undefined;
  }

  /** A whole number from 1, such as a paragraph, row or occurrence. */
  ordinal(name: string, required = true): number | undefined {
    const value = this.number(name, required);
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new SlidesEditError(`"${name}" must be a whole number from 1.`);
    return value;
  }

  bool(name: string): boolean | undefined {
    const value = this.value(name, false);
    if (value !== undefined && typeof value !== 'boolean') throw new SlidesEditError(`"${name}" must be true or false.`);
    return value as boolean | undefined;
  }

  alignment(): typeof SlidesAlign[keyof typeof SlidesAlign] | undefined {
    const value = this.text('alignment', false);
    if (value !== undefined && !ALIGN[value]) throw new SlidesEditError('"alignment" must be left, center, right or justify.');
    return value === undefined ? undefined : ALIGN[value];
  }

  style(): TextStyleChange {
    const color = this.text('color', false);
    if (color !== undefined && !/^#?[0-9a-f]{6}$/i.test(color)) throw new SlidesEditError('"color" must look like #C00000.');
    const size = this.number('size', false);
    if (size !== undefined && (size < 1 || size > 4000)) throw new SlidesEditError('"size" must be between 1 and 4000 points.');
    const font = this.text('font', false);
    if (font !== undefined && !font.trim()) throw new SlidesEditError('"font" must not be empty.');
    const change: TextStyleChange = {
      bold: this.bool('bold'), italic: this.bool('italic'), underline: this.bool('underline'), strike: this.bool('strike'),
      color: color?.replace(/^#/, ''), size, font: font?.trim(),
    };
    for (const key of Object.keys(change) as (keyof TextStyleChange)[]) if (change[key] === undefined) delete change[key];
    return change;
  }
}

interface Touched {
  slideId: number;
  shape?: string;
}

function slideAt(pkg: SlidesPackage, value: unknown): SlideRef {
  const refs = slideRefs(pkg);
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new SlidesEditError('"slide" must be a slide number from 1.');
  const ref = refs[value - 1];
  if (!ref) throw new SlidesEditError(`There is no slide ${value}; the presentation has ${refs.length}.`);
  return ref;
}

/** The `occurrence`-th match of `find` across bodies, counting on from `seen`. */
function nthMatch(bodies: Element[], find: string, occurrence: number, seen = { count: 0 }) {
  for (const body of bodies) {
    const count = countInBody(body, find);
    if (seen.count + count >= occurrence) {
      const match = findInBody(body, find, occurrence - seen.count)!;
      return { paragraph: paragraphsOf(body)[match.paragraph], start: match.start, end: match.end };
    }
    seen.count += count;
  }
  return undefined;
}

function applyEdit(pkg: SlidesPackage, edit: SlidesAgentEdit, touched: Touched[]): void {
  const read = new EditReader(edit);
  /** The slide and shape the edit names, the slide opened for changing. */
  const target = () => {
    const ref = slideAt(pkg, edit.slide);
    const doc = pkg.edit(ref.part);
    const shape = findShape(slideTree(doc), edit.shape);
    touched.push({ slideId: ref.id, shape: shapeIdOf(shape) });
    return { ref, doc, shape };
  };
  switch (edit.type) {
    case SlidesEditType.SetText: {
      const text = read.text('text')!;
      setBodyText(ensureTextBody(target().shape), linesOf(text));
      return;
    }
    case SlidesEditType.ReplaceText: {
      const find = read.text('find')!;
      const replacement = read.text('replace')!;
      if (!find) throw new SlidesEditError('"find" must not be empty.');
      const occurrence = read.ordinal('occurrence', false) ?? 1;
      if (edit.shape !== undefined && edit.slide === undefined) throw new SlidesEditError('"shape" needs "slide".');
      const seen = { count: 0 };
      for (const ref of edit.slide === undefined ? slideRefs(pkg) : [slideAt(pkg, edit.slide)]) {
        const tree = slideTree(pkg.xml(ref.part));
        for (const shape of edit.shape === undefined ? shapesIn(tree).map(item => item.shape) : [findShape(tree, edit.shape)]) {
          const match = nthMatch(textBodies(shape), find, occurrence, seen);
          if (!match) continue;
          pkg.edit(ref.part);
          replaceRange(match.paragraph, match.start, match.end, replacement);
          touched.push({ slideId: ref.id, shape: shapeIdOf(shape) });
          return;
        }
      }
      throw new SlidesEditError(`"${find}" was not found${occurrence > 1 ? ` ${occurrence} times` : ''}.`);
    }
    case SlidesEditType.FormatText: {
      const style = read.style();
      if (!Object.keys(style).length) throw new SlidesEditError('Give at least one of bold, italic, underline, strike, color, size or font.');
      const find = read.text('find', false);
      const occurrence = read.ordinal('occurrence', false) ?? 1;
      const paragraph = read.ordinal('paragraph', false);
      const bodies = textBodies(target().shape);
      if (!bodies.length) throw new SlidesEditError('That shape has no text.');
      if (find) {
        const match = nthMatch(bodies, find, occurrence);
        if (!match) throw new SlidesEditError(`"${find}" was not found in that shape.`);
        formatRange(match.paragraph, style, match.start, match.end);
      } else if (paragraph !== undefined) {
        const item = bodies.flatMap(paragraphsOf)[paragraph - 1];
        if (!item) throw new SlidesEditError(`That shape has no paragraph ${paragraph}.`);
        formatRange(item, style);
      } else {
        for (const item of bodies.flatMap(paragraphsOf)) formatRange(item, style);
      }
      return;
    }
    case SlidesEditType.FormatParagraph: {
      const alignment = read.alignment();
      const level = read.number('level', false);
      if (alignment === undefined && level === undefined) throw new SlidesEditError('Give alignment or level.');
      if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 8)) throw new SlidesEditError('"level" must be a whole number from 0 to 8.');
      const number = read.ordinal('paragraph', false);
      const paragraphs = textBodies(target().shape).flatMap(paragraphsOf);
      const items = number === undefined ? paragraphs : [paragraphs[number - 1]].filter(Boolean);
      if (!items.length) throw new SlidesEditError(number === undefined ? 'That shape has no text.' : `That shape has no paragraph ${number}.`);
      for (const item of items) {
        if (alignment !== undefined) setAlignment(item, alignment);
        if (level !== undefined) setLevel(item, level);
      }
      return;
    }
    case SlidesEditType.SetTableCell: {
      const row = read.ordinal('row')!;
      const column = read.ordinal('column')!;
      const text = read.text('text')!;
      setBodyText(cellBody(target().shape, row - 1, column - 1), linesOf(text));
      return;
    }
    case SlidesEditType.SetBounds: {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(name => read.number(name, false));
      if ([x, y, w, h].every(value => value === undefined)) throw new SlidesEditError('Give at least one of x, y, width or height.');
      if ((w !== undefined && w <= 0) || (h !== undefined && h <= 0)) throw new SlidesEditError('"width" and "height" must be positive.');
      const { ref, shape } = target();
      setShapeBounds(pkg, ref.part, shape, {
        ...(x !== undefined ? { x: emuFromPt(x) } : {}), ...(y !== undefined ? { y: emuFromPt(y) } : {}),
        ...(w !== undefined ? { w: emuFromPt(w) } : {}), ...(h !== undefined ? { h: emuFromPt(h) } : {}),
      });
      return;
    }
    case SlidesEditType.DeleteShape: {
      const { doc, shape } = target();
      deleteShape(doc, shape);
      // The slide changed; the shape is gone.
      delete touched[touched.length - 1].shape;
      return;
    }
    case SlidesEditType.AddTextBox: {
      const text = read.text('text')!;
      const style = read.style();
      const alignment = read.alignment();
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => read.number(name, false));
      if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) throw new SlidesEditError('"width" and "height" must be positive.');
      const ref = slideAt(pkg, edit.slide);
      const size = slideSize(pkg);
      const w = width !== undefined ? emuFromPt(width) : Math.round(size.cx * 0.6);
      const h = emuFromPt(height ?? 40);
      const doc = pkg.edit(ref.part);
      const id = addTextBox(doc, slideTree(doc), {
        x: x !== undefined ? emuFromPt(x) : (size.cx - w) / 2,
        y: y !== undefined ? emuFromPt(y) : (size.cy - h) / 2,
        w, h,
      }, text, style, alignment);
      touched.push({ slideId: ref.id, shape: id });
      return;
    }
    case SlidesEditType.AddSlide: {
      const refs = slideRefs(pkg);
      const after = read.number('after', false) ?? refs.length;
      if (!Number.isInteger(after) || after < 0 || after > refs.length) throw new SlidesEditError(`"after" must be a slide number from 0 to ${refs.length}.`);
      const wanted = read.text('layout', false);
      const all = layouts(pkg);
      const layout = wanted !== undefined
        ? (all.find(item => item.name === wanted) ?? all.find(item => item.name.toLowerCase() === wanted.trim().toLowerCase()))?.part
        : layoutAfter(pkg, refs[Math.max(0, after - 1)]?.part);
      if (!layout) {
        throw new SlidesEditError(wanted !== undefined ? `There is no layout "${wanted}"; the layouts are: ${all.map(item => item.name).join(', ')}.` : 'The presentation has no layouts.');
      }
      const ref = addSlide(pkg, { layout, after: after - 1, title: read.text('title', false), body: read.text('body', false) });
      touched.push({ slideId: ref.id });
      return;
    }
    case SlidesEditType.DuplicateSlide:
      touched.push({ slideId: duplicateSlide(pkg, slideAt(pkg, edit.slide).index).id });
      return;
    case SlidesEditType.DeleteSlide:
      deleteSlide(pkg, slideAt(pkg, edit.slide).index);
      return;
    case SlidesEditType.MoveSlide: {
      const ref = slideAt(pkg, edit.slide);
      const position = read.ordinal('position')!;
      const count = slideRefs(pkg).length;
      if (position > count) throw new SlidesEditError(`"position" must be from 1 to ${count}.`);
      moveSlide(pkg, ref.index, position - 1);
      touched.push({ slideId: ref.id });
      return;
    }
    case SlidesEditType.SetNotes: {
      const ref = slideAt(pkg, edit.slide);
      setNotes(pkg, ref.part, read.text('text')!);
      touched.push({ slideId: ref.id });
      return;
    }
    default:
      throw new SlidesEditError(`Unknown edit type "${String(edit.type)}".`);
  }
}

/** Apply agent edits in order. Run it inside a package transaction: a refused edit throws halfway. */
export function applySlidesEdits(pkg: SlidesPackage, edits: unknown): SlidesEditResult {
  if (!Array.isArray(edits) || !edits.length) throw new SlidesEditError('"edits" must be a non-empty list.');
  if (edits.length > 200) throw new SlidesEditError('At most 200 edits per call.');
  const touched: Touched[] = [];
  edits.forEach((raw: unknown, index) => {
    if (!raw || typeof raw !== 'object') throw new SlidesEditError(`Edit ${index + 1} is not an object.`);
    const edit = raw as SlidesAgentEdit;
    try {
      applyEdit(pkg, edit, touched);
    } catch (error) {
      if (error instanceof SlidesEditError) throw new SlidesEditError(`Edit ${index + 1} (${String(edit.type)}): ${error.message}`, error.code);
      throw error;
    }
  });
  const positions = new Map(slideRefs(pkg).map(ref => [ref.id, ref.index + 1]));
  const changed: SlidesEditResult['changed'] = [];
  for (const item of touched) {
    const slide = positions.get(item.slideId);
    if (slide === undefined || changed.some(other => other.slide === slide && other.shape === item.shape)) continue;
    changed.push({ slide, ...(item.shape ? { shape: item.shape } : {}) });
  }
  // Show the last change; on its slide, select the shape changed last.
  const last = changed[changed.length - 1];
  const focus = last && (last.shape ? last : [...changed].reverse().find(item => item.slide === last.slide && item.shape) ?? last);
  return { applied: edits.length, changed, ...(focus ? { focus } : {}) };
}
