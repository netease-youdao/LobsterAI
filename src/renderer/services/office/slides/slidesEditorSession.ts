import type { OfficeOpenResult } from '../../../../shared/office/core/officeFile';
import type { SlidesPackageInfo } from '../../../../shared/office/slides/slidesFile';
import { i18nService } from '../../i18n';
import { themeColorGrid } from '../core/officeColors';
import { createOfficeEditorRegistry } from '../core/officeEditorRegistry';
import { OfficeEditorSession, type OfficeSessionContext } from '../core/officeEditorSession';
import { prepareOfficeFonts } from '../core/officeFonts';
import { applySlidesEdits, readSlides, type SlidesEditResult } from './slidesAgentOperations';
import {
  addSlide, deleteSlide, duplicateSlide, layoutAfter, layoutOf, masterOf, moveSlide, notesText, setNotes, type SlideRef, slideRefs, SlidesEditError,
  slideSize, SlidesRefusal, themeOf,
} from './slidesDeck';
import { type HistoryEntry, SlidesHistory } from './slidesHistory';
import { type Box, buildSlideView, fontsOf, type ShapeView, ShapeViewKind, type SlideView, type TextView } from './slidesModel';
import { type PackageChange, SlidesPackage } from './slidesPackage';
import { innerShapeElement, ownShapeElement, renderParagraphs, renderSlide, SlideElement, type SlideRenderLabels } from './slidesRender';
import {
  addTextBox, cellBody, deleteShape, ensureTextBody, findShape, setShapeBounds, shapeNameOf, shapeText, slideTree, textBodies,
} from './slidesShapes';
import {
  applyEditedParagraphs, formatRange, paragraphLevel, paragraphsOf, paragraphText, setAlignment, setLevel, type SlidesAlign, type TextStyleChange,
} from './slidesText';
import { placeCaret, readEditedParagraphs, selectAllIn, selectionIn, setSelectionIn, type TextPosition, wordAt } from './slidesTextEditing';
import { readTheme } from './slidesTheme';
import { SlidesThumbnailList } from './slidesThumbnails';
import { browserXmlCodec, EMU_PER_PX, pxFromEmu } from './slidesXml';

const AUTOSAVE_DELAY_MS = 700;
/** Typing reaches the file this long after the last key, as one undo step per edit. */
const TEXT_SYNC_DELAY_MS = 300;
const NOTES_SYNC_DELAY_MS = 400;
const HISTORY_LIMIT = 100;
/** Room around the slide on the stage, in screen pixels. */
const STAGE_PADDING = 24;
const DRAG_THRESHOLD_PX = 3;
const MIN_SHAPE_PX = 4;
/** Arrow keys move a shape this far at 100%; with Alt, Ctrl or Cmd one pixel. */
const NUDGE_PX = 8;
const ZOOM_LIMITS = { min: 0.25, max: 4 } as const;
/** Fitting goes below the smallest zoom step, so a narrow stage still shows the whole slide. */
const MIN_FIT_ZOOM = 0.1;
const PX_PER_PT = 96 / 72;
/** The theme colors in the order of Office's color menus. */
const THEME_PALETTE = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
};

export const SlidesZoomMode = { Fit: 'fit', Fixed: 'fixed' } as const;
export type SlidesZoomMode = typeof SlidesZoomMode[keyof typeof SlidesZoomMode];

/** What "Add to chat" sends: the text, and the slide and shape it comes from. */
export interface SlidesChatReference {
  text: string;
  slide: number;
  shapeId: string;
  shapeName: string;
}

/** The formatting the toolbar shows for the selection. */
export interface SlidesFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  font?: string;
  size?: number;
  align?: string;
}

/** Resize handles: which edges each moves (-1 left/top, 1 right/bottom). */
const HANDLES = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
} as const;
type Handle = keyof typeof HANDLES;

interface ViewState {
  slideId?: number;
  shapeId?: string;
}

interface TextEditing {
  slideId: number;
  part: string;
  shapeId: string;
  cell?: { row: number; column: number };
  container: HTMLElement;
  shapeElement: HTMLElement;
  key: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Typed text not written to the part yet. */
  pending: boolean;
  composing: boolean;
  /** The history entry that inserted this text box; an empty box is taken out again when editing ends. */
  created?: HistoryEntry<ViewState>;
}

interface EditOptions<T> {
  /** Merge with the previous step when it has the same key. */
  key?: string;
  /** What to redraw afterwards: the current slide, everything (slides were added or moved) or nothing. */
  redraw?: 'slide' | 'all' | 'none';
  /** The slide and shape to show afterwards. */
  select?: (result: T) => ViewState;
}

const t = (key: string): string => i18nService.t(key);
const clampZoom = (value: number): number => Math.max(ZOOM_LIMITS.min, Math.min(ZOOM_LIMITS.max, Math.round(value * 100) / 100));

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  return created;
}

/** A box resized by dragging a handle, in the shape's own rotated frame; the opposite side stays put. */
function resizedBox(box: Box, handle: Handle, dx: number, dy: number, keepAspect: boolean): Box {
  const [hx, hy] = HANDLES[handle];
  const angle = (box.rot * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  let w = Math.max(MIN_SHAPE_PX, box.w + hx * localX);
  let h = Math.max(MIN_SHAPE_PX, box.h + hy * localY);
  if (keepAspect && hx && hy && box.h > 0) {
    const ratio = box.w / box.h;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
  }
  const shiftX = (hx * (w - box.w)) / 2;
  const shiftY = (hy * (h - box.h)) / 2;
  const centerX = box.x + box.w / 2 + shiftX * cos - shiftY * sin;
  const centerY = box.y + box.h / 2 + shiftX * sin + shiftY * cos;
  return { ...box, x: centerX - w / 2, y: centerY - h / 2, w, h };
}

function findView(shapes: ShapeView[] | undefined, id: string): ShapeView | undefined {
  for (const shape of shapes ?? []) {
    if (!shape.own) continue;
    if (shape.id === id) return shape;
    const inner = findView(shape.children, id);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * One open presentation: the slide list, the stage with the current slide, the speaker notes,
 * and the edits a user makes on them (select, move, resize, delete, type in place, format) as
 * undoable changes to the original package. The agent's edits go through the same package.
 */
export class SlidesEditorSession extends OfficeEditorSession<SlidesPackageInfo> {
  pkg?: SlidesPackage;
  zoom = 1;
  zoomMode: SlidesZoomMode = SlidesZoomMode.Fit;
  /** When the last edit was refused, and why; the view shows a notice. */
  lastRefusal = 0;
  lastRefusalCode: SlidesRefusal = SlidesRefusal.Invalid;
  private readOnly = false;
  private currentSlideId?: number;
  private selectedShapeId?: string;
  private view?: SlideView;
  private readonly history = new SlidesHistory<ViewState>(HISTORY_LIMIT);
  private editing?: TextEditing;
  private editCount = 0;
  private notesSession = 0;
  private notesSlideId?: number;
  private notesPending = false;
  private notesTimer?: ReturnType<typeof setTimeout>;
  private images = new Map<string, { bytes: Uint8Array; url?: string }>();
  private chatHandler?: (reference: SlidesChatReference) => void;
  private listeners = new Set<() => void>();
  private version = 0;
  private selectionFrame = 0;
  private readonly slideList = new SlidesThumbnailList({
    draw: (ref, frame) => this.drawThumbnail(ref, frame),
    select: index => this.selectSlide(index),
    move: (from, to) => this.moveSlide(from, to),
    remove: () => this.deleteSlide(),
    editable: () => this.editable,
    toggle: () => this.toggleSlideList(),
  });
  private readonly stage = element('div', 'lobster-slides-stage');
  private readonly canvas = element('div', 'lobster-slides-canvas');
  private readonly frame = element('div', 'lobster-slides-selection');
  private readonly chatButton = element('button', 'lobster-slides-chat-action');
  private readonly notes = element('textarea', 'lobster-slides-notes');
  private readonly empty = element('div', 'lobster-slides-empty');
  private slideElement?: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly stopLocale: () => void;

  constructor(file: OfficeOpenResult<SlidesPackageInfo>, context: OfficeSessionContext<SlidesPackageInfo>) {
    super(file, context, { hostClassName: 'lobster-slides-workspace', autosaveDelayMs: AUTOSAVE_DELAY_MS, logTag: '[SlidesDocument]' });
    this.stage.tabIndex = 0;
    for (const handle of Object.keys(HANDLES) as Handle[]) {
      const knob = element('span', `lobster-slides-handle lobster-slides-handle-${handle}`);
      knob.dataset.handle = handle;
      this.frame.appendChild(knob);
    }
    this.chatButton.type = 'button';
    // The same action as the chat's button for selected text: selection handlers leave it alone.
    this.chatButton.setAttribute('data-cowork-selected-text-action', '');
    this.chatButton.hidden = true;
    this.frame.hidden = true;
    this.empty.hidden = true;
    this.canvas.append(this.frame, this.chatButton);
    this.stage.append(this.canvas, this.empty);
    this.notes.spellcheck = false;
    const main = element('div', 'lobster-slides-main');
    main.append(this.stage, this.notes);
    this.host.append(this.slideList.pane, main);

    this.resizeObserver = new ResizeObserver(entries => {
      // The editor's width sizes the thumbnails; the stage's size, a fitted zoom.
      if (entries.some(entry => entry.target === this.host)) this.fitSlideList();
      if (this.zoomMode === SlidesZoomMode.Fit) this.applyZoom();
    });
    this.resizeObserver.observe(this.host);
    this.resizeObserver.observe(this.stage);
    this.stage.addEventListener('pointerdown', this.onStagePointerDown);
    this.stage.addEventListener('dblclick', this.onStageDoubleClick);
    this.frame.addEventListener('pointerdown', this.onHandlePointerDown);
    this.chatButton.addEventListener('mousedown', event => event.preventDefault());
    this.chatButton.addEventListener('click', this.onChatClick);
    this.host.addEventListener('keydown', this.onKeyDown);
    this.notes.addEventListener('focus', this.onNotesFocus);
    this.notes.addEventListener('input', this.onNotesInput);
    this.notes.addEventListener('blur', () => this.syncNotes());
    document.addEventListener('selectionchange', this.onSelectionChange);
    this.applyLabels();
    this.stopLocale = i18nService.subscribe(() => {
      this.applyLabels();
      if (this.pkg && !this.editing) this.renderAll();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getVersion = (): number => this.version;
  private bump = (): void => {
    this.version++;
    this.listeners.forEach(listener => listener());
  };

  private applyLabels(): void {
    this.slideList.setLabels({
      list: t('slidesList'), title: t('slidesPaneTitle'), show: t('slidesShowThumbnails'), hide: t('slidesHideThumbnails'),
    });
    this.stage.setAttribute('aria-label', t('slidesStage'));
    this.notes.placeholder = t('slidesNotesPlaceholder');
    this.notes.setAttribute('aria-label', t('slidesNotes'));
    this.chatButton.textContent = t('coworkSelectedTextAddToChat');
    this.empty.textContent = t('slidesEmpty');
  }

  private labels(): SlideRenderLabels {
    return {
      titlePrompt: t('slidesPromptTitle'), subtitlePrompt: t('slidesPromptSubtitle'), textPrompt: t('slidesPromptText'),
      chart: t('slidesChart'), diagram: t('slidesDiagram'), object: t('slidesObject'), picture: t('slidesPicture'),
    };
  }

  // ---- The file -------------------------------------------------------------------------------

  async load(bytes: Uint8Array): Promise<void> {
    const pkg = SlidesPackage.open(bytes, browserXmlCodec);
    const refs = slideRefs(pkg);
    // A slide without a layout and master cannot be drawn or edited; the file is damaged.
    for (const ref of refs) {
      const layout = layoutOf(pkg, ref.part);
      if (!layout || !masterOf(pkg, layout)) throw new Error(`Slide ${ref.part} has no layout or master`);
    }
    this.dropTextEditing();
    this.revokeImages();
    this.pkg = pkg;
    this.history.clear();
    this.notesPending = false;
    if (!refs.some(ref => ref.id === this.currentSlideId)) this.currentSlideId = refs[0]?.id;
    this.selectedShapeId = undefined;
    const current = this.currentRef();
    if (current) await prepareOfficeFonts(fontsOf(buildSlideView(pkg, current.part)));
    this.renderAll();
  }

  async save(): Promise<Uint8Array> {
    this.syncTextEditing();
    this.syncNotes();
    if (!this.pkg) throw new Error('Presentation editor is not ready');
    return this.pkg.toBytes();
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    if (readOnly) this.endTextEditing();
    this.notes.readOnly = readOnly;
    if (this.pkg) this.renderAll();
  }

  get editable(): boolean {
    return !this.readOnly && Boolean(this.pkg);
  }

  protected override shown(): () => void {
    this.fitSlideList();
    const frame = requestAnimationFrame(() => this.applyZoom());
    return () => {
      cancelAnimationFrame(frame);
      this.endTextEditing();
      this.syncNotes();
    };
  }

  protected disposeEditor(): void {
    this.dropTextEditing();
    clearTimeout(this.notesTimer);
    this.slideList.dispose();
    this.resizeObserver.disconnect();
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.stopLocale();
    this.revokeImages();
  }

  private imageUrl = (part: string): string | undefined => {
    const bytes = this.pkg?.bytes(part);
    if (!bytes) return undefined;
    const cached = this.images.get(part);
    if (cached?.bytes === bytes) return cached.url;
    if (cached?.url) URL.revokeObjectURL(cached.url);
    const type = IMAGE_TYPES[part.slice(part.lastIndexOf('.') + 1).toLowerCase()];
    const url = type ? URL.createObjectURL(new Blob([bytes as BlobPart], { type })) : undefined;
    this.images.set(part, { bytes, url });
    return url;
  };

  private revokeImages(): void {
    for (const { url } of this.images.values()) if (url) URL.revokeObjectURL(url);
    this.images.clear();
  }

  // ---- What is shown --------------------------------------------------------------------------

  get slideCount(): number {
    return this.pkg ? slideRefs(this.pkg).length : 0;
  }

  get currentIndex(): number {
    return this.currentRef()?.index ?? -1;
  }

  get editingText(): boolean {
    return Boolean(this.editing);
  }

  get canUndo(): boolean {
    return this.history.canUndo || Boolean(this.editing?.pending);
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  private currentRef(): SlideRef | undefined {
    return this.pkg ? slideRefs(this.pkg).find(ref => ref.id === this.currentSlideId) : undefined;
  }

  private viewState(): ViewState {
    return { slideId: this.currentSlideId, shapeId: this.selectedShapeId };
  }

  /** The selected top-level shape as drawn. */
  selectedShape(): ShapeView | undefined {
    return this.selectedShapeId ? this.view?.shapes.find(shape => shape.own && shape.id === this.selectedShapeId) : undefined;
  }

  /** The theme's colors for the color palette, with their lighter and darker variants. */
  themeColors(): string[][] {
    const pkg = this.pkg;
    const ref = this.currentRef();
    const layout = pkg && ref ? layoutOf(pkg, ref.part) : undefined;
    const master = pkg && layout ? masterOf(pkg, layout) : undefined;
    const themePart = pkg && master ? themeOf(pkg, master) : undefined;
    if (!pkg || !themePart || !pkg.has(themePart)) return [];
    const { colors } = readTheme(pkg.xml(themePart));
    return themeColorGrid(THEME_PALETTE.map(name => colors[name]).filter((hex): hex is string => Boolean(hex)));
  }

  private renderAll(): void {
    this.renderThumbnails();
    this.renderStage();
    this.bump();
  }

  private renderStage(): void {
    if (this.editing) {
      this.syncTextEditing();
      this.dropTextEditing(true);
    }
    this.slideElement?.remove();
    this.slideElement = undefined;
    this.view = undefined;
    const pkg = this.pkg;
    const ref = this.currentRef();
    this.empty.hidden = Boolean(ref) || !pkg;
    if (!pkg || !ref) {
      this.canvas.style.width = '0px';
      this.canvas.style.height = '0px';
      this.updateSelectionFrame();
      this.syncNotesField();
      return;
    }
    try {
      this.view = buildSlideView(pkg, ref.part);
    } catch (error) {
      console.warn('[SlidesEditor] Could not draw a slide:', error);
      this.updateSelectionFrame();
      return;
    }
    if (this.selectedShapeId && !this.selectedShape()) this.selectedShapeId = undefined;
    const slide = renderSlide(this.view, { image: this.imageUrl, editing: !this.readOnly, labels: this.labels() });
    slide.style.transformOrigin = '0 0';
    this.slideElement = slide;
    this.canvas.insertBefore(slide, this.canvas.firstChild);
    this.applyZoom();
    void prepareOfficeFonts(fontsOf(this.view));
    this.syncNotesField();
  }

  private renderThumbnails(): void {
    const pkg = this.pkg;
    const size = pkg ? slideSize(pkg) : undefined;
    this.slideList.render(pkg ? slideRefs(pkg) : [], this.currentSlideId,
      size ? { width: pxFromEmu(size.cx), height: pxFromEmu(size.cy) } : { width: 16, height: 9 });
  }

  private drawThumbnail(ref: SlideRef, frame: HTMLElement): void {
    if (!this.pkg) return;
    try {
      const view = buildSlideView(this.pkg, ref.part);
      frame.replaceChildren(renderSlide(view, { image: this.imageUrl, editing: false, labels: this.labels() }));
    } catch (error) {
      console.debug('[SlidesEditor] Could not draw a thumbnail:', error);
    }
  }

  private redrawThumbnail(slideId: number | undefined): void {
    this.slideList.redraw(slideId);
  }

  /** Shows or hides the thumbnails for this presentation; every presentation opens with them shown. */
  private toggleSlideList(): void {
    const shown = !this.slideList.shown;
    // Focus in a list that goes away moves to the slide, so the arrow keys keep turning slides.
    const focused = !shown && this.slideList.element.contains(document.activeElement);
    this.slideList.setShown(shown);
    if (focused) this.stage.focus({ preventScroll: true });
  }

  /** Thumbnails sized to the editor's width, so a narrow panel keeps most of it for the slide. */
  private fitSlideList(): void {
    const width = this.host.clientWidth;
    if (width > 0) this.slideList.fit(width);
  }

  private fitZoom(): number | undefined {
    const view = this.view;
    const width = this.stage.clientWidth - STAGE_PADDING * 2;
    const height = this.stage.clientHeight - STAGE_PADDING * 2;
    if (!view || width <= 0 || height <= 0) return undefined;
    // Rounded down: a fit rounded up overflows the stage by a few pixels and shows scroll bars.
    return Math.max(MIN_FIT_ZOOM, Math.min(ZOOM_LIMITS.max, Math.floor(Math.min(width / view.width, height / view.height) * 100) / 100));
  }

  private applyZoom(): void {
    if (this.zoomMode === SlidesZoomMode.Fit) {
      const fit = this.fitZoom();
      if (fit !== undefined && fit !== this.zoom) {
        this.zoom = fit;
        this.bump();
      }
    }
    const view = this.view;
    if (view && this.slideElement) {
      this.canvas.style.width = `${view.width * this.zoom}px`;
      this.canvas.style.height = `${view.height * this.zoom}px`;
      this.slideElement.style.transform = `scale(${this.zoom})`;
    }
    this.updateSelectionFrame();
  }

  setZoom(value: number): void {
    this.zoomMode = SlidesZoomMode.Fixed;
    this.zoom = clampZoom(value);
    this.applyZoom();
    this.bump();
  }

  fitToWindow(): void {
    this.zoomMode = SlidesZoomMode.Fit;
    this.applyZoom();
    this.bump();
  }

  /** The frame and handles around the selected (or edited) shape, and "Add to chat" beside it. */
  private updateSelectionFrame(): void {
    const shape = this.editing ? findView(this.view?.shapes, this.editing.shapeId) : this.selectedShape();
    if (!shape || !this.slideElement) {
      this.frame.hidden = true;
      this.chatButton.hidden = true;
      return;
    }
    const box = this.boxOf(shape);
    const zoom = this.zoom;
    Object.assign(this.frame.style, {
      left: `${box.x * zoom}px`, top: `${box.y * zoom}px`, width: `${box.w * zoom}px`, height: `${box.h * zoom}px`,
      transform: box.rot ? `rotate(${box.rot}deg)` : '',
    });
    this.frame.hidden = false;
    this.frame.classList.toggle('lobster-slides-selection-editing', Boolean(this.editing));
    this.frame.classList.toggle('lobster-slides-selection-locked', this.readOnly);
    const chat = Boolean(this.chatHandler) && !this.editing;
    this.chatButton.hidden = !chat;
    if (chat) {
      const above = box.y * zoom > 36;
      this.chatButton.style.left = `${Math.max(0, (box.x + box.w) * zoom)}px`;
      this.chatButton.style.top = above ? `${box.y * zoom - 34}px` : `${(box.y + box.h) * zoom + 6}px`;
    }
  }

  /** A shape's box; a group's is the box of its members. */
  private boxOf(shape: ShapeView): Box {
    if (shape.kind !== ShapeViewKind.Group || !shape.children?.length || (shape.box.w && shape.box.h)) return shape.box;
    const boxes = shape.children.map(child => this.boxOf(child));
    const x = Math.min(...boxes.map(box => box.x));
    const y = Math.min(...boxes.map(box => box.y));
    return { x, y, w: Math.max(...boxes.map(box => box.x + box.w)) - x, h: Math.max(...boxes.map(box => box.y + box.h)) - y, rot: 0, flipH: false, flipV: false };
  }

  /** The drawn element of one of the slide's own shapes (group members included); ids are unique on a slide. */
  private shapeElement(id: string): HTMLElement | undefined {
    return this.slideElement?.querySelector<HTMLElement>(`[data-own][data-shape-id="${CSS.escape(id)}"]`) ?? undefined;
  }

  // ---- Selection ------------------------------------------------------------------------------

  selectSlide(index: number): void {
    const ref = this.pkg ? slideRefs(this.pkg)[index] : undefined;
    if (!ref || ref.id === this.currentSlideId) return;
    this.endTextEditing();
    this.syncNotes();
    this.currentSlideId = ref.id;
    this.selectedShapeId = undefined;
    this.renderStage();
    this.slideList.markCurrent(ref.id);
    this.bump();
  }

  private select(shapeId: string | undefined): void {
    if (this.selectedShapeId === shapeId) return;
    this.selectedShapeId = shapeId;
    this.updateSelectionFrame();
    this.bump();
  }

  private onStagePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.view) return;
    const target = event.target as Element;
    if (target.closest('.lobster-slides-handle, .lobster-slides-chat-action')) return;
    if (this.editing?.container.contains(target)) return;
    const wasEditing = Boolean(this.editing);
    this.endTextEditing();
    const shapeElement = ownShapeElement(target);
    if (!shapeElement) {
      this.select(undefined);
      this.stage.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    const id = shapeElement.dataset.shapeId!;
    const again = !wasEditing && this.selectedShapeId === id;
    this.select(id);
    this.stage.focus({ preventScroll: true });
    this.drag(event, id, undefined, () => {
      // A second click on a selected shape types into it where it was clicked, as in PowerPoint.
      if (again) this.editAtPoint(target, { x: event.clientX, y: event.clientY });
    });
  };

  private onStageDoubleClick = (event: MouseEvent): void => {
    if (this.editing || !ownShapeElement(event.target)) return;
    this.editAtPoint(event.target as Element, { x: event.clientX, y: event.clientY });
  };

  /** Start typing into the text under a point: a shape's text or a table cell. */
  private editAtPoint(target: Element, point: { x: number; y: number }): void {
    const inner = innerShapeElement(target);
    if (!inner) return;
    const cell = target.closest<HTMLElement>(`.${SlideElement.Cell}`)?.dataset.cell?.split(',').map(Number);
    this.beginTextEditing(inner.dataset.shapeId!, { point, ...(cell ? { cell: { row: cell[0], column: cell[1] } } : {}) });
  }

  private onHandlePointerDown = (event: PointerEvent): void => {
    const handle = (event.target as HTMLElement).dataset.handle as Handle | undefined;
    if (event.button !== 0 || !handle || !this.selectedShapeId || this.readOnly || this.editing) return;
    event.preventDefault();
    event.stopPropagation();
    this.drag(event, this.selectedShapeId, handle);
  };

  /** Move (no handle) or resize a shape with the pointer; `onClick` runs when it did not move. */
  private drag(event: PointerEvent, shapeId: string, handle: Handle | undefined, onClick?: () => void): void {
    const shape = this.selectedShape();
    const element = this.shapeElement(shapeId)?.closest<HTMLElement>(`.${SlideElement.Slide} > .${SlideElement.Shape}`);
    if (!shape || !element) return;
    const start = { x: event.clientX, y: event.clientY };
    const origin = this.boxOf(shape);
    const transform = element.style.transform;
    const keepAspect = shape.kind === ShapeViewKind.Picture || shape.kind === ShapeViewKind.Group;
    let box: Box | undefined;
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - start.x) / this.zoom;
      const dy = (next.clientY - start.y) / this.zoom;
      if (!box && Math.hypot(next.clientX - start.x, next.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      if (this.readOnly) return;
      box = handle ? resizedBox(origin, handle, dx, dy, keepAspect !== next.shiftKey) : { ...origin, x: origin.x + dx, y: origin.y + dy };
      if (!handle) element.style.transform = `translate(${dx}px, ${dy}px) ${transform}`;
      const zoom = this.zoom;
      Object.assign(this.frame.style, { left: `${box.x * zoom}px`, top: `${box.y * zoom}px`, width: `${box.w * zoom}px`, height: `${box.h * zoom}px` });
      this.chatButton.hidden = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!box) {
        onClick?.();
        return;
      }
      element.style.transform = transform;
      this.setBounds(shapeId, origin, box);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Write a moved or resized box (CSS pixels) into the slide; only the fields that changed. */
  private setBounds(shapeId: string, from: Box, to: Box, key?: string): void {
    const ref = this.currentRef();
    const pkg = this.pkg;
    if (!ref || !pkg) return;
    const changed = (a: number, b: number) => Math.abs(a - b) > 0.01;
    const bounds = {
      ...(changed(from.x, to.x) ? { x: to.x * EMU_PER_PX } : {}), ...(changed(from.y, to.y) ? { y: to.y * EMU_PER_PX } : {}),
      ...(changed(from.w, to.w) ? { w: to.w * EMU_PER_PX } : {}), ...(changed(from.h, to.h) ? { h: to.h * EMU_PER_PX } : {}),
    };
    if (!Object.keys(bounds).length) {
      this.updateSelectionFrame();
      return;
    }
    this.edit(() => setShapeBounds(pkg, ref.part, findShape(slideTree(pkg.edit(ref.part)), shapeId), bounds), { key });
  }

  private nudge(dx: number, dy: number): void {
    const shape = this.selectedShape();
    if (!shape || this.readOnly) return;
    const box = this.boxOf(shape);
    this.setBounds(shape.id, box, { ...box, x: box.x + dx, y: box.y + dy }, `nudge:${shape.id}`);
  }

  deleteSelectedShape(): void {
    const ref = this.currentRef();
    const pkg = this.pkg;
    const id = this.selectedShapeId;
    if (!ref || !pkg || !id) return;
    this.edit(() => {
      const doc = pkg.edit(ref.part);
      deleteShape(doc, findShape(slideTree(doc), id));
    }, { select: () => ({ slideId: ref.id }) });
  }

  private selectNextShape(step: number): void {
    const shapes = this.view?.shapes.filter(shape => shape.own) ?? [];
    if (!shapes.length) return;
    const index = shapes.findIndex(shape => shape.id === this.selectedShapeId);
    const next = index < 0 ? (step > 0 ? 0 : shapes.length - 1) : (index + step + shapes.length) % shapes.length;
    this.select(shapes[next].id);
  }

  // ---- Undoable edits -------------------------------------------------------------------------

  private refuse(code: SlidesRefusal): void {
    this.lastRefusal = Date.now();
    this.lastRefusalCode = code;
    this.bump();
  }

  /** Keep a change for undo and tell the document; changes that change nothing are dropped. */
  private record(change: PackageChange, before: ViewState, key?: string): HistoryEntry<ViewState> | undefined {
    const entry = this.history.record(change, before, this.viewState(), key);
    if (entry) this.document.changed();
    return entry;
  }

  /** Run a change of the package as one undoable step and redraw what it touched. */
  private edit<T>(operation: () => T, options: EditOptions<T> = {}): { result: T; entry?: HistoryEntry<ViewState> } | undefined {
    const pkg = this.pkg;
    if (!pkg || this.readOnly) return undefined;
    const before = this.viewState();
    let outcome: { result: T; change: PackageChange };
    try {
      outcome = pkg.transaction(operation);
    } catch (error) {
      if (error instanceof SlidesEditError) {
        console.debug('[SlidesEditor] Edit refused:', error.message);
        this.refuse(error.code);
        return undefined;
      }
      throw error;
    }
    const selected = options.select?.(outcome.result);
    if (selected) {
      this.currentSlideId = selected.slideId ?? this.currentSlideId;
      this.selectedShapeId = selected.shapeId;
    }
    const entry = this.record(outcome.change, before, options.key);
    const redraw = options.redraw ?? 'slide';
    if (redraw === 'all') this.renderAll();
    else if (redraw === 'slide') {
      this.renderStage();
      this.redrawThumbnail(this.currentSlideId);
      this.bump();
    }
    return { result: outcome.result, entry };
  }

  undo(): void {
    this.endTextEditing();
    this.syncNotes();
    const entry = this.pkg ? this.history.undo(this.pkg) : undefined;
    if (!entry) return;
    this.restoreView(entry.before);
    this.document.changed();
    this.renderAll();
  }

  redo(): void {
    this.endTextEditing();
    this.syncNotes();
    const entry = this.pkg ? this.history.redo(this.pkg) : undefined;
    if (!entry) return;
    this.restoreView(entry.after);
    this.document.changed();
    this.renderAll();
  }

  private restoreView(state: ViewState): void {
    const refs = this.pkg ? slideRefs(this.pkg) : [];
    const index = Math.max(0, refs.findIndex(ref => ref.id === this.currentSlideId));
    this.currentSlideId = refs.some(ref => ref.id === state.slideId) ? state.slideId : refs[Math.min(index, refs.length - 1)]?.id;
    this.selectedShapeId = state.slideId === this.currentSlideId ? state.shapeId : undefined;
  }

  // ---- Slides ---------------------------------------------------------------------------------

  addSlide(): void {
    const pkg = this.pkg;
    if (!pkg) return;
    const ref = this.currentRef();
    const layout = layoutAfter(pkg, ref?.part);
    if (!layout) {
      this.refuse(SlidesRefusal.Invalid);
      return;
    }
    this.endTextEditing();
    this.edit(() => addSlide(pkg, { layout, after: ref ? ref.index : -1 }), { redraw: 'all', select: created => ({ slideId: created.id }) });
  }

  duplicateSlide(): void {
    const pkg = this.pkg;
    const ref = this.currentRef();
    if (!pkg || !ref) return;
    this.endTextEditing();
    this.edit(() => duplicateSlide(pkg, ref.index), { redraw: 'all', select: created => ({ slideId: created.id }) });
  }

  deleteSlide(): void {
    const pkg = this.pkg;
    const ref = this.currentRef();
    if (!pkg || !ref || this.slideCount <= 1) return;
    this.endTextEditing();
    this.syncNotes();
    const refs = slideRefs(pkg);
    const neighbor = refs[ref.index + 1] ?? refs[ref.index - 1];
    this.edit(() => deleteSlide(pkg, ref.index), { redraw: 'all', select: () => ({ slideId: neighbor?.id }) });
  }

  moveSlide(from: number, to: number): void {
    const pkg = this.pkg;
    const moving = pkg ? slideRefs(pkg)[from] : undefined;
    if (!pkg || !moving || from === to) return;
    this.endTextEditing();
    this.edit(() => moveSlide(pkg, from, to), { redraw: 'all', select: () => ({ slideId: moving.id }) });
  }

  /** A text box in the middle of the slide, ready for typing; left empty, it goes away again. */
  insertTextBox(): void {
    const pkg = this.pkg;
    const ref = this.currentRef();
    if (!pkg || !ref || this.readOnly) return;
    this.endTextEditing();
    const size = slideSize(pkg);
    const w = Math.round(size.cx * 0.4);
    const h = Math.round(40 * PX_PER_PT * EMU_PER_PX);
    const done = this.edit(() => {
      const doc = pkg.edit(ref.part);
      return addTextBox(doc, slideTree(doc), { x: (size.cx - w) / 2, y: (size.cy - h) / 2, w, h }, '', {}, undefined, t('slidesTextBoxName'));
    }, { select: id => ({ slideId: ref.id, shapeId: id }) });
    if (done && this.beginTextEditing(done.result) && this.editing) this.editing.created = done.entry;
  }

  // ---- Text -----------------------------------------------------------------------------------

  /** Start typing into a shape's text, or a table cell (rows and columns from 0). */
  beginTextEditing(shapeId: string, options: { point?: { x: number; y: number }; cell?: { row: number; column: number }; selectAll?: boolean } = {}): boolean {
    const ref = this.currentRef();
    if (this.readOnly || !this.pkg || !ref) return false;
    this.endTextEditing();
    const shapeElement = this.shapeElement(shapeId);
    const container = options.cell
      ? shapeElement?.querySelector<HTMLElement>(`[data-cell="${options.cell.row},${options.cell.column}"] .${SlideElement.Text}`)
      : shapeElement?.querySelector<HTMLElement>(`:scope > .${SlideElement.Text}:not(.lobster-slide-prompt)`);
    if (!shapeElement || !container) return false;
    shapeElement.classList.add('lobster-slide-editing');
    container.contentEditable = 'true';
    container.spellcheck = false;
    container.addEventListener('input', this.onTextInput);
    container.addEventListener('compositionstart', this.onCompositionStart);
    container.addEventListener('compositionend', this.onCompositionEnd);
    container.addEventListener('paste', this.onTextPaste);
    container.addEventListener('drop', this.onTextDrop);
    this.editing = {
      slideId: ref.id, part: ref.part, shapeId, container, shapeElement, key: `text:${++this.editCount}`, pending: false, composing: false,
      ...(options.cell ? { cell: options.cell } : {}),
    };
    const top = ownShapeElement(shapeElement)?.dataset.shapeId;
    this.selectedShapeId = top ?? shapeId;
    container.focus({ preventScroll: true });
    if (options.selectAll) selectAllIn(container);
    else placeCaret(container, options.point);
    this.updateSelectionFrame();
    this.bump();
    return true;
  }

  private onTextInput = (): void => {
    const editing = this.editing;
    if (!editing) return;
    editing.pending = true;
    clearTimeout(editing.timer);
    if (!editing.composing) editing.timer = setTimeout(() => this.syncTextEditing(), TEXT_SYNC_DELAY_MS);
    this.bump();
  };

  private onCompositionStart = (): void => {
    if (this.editing) this.editing.composing = true;
  };

  private onCompositionEnd = (): void => {
    if (!this.editing) return;
    this.editing.composing = false;
    this.onTextInput();
  };

  /** Only plain text comes in: a new line starts a paragraph, as typing Enter does. */
  private onTextPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
      if (index) document.execCommand('insertParagraph');
      if (line) document.execCommand('insertText', false, line);
    });
  };

  private onTextDrop = (event: DragEvent): void => {
    event.preventDefault();
  };

  /** The text body being edited, in a part opened for changing. */
  private editedBody(editing: TextEditing): Element {
    const shape = findShape(slideTree(this.pkg!.edit(editing.part)), editing.shapeId);
    return editing.cell ? cellBody(shape, editing.cell.row, editing.cell.column) : ensureTextBody(shape);
  }

  /** Write what was typed into the slide: one undo step for the whole time a shape is edited. */
  private syncTextEditing(): void {
    const editing = this.editing;
    const pkg = this.pkg;
    if (!editing || !pkg || !editing.pending || editing.composing) return;
    clearTimeout(editing.timer);
    editing.pending = false;
    const paragraphs = readEditedParagraphs(editing.container);
    const before = this.viewState();
    try {
      const { change } = pkg.transaction(() => applyEditedParagraphs(this.editedBody(editing), paragraphs));
      this.record(change, before, editing.key);
    } catch (error) {
      console.warn('[SlidesEditor] Could not keep the typed text:', error);
    }
    this.redrawThumbnail(editing.slideId);
  }

  /** Stop typing; what was typed is kept, and the slide is drawn again from the file. */
  endTextEditing(): void {
    const editing = this.editing;
    if (!editing) return;
    editing.composing = false;
    this.syncTextEditing();
    this.dropTextEditing(true);
    if (editing.created && this.isEmptyText(editing)) this.revertTo(editing.created);
    this.renderStage();
    this.redrawThumbnail(editing.slideId);
    this.bump();
  }

  private isEmptyText(editing: TextEditing): boolean {
    try {
      const shape = findShape(slideTree(this.pkg!.xml(editing.part)), editing.shapeId);
      return !shapeText(shape).trim();
    } catch {
      return false;
    }
  }

  /** Take out a text box inserted for typing, and what was typed into it, as if it never happened. */
  private revertTo(entry: HistoryEntry<ViewState>): void {
    if (!this.pkg || !this.history.revertTo(this.pkg, entry)) return;
    this.selectedShapeId = undefined;
    this.document.changed();
  }

  /** Leave editing without writing anything, e.g. when the file is replaced. */
  private dropTextEditing(keepSelection = false): void {
    const editing = this.editing;
    if (!editing) return;
    clearTimeout(editing.timer);
    const { container } = editing;
    container.removeAttribute('contenteditable');
    container.removeEventListener('input', this.onTextInput);
    container.removeEventListener('compositionstart', this.onCompositionStart);
    container.removeEventListener('compositionend', this.onCompositionEnd);
    container.removeEventListener('paste', this.onTextPaste);
    container.removeEventListener('drop', this.onTextDrop);
    editing.shapeElement.classList.remove('lobster-slide-editing');
    const selection = window.getSelection();
    if (selection?.anchorNode && container.contains(selection.anchorNode)) selection.removeAllRanges();
    this.editing = undefined;
    if (!keepSelection) this.selectedShapeId = undefined;
  }

  private onSelectionChange = (): void => {
    if (!this.editing || this.selectionFrame) return;
    this.selectionFrame = requestAnimationFrame(() => {
      this.selectionFrame = 0;
      this.bump();
    });
  };

  /** The edited text's view after a change to its formatting. */
  private editedTextView(editing: TextEditing): TextView | undefined {
    const view = this.pkg ? buildSlideView(this.pkg, editing.part) : undefined;
    const shape = findView(view?.shapes, editing.shapeId);
    if (!editing.cell) return shape?.text;
    return shape?.table?.rows[editing.cell.row]?.cells[editing.cell.column]?.text;
  }

  /**
   * Change the paragraphs under the caret (or in the selection) while typing, then draw the text
   * again with the caret where it was.
   */
  private changeEditedText(change: (paragraphs: Element[], range: { start: TextPosition; end: TextPosition }) => void): void {
    const editing = this.editing;
    const pkg = this.pkg;
    const range = editing ? selectionIn(editing.container) : undefined;
    if (!editing || !pkg || !range) return;
    editing.pending = true;
    this.syncTextEditing();
    const before = this.viewState();
    try {
      const { change: recorded } = pkg.transaction(() => change(paragraphsOf(this.editedBody(editing)), range));
      this.record(recorded, before, editing.key);
    } catch (error) {
      if (error instanceof SlidesEditError) return this.refuse(error.code);
      throw error;
    }
    const text = this.editedTextView(editing);
    if (text) {
      renderParagraphs(editing.container, text);
      setSelectionIn(editing.container, range.start, range.end);
    }
    this.redrawThumbnail(editing.slideId);
    this.bump();
  }

  /** Bold, italic, color, size, font: on the selected text while typing, else on the whole shape. */
  applyTextStyle(change: TextStyleChange): void {
    if (!this.editable) return;
    if (this.editing) {
      this.changeEditedText((paragraphs, { start, end }) => {
        if (start.paragraph === end.paragraph && start.offset === end.offset) {
          // A collapsed caret formats the word it is in, or an empty paragraph for what is typed next.
          const paragraph = paragraphs[start.paragraph];
          if (!paragraph) return;
          const text = paragraphText(paragraph);
          const word = wordAt(text, start.offset);
          if (word) formatRange(paragraph, change, word.start, word.end);
          else if (!text) formatRange(paragraph, change);
          return;
        }
        for (let index = start.paragraph; index <= end.paragraph; index++) {
          const paragraph = paragraphs[index];
          if (paragraph) formatRange(paragraph, change, index === start.paragraph ? start.offset : 0, index === end.paragraph ? end.offset : Number.POSITIVE_INFINITY);
        }
      });
      return;
    }
    this.changeSelectedShapeText(body => { for (const paragraph of paragraphsOf(body)) formatRange(paragraph, change); });
  }

  applyAlignment(align: typeof SlidesAlign[keyof typeof SlidesAlign]): void {
    if (!this.editable) return;
    if (this.editing) {
      this.changeEditedText((paragraphs, { start, end }) => {
        for (let index = start.paragraph; index <= end.paragraph; index++) if (paragraphs[index]) setAlignment(paragraphs[index], align);
      });
      return;
    }
    this.changeSelectedShapeText(body => { for (const paragraph of paragraphsOf(body)) setAlignment(paragraph, align); });
  }

  /** Tab and Shift+Tab: the list level of the paragraphs under the caret. */
  private changeLevel(step: number): void {
    this.changeEditedText((paragraphs, { start, end }) => {
      for (let index = start.paragraph; index <= end.paragraph; index++) {
        const paragraph = paragraphs[index];
        if (paragraph) setLevel(paragraph, Math.max(0, Math.min(8, paragraphLevel(paragraph) + step)));
      }
    });
  }

  private changeSelectedShapeText(change: (body: Element) => void): void {
    const ref = this.currentRef();
    const pkg = this.pkg;
    const id = this.selectedShapeId;
    if (!ref || !pkg || !id) return;
    this.edit(() => {
      const shape = findShape(slideTree(pkg.edit(ref.part)), id);
      const bodies = shape.localName === 'grpSp'
        ? Array.from(shape.getElementsByTagNameNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'txBody'))
        : textBodies(shape);
      for (const body of bodies) change(body);
    });
  }

  /** The formatting under the caret while typing, else of the selected shape's first text. */
  formatState(): SlidesFormatState | undefined {
    if (this.editing) {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      if (!anchor || !this.editing.container.contains(anchor)) return undefined;
      const target = anchor instanceof Element ? anchor : anchor.parentElement;
      if (!target) return undefined;
      const style = getComputedStyle(target);
      const paragraph = target.closest(`.${SlideElement.Paragraph}`);
      const decoration = style.textDecorationLine;
      return {
        bold: Number(style.fontWeight) >= 600,
        italic: style.fontStyle === 'italic',
        underline: decoration.includes('underline'),
        strike: decoration.includes('line-through'),
        font: style.fontFamily.split(',')[0]?.replace(/["']/g, '').trim(),
        size: Math.round((parseFloat(style.fontSize) / PX_PER_PT) * 2) / 2,
        align: paragraph ? getComputedStyle(paragraph).textAlign : undefined,
      };
    }
    const shape = this.selectedShape();
    const text = shape?.text ?? shape?.table?.rows[0]?.cells[0]?.text;
    const paragraph = text?.paragraphs[0];
    if (!paragraph) return undefined;
    const run = paragraph.runs.find(item => !item.lineBreak)?.style ?? paragraph.endStyle;
    return {
      bold: run.bold, italic: run.italic, underline: run.underline, strike: run.strike,
      font: run.fontFamily.split(',')[0]?.replace(/"/g, '').trim(), size: run.sizePt, align: paragraph.align,
    };
  }

  // ---- Notes ----------------------------------------------------------------------------------

  private syncNotesField(): void {
    if (document.activeElement === this.notes && this.notesSlideId === this.currentSlideId) return;
    const ref = this.currentRef();
    this.notes.value = ref && this.pkg ? notesText(this.pkg, ref.part) : '';
    this.notes.disabled = !ref;
  }

  private onNotesFocus = (): void => {
    this.notesSession++;
    this.notesSlideId = this.currentSlideId;
  };

  private onNotesInput = (): void => {
    this.notesPending = true;
    clearTimeout(this.notesTimer);
    this.notesTimer = setTimeout(() => this.syncNotes(), NOTES_SYNC_DELAY_MS);
  };

  private syncNotes(): void {
    clearTimeout(this.notesTimer);
    const pkg = this.pkg;
    const ref = pkg ? slideRefs(pkg).find(item => item.id === this.notesSlideId) : undefined;
    if (!this.notesPending || !pkg || !ref) return;
    this.notesPending = false;
    const text = this.notes.value;
    const done = this.edit(() => setNotes(pkg, ref.part, text), { key: `notes:${this.notesSession}`, redraw: 'none' });
    if (!done) this.syncNotesField();
  }

  // ---- Keyboard -------------------------------------------------------------------------------

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.target === this.notes || event.isComposing) return;
    const key = event.key;
    const mod = event.metaKey || event.ctrlKey;
    const stop = () => { event.preventDefault(); event.stopPropagation(); };
    if (this.editing) {
      if (key === 'Escape') {
        stop();
        this.endTextEditing();
        this.stage.focus({ preventScroll: true });
      } else if (mod && !event.altKey && ['b', 'i', 'u'].includes(key.toLowerCase())) {
        stop();
        const state = this.formatState();
        const name = key.toLowerCase() === 'b' ? 'bold' : key.toLowerCase() === 'i' ? 'italic' : 'underline';
        this.applyTextStyle({ [name]: !state?.[name] });
      } else if (key === 'Tab') {
        stop();
        this.changeLevel(event.shiftKey ? -1 : 1);
      }
      return;
    }
    if (mod && !event.altKey && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) {
      stop();
      if (key.toLowerCase() === 'y' || event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    // The slide pane handles its own keys.
    if (this.slideList.pane.contains(event.target as Node)) return;
    const shape = this.selectedShape();
    if (!shape) {
      if (key === 'Tab') { stop(); this.selectNextShape(event.shiftKey ? -1 : 1); }
      else if (key === 'PageDown' || key === 'ArrowDown' || key === 'ArrowRight') { stop(); this.selectSlide(Math.min(this.slideCount - 1, this.currentIndex + 1)); }
      else if (key === 'PageUp' || key === 'ArrowUp' || key === 'ArrowLeft') { stop(); this.selectSlide(Math.max(0, this.currentIndex - 1)); }
      return;
    }
    const step = (event.altKey || mod ? 1 : NUDGE_PX) / this.zoom;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (key === 'Escape') { stop(); this.select(undefined); }
    else if (key === 'Tab') { stop(); this.selectNextShape(event.shiftKey ? -1 : 1); }
    else if (!this.editable) return;
    else if (key === 'Delete' || key === 'Backspace') { stop(); this.deleteSelectedShape(); }
    else if (arrows[key]) { stop(); this.nudge(...arrows[key]); }
    else if (key === 'Enter' || key === 'F2') { stop(); this.beginTextEditing(shape.id); }
  };

  // ---- Chat -----------------------------------------------------------------------------------

  setChatHandler(handler: ((reference: SlidesChatReference) => void) | undefined): void {
    this.chatHandler = handler;
    this.updateSelectionFrame();
  }

  /** The selected shape (or, while typing, the selected text in it) as a chat reference. */
  chatReference(): SlidesChatReference | undefined {
    const ref = this.currentRef();
    const pkg = this.pkg;
    const id = this.editing?.shapeId ?? this.selectedShapeId;
    if (!ref || !pkg || !id) return undefined;
    try {
      const shape = findShape(slideTree(pkg.xml(ref.part)), id);
      const selected = this.editing ? window.getSelection()?.toString().trim() : '';
      const text = selected || shapeText(shape).trim() || shapeNameOf(shape);
      return { text, slide: ref.index + 1, shapeId: id, shapeName: shapeNameOf(shape) };
    } catch {
      return undefined;
    }
  }

  private onChatClick = (): void => {
    const reference = this.chatReference();
    if (reference) this.chatHandler?.(reference);
  };

  // ---- Agent ----------------------------------------------------------------------------------

  /** ppt_read: the slides, with what the user has selected. */
  agentRead(args: Record<string, unknown>): Record<string, unknown> {
    const pkg = this.pkg;
    if (!pkg) throw new SlidesEditError('The PowerPoint editor is still opening this presentation; try again.');
    this.syncTextEditing();
    this.syncNotes();
    const ref = this.currentRef();
    return {
      ...readSlides(pkg, { slides: args.slides }),
      ...(ref ? { selection: { slide: ref.index + 1, ...(this.editing?.shapeId ?? this.selectedShapeId ? { shape: this.editing?.shapeId ?? this.selectedShapeId } : {}) } } : {}),
    };
  }

  /** ppt_edit: all edits as one undoable step, shown when done; nothing changes when one is refused. */
  applyAgentEdits(edits: unknown, revision: number): SlidesEditResult {
    const pkg = this.pkg;
    if (!pkg) throw new SlidesEditError('The PowerPoint editor is still opening this presentation; try again.');
    this.endTextEditing();
    this.syncNotes();
    if (this.document.currentRevision !== revision) throw new SlidesEditError('The user edited the presentation while the change was prepared. Call ppt_read again.');
    const before = this.viewState();
    const { result, change } = pkg.transaction(() => applySlidesEdits(pkg, edits));
    const refs = slideRefs(pkg);
    const focus = result.focus ? refs[result.focus.slide - 1] : undefined;
    if (focus) this.currentSlideId = focus.id;
    else if (!refs.some(ref => ref.id === this.currentSlideId)) this.currentSlideId = refs[Math.min(Math.max(0, this.currentIndex), refs.length - 1)]?.id;
    this.selectedShapeId = undefined;
    if (focus && result.focus?.shape) {
      const view = buildSlideView(pkg, focus.part);
      const top = view.shapes.find(shape => shape.own && (shape.id === result.focus!.shape || findView(shape.children, result.focus!.shape!)));
      this.selectedShapeId = top?.id;
    }
    this.record(change, before);
    this.renderAll();
    return result;
  }
}

const registry = createOfficeEditorRegistry<SlidesPackageInfo, SlidesEditorSession>({
  bridge: () => window.electron.artifact.office.slides,
  create: (file, context) => new SlidesEditorSession(file, context),
  maxCachedSessions: 4,
  logTag: '[SlidesEditor]',
  hot: import.meta.hot,
  hotKey: 'slidesEditorRegistry',
});

export const acquireSlidesEditor = registry.acquire;
/** Route refreshes through the live session instead of replacing its artifact bytes. */
export const refreshOpenSlidesEditor = registry.refresh;
