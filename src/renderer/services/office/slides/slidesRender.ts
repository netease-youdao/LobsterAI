import { geometryPath, isLineGeometry } from './slidesGeometry';
import {
  type Box, type Fill, type Line, type ParagraphView, type RunStyle, type ShapeView, ShapeViewKind, type SlideView, type TableView, type TextView,
} from './slidesModel';

/**
 * Draws a SlideView as HTML: positioned shapes with their fills, outlines and text, pictures,
 * tables and groups. The stage and the thumbnails use the same drawing, so what the list shows is
 * what the slide looks like. Text elements carry the paragraph and run positions they came from,
 * so text edited in place can be written back without losing its formatting.
 */

export interface SlideRenderLabels {
  /** PowerPoint's prompts for empty placeholders. */
  titlePrompt: string;
  subtitlePrompt: string;
  textPrompt: string;
  /** What stands in for content the editor does not draw. */
  chart: string;
  diagram: string;
  object: string;
  picture: string;
}

export interface SlideRenderOptions {
  /** A picture part as a URL the page can show, or undefined when it cannot be shown (EMF, TIFF). */
  image: (part: string) => string | undefined;
  /** PowerPoint's editing view: empty placeholders show their outline and prompt. */
  editing: boolean;
  labels: SlideRenderLabels;
}

export const SlideElement = {
  Slide: 'lobster-slide',
  Shape: 'lobster-slide-shape',
  Text: 'lobster-slide-text',
  Paragraph: 'lobster-slide-paragraph',
  Cell: 'lobster-slide-cell',
} as const;

const PX_PER_PT = 96 / 72;
let markerCount = 0;

const px = (value: number): string => `${Math.round(value * 100) / 100}px`;

function fillCss(fill: Fill, image: SlideRenderOptions['image']): string | undefined {
  switch (fill.kind) {
    case 'solid': return fill.color;
    case 'gradient': return fill.css;
    case 'image': {
      const url = image(fill.part);
      return url ? `center / 100% 100% no-repeat url("${url}")` : undefined;
    }
    default: return undefined;
  }
}

const DASHES: Record<string, number[]> = {
  dot: [1, 2], sysDot: [1, 1], dash: [4, 3], sysDash: [3, 1], lgDash: [8, 3],
  dashDot: [4, 3, 1, 3], sysDashDot: [3, 1, 1, 1], lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDashDotDot: [3, 1, 1, 1, 1, 1],
};
const ARROWS = new Set(['triangle', 'arrow', 'stealth', 'diamond', 'oval']);

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** An outline along `path`, with arrowheads for lines that have them. */
function strokeLayer(line: Line, path: string, w: number, h: number): SVGSVGElement {
  const layer = svg('svg', { class: 'lobster-slide-stroke', width: Math.max(1, w), height: Math.max(1, h) });
  const stroke = svg('path', { d: path, fill: 'none', stroke: line.color, 'stroke-width': line.width, 'stroke-linejoin': 'round' });
  const dash = line.dash ? DASHES[line.dash] : undefined;
  if (dash) stroke.setAttribute('stroke-dasharray', dash.map(part => part * line.width).join(' '));
  const ends = [['marker-start', line.headEnd], ['marker-end', line.tailEnd]] as const;
  if (ends.some(([, type]) => type && ARROWS.has(type))) {
    const id = `lobster-slide-arrow-${++markerCount}`;
    const defs = svg('defs', {});
    const marker = svg('marker', { id, viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' });
    marker.appendChild(svg('path', { d: 'M0,0 L10,5 L0,10 Z', fill: line.color }));
    defs.appendChild(marker);
    layer.appendChild(defs);
    for (const [attribute, type] of ends) if (type && ARROWS.has(type)) stroke.setAttribute(attribute, `url(#${id})`);
  }
  layer.appendChild(stroke);
  return layer;
}

function rectangle(w: number, h: number): string {
  return `M0,0 H${w} V${h} H0 Z`;
}

function runCss(span: HTMLElement, style: RunStyle, scale: number): void {
  const size = style.sizePt * scale * PX_PER_PT;
  span.style.fontFamily = style.fontFamily;
  span.style.fontSize = px(style.baseline ? size * 0.67 : size);
  span.style.fontWeight = style.bold ? '700' : '400';
  span.style.fontStyle = style.italic ? 'italic' : 'normal';
  span.style.color = style.color;
  const decorations = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean);
  if (decorations.length) span.style.textDecoration = decorations.join(' ');
  if (style.baseline) span.style.verticalAlign = style.baseline > 0 ? 'super' : 'sub';
  if (style.caps) span.style.textTransform = 'uppercase';
  if (style.highlight) span.style.backgroundColor = style.highlight;
}

/** One paragraph; `data-paragraph` and `data-run` point back at the XML it came from. */
function renderParagraph(paragraph: ParagraphView, index: number, text: TextView): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = SlideElement.Paragraph;
  element.dataset.paragraph = String(index);
  const first = paragraph.runs.find(run => !run.lineBreak)?.style ?? paragraph.endStyle;
  element.style.textAlign = paragraph.align;
  element.style.paddingLeft = px(paragraph.marginLeft);
  element.style.textIndent = px(paragraph.indent);
  // PowerPoint leaves out the space before the first paragraph of a text box.
  element.style.marginTop = px(index ? paragraph.spaceBefore : 0);
  element.style.marginBottom = px(paragraph.spaceAfter);
  element.style.lineHeight = 'factor' in paragraph.lineHeight
    ? String(Math.max(0.5, paragraph.lineHeight.factor * (1 - text.lineReduction)))
    : px(paragraph.lineHeight.px);
  element.style.fontSize = px(first.sizePt * text.fontScale * PX_PER_PT);
  element.style.fontFamily = first.fontFamily;
  element.style.color = first.color;
  if (paragraph.bullet) {
    element.dataset.bullet = paragraph.bullet.text;
    // A hanging indent holds the bullet; without one a small gap follows it.
    element.style.setProperty('--lobster-bullet-width', px(Math.max(0, -paragraph.indent)));
    element.style.setProperty('--lobster-bullet-gap', paragraph.indent < 0 ? '0px' : '0.4em');
    element.style.setProperty('--lobster-bullet-size', `${paragraph.bullet.sizeFactor}em`);
    if (paragraph.bullet.color) element.style.setProperty('--lobster-bullet-color', paragraph.bullet.color);
    if (paragraph.bullet.fontFamily) element.style.setProperty('--lobster-bullet-font', paragraph.bullet.fontFamily);
  }
  let visible = false;
  for (const run of paragraph.runs) {
    if (run.lineBreak) {
      element.appendChild(document.createElement('br'));
      continue;
    }
    if (!run.text) continue;
    const span = document.createElement('span');
    if (run.run !== undefined) span.dataset.run = String(run.run);
    runCss(span, run.style, text.fontScale);
    span.textContent = run.text;
    element.appendChild(span);
    visible = true;
  }
  // An empty paragraph still takes a line, as in PowerPoint.
  if (!visible) element.appendChild(document.createElement('br'));
  return element;
}

/** Fill `container` with a text body's paragraphs. */
export function renderParagraphs(container: HTMLElement, text: TextView): void {
  container.replaceChildren(...text.paragraphs.map((paragraph, index) => renderParagraph(paragraph, index, text)));
}

function textContainer(text: TextView, box: { w: number; h: number } | undefined): HTMLDivElement {
  const container = document.createElement('div');
  container.className = SlideElement.Text;
  container.style.padding = `${px(text.insets.t)} ${px(text.insets.r)} ${px(text.insets.b)} ${px(text.insets.l)}`;
  container.style.justifyContent = text.anchor === 'middle' ? 'center' : text.anchor === 'bottom' ? 'flex-end' : 'flex-start';
  container.style.whiteSpace = text.wrap ? 'pre-wrap' : 'pre';
  if (text.vertical) container.style.writingMode = 'vertical-rl';
  if (box) {
    container.style.width = px(box.w);
    container.style.height = px(box.h);
  }
  renderParagraphs(container, text);
  return container;
}

function promptText(shape: ShapeView, labels: SlideRenderLabels): string | undefined {
  if (shape.prompt?.custom) return shape.prompt.custom;
  switch (shape.placeholder?.type) {
    case 'title': case 'ctrTitle': return labels.titlePrompt;
    case 'subTitle': return labels.subtitlePrompt;
    case 'body': case 'obj': return labels.textPrompt;
    default: return undefined;
  }
}

/** An empty placeholder as the editing view shows it: its prompt in the placeholder's style. */
function promptContainer(shape: ShapeView, text: string, box: Box): HTMLDivElement {
  const style = shape.text?.paragraphs[0];
  const container = document.createElement('div');
  container.className = `${SlideElement.Text} lobster-slide-prompt`;
  const insets = shape.text?.insets ?? { l: 9.6, t: 4.8, r: 9.6, b: 4.8 };
  container.style.padding = `${px(insets.t)} ${px(insets.r)} ${px(insets.b)} ${px(insets.l)}`;
  container.style.width = px(box.w);
  container.style.height = px(box.h);
  const anchor = shape.text?.anchor ?? 'top';
  container.style.justifyContent = anchor === 'middle' ? 'center' : anchor === 'bottom' ? 'flex-end' : 'flex-start';
  const paragraph = document.createElement('p');
  paragraph.className = SlideElement.Paragraph;
  paragraph.textContent = text;
  if (style) {
    paragraph.style.textAlign = style.align;
    paragraph.style.fontFamily = style.endStyle.fontFamily;
    paragraph.style.fontSize = px(style.endStyle.sizePt * PX_PER_PT);
    paragraph.style.fontWeight = style.endStyle.bold ? '700' : '400';
  }
  container.appendChild(paragraph);
  return container;
}

/** A shape's fill and outline, flipped as the shape is. */
function geometryLayer(shape: ShapeView, image: SlideRenderOptions['image']): HTMLDivElement | undefined {
  const { w, h } = shape.box;
  const line = isLineGeometry(shape.geometry);
  const path = geometryPath(shape.geometry, w, h);
  const fill = line ? undefined : fillCss(shape.fill, image);
  if (!fill && !shape.line) return undefined;
  const layer = document.createElement('div');
  layer.className = 'lobster-slide-geometry';
  if (shape.box.flipH || shape.box.flipV) layer.style.transform = `scale(${shape.box.flipH ? -1 : 1}, ${shape.box.flipV ? -1 : 1})`;
  if (fill) {
    const area = document.createElement('div');
    area.className = 'lobster-slide-fill';
    area.style.background = fill;
    if (path) area.style.clipPath = `path(evenodd, "${path}")`;
    layer.appendChild(area);
  }
  if (shape.line) layer.appendChild(strokeLayer(shape.line, path ?? rectangle(w, h), w, h));
  return layer;
}

function graphicPlaceholder(label: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'lobster-slide-graphic';
  element.textContent = label;
  return element;
}

function pictureLayer(shape: ShapeView, options: SlideRenderOptions): HTMLElement {
  const url = shape.image ? options.image(shape.image.part) : undefined;
  if (!url) return graphicPlaceholder(options.labels.picture);
  const { w, h } = shape.box;
  const frame = document.createElement('div');
  frame.className = 'lobster-slide-picture';
  const path = geometryPath(shape.geometry, w, h);
  if (path) frame.style.clipPath = `path("${path}")`;
  const picture = document.createElement('img');
  picture.alt = shape.name;
  picture.draggable = false;
  picture.src = url;
  // a:srcRect crops (or, negative, pads) each side by a fraction of the picture.
  const crop = shape.image?.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const width = w / Math.max(0.01, 1 - crop.l - crop.r);
  const height = h / Math.max(0.01, 1 - crop.t - crop.b);
  picture.style.width = px(width);
  picture.style.height = px(height);
  picture.style.left = px(-crop.l * width);
  picture.style.top = px(-crop.t * height);
  if (shape.box.flipH || shape.box.flipV) picture.style.transform = `scale(${shape.box.flipH ? -1 : 1}, ${shape.box.flipV ? -1 : 1})`;
  frame.appendChild(picture);
  return frame;
}

const borderCss = (line: Line | undefined): string => (line ? `${px(line.width)} ${line.dash ? 'dashed' : 'solid'} ${line.color}` : 'none');

function tableElement(table: TableView, image: SlideRenderOptions['image']): HTMLTableElement {
  const element = document.createElement('table');
  element.className = 'lobster-slide-table';
  element.style.width = px(table.columns.reduce((sum, width) => sum + width, 0));
  const columns = document.createElement('colgroup');
  for (const width of table.columns) {
    const column = document.createElement('col');
    column.style.width = px(width);
    columns.appendChild(column);
  }
  element.appendChild(columns);
  const body = document.createElement('tbody');
  table.rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    tr.style.height = px(row.height);
    row.cells.forEach((cell, columnIndex) => {
      // A merged-over cell is covered by the cell that spans it.
      if (cell.merged) return;
      const td = document.createElement('td');
      td.className = SlideElement.Cell;
      td.dataset.cell = `${rowIndex},${columnIndex}`;
      if (cell.colSpan > 1) td.colSpan = cell.colSpan;
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      td.style.background = fillCss(cell.fill, image) ?? 'transparent';
      td.style.borderLeft = borderCss(cell.borders.l);
      td.style.borderTop = borderCss(cell.borders.t);
      td.style.borderRight = borderCss(cell.borders.r);
      td.style.borderBottom = borderCss(cell.borders.b);
      td.style.verticalAlign = cell.text.anchor === 'middle' ? 'middle' : cell.text.anchor === 'bottom' ? 'bottom' : 'top';
      td.style.padding = `${px(cell.text.insets.t)} ${px(cell.text.insets.r)} ${px(cell.text.insets.b)} ${px(cell.text.insets.l)}`;
      const flow = document.createElement('div');
      flow.className = `${SlideElement.Text} lobster-slide-cell-text`;
      renderParagraphs(flow, cell.text);
      td.appendChild(flow);
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  element.appendChild(body);
  return element;
}

function renderShape(shape: ShapeView, options: SlideRenderOptions): HTMLElement {
  const element = document.createElement('div');
  element.className = SlideElement.Shape;
  element.dataset.shapeId = shape.id;
  element.dataset.kind = shape.kind;
  if (shape.own) element.dataset.own = '1';
  const { box } = shape;
  if (shape.kind === ShapeViewKind.Group) {
    // Members are laid out in slide coordinates already (the group's scale, flip and rotation applied).
    element.classList.add('lobster-slide-group');
    for (const child of shape.children ?? []) element.appendChild(renderShape(child, options));
    return element;
  }
  element.style.left = px(box.x);
  element.style.top = px(box.y);
  element.style.width = px(box.w);
  element.style.height = px(box.h);
  if (box.rot) element.style.transform = `rotate(${box.rot}deg)`;
  switch (shape.kind) {
    case ShapeViewKind.Picture:
      element.appendChild(pictureLayer(shape, options));
      if (shape.line) element.appendChild(strokeLayer(shape.line, geometryPath(shape.geometry, box.w, box.h) ?? rectangle(box.w, box.h), box.w, box.h));
      break;
    case ShapeViewKind.Table:
      if (shape.table) element.appendChild(tableElement(shape.table, options.image));
      break;
    case ShapeViewKind.Graphic:
      element.appendChild(graphicPlaceholder(shape.label === 'chart' ? options.labels.chart : shape.label === 'diagram' ? options.labels.diagram : options.labels.object));
      break;
    default: {
      const geometry = geometryLayer(shape, options.image);
      if (geometry) element.appendChild(geometry);
      if (shape.text) element.appendChild(textContainer(shape.text, box));
      // The prompt lies over the empty text; typing hides it.
      const prompt = options.editing && shape.prompt ? promptText(shape, options.labels) : undefined;
      if (prompt) element.appendChild(promptContainer(shape, prompt, box));
      if (options.editing && shape.prompt) element.classList.add('lobster-slide-empty-placeholder');
      break;
    }
  }
  return element;
}

/** The slide at 96 dpi; scale it with a CSS transform. */
export function renderSlide(view: SlideView, options: SlideRenderOptions): HTMLDivElement {
  const slide = document.createElement('div');
  slide.className = SlideElement.Slide;
  slide.style.width = px(view.width);
  slide.style.height = px(view.height);
  slide.style.background = fillCss(view.background, options.image) ?? '#FFFFFF';
  for (const shape of view.shapes) slide.appendChild(renderShape(shape, options));
  return slide;
}

/** The drawn top-level shape an element belongs to, when it is one of the slide's own. */
export function ownShapeElement(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const shape = target.closest<HTMLElement>(`.${SlideElement.Slide} > .${SlideElement.Shape}`);
  return shape?.dataset.own ? shape : undefined;
}

/** The innermost drawn shape under an element, e.g. a member of a group. */
export function innerShapeElement(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const shape = target.closest<HTMLElement>(`.${SlideElement.Shape}:not(.lobster-slide-group)`);
  return shape?.dataset.own ? shape : undefined;
}
