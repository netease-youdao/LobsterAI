import type { SlideRef } from './slidesDeck';

/**
 * The slide pane: a header with a button that hides the thumbnails, and a thumbnail per slide, drawn
 * when it scrolls near view, with the current slide marked. Clicking, the arrow keys and Delete act
 * on slides, and dragging a thumbnail reorders. Thumbnails are sized to the editor's width; hidden,
 * the pane keeps a slim strip with the button that brings them back.
 */

/** Thumbnails take this share of the editor's width, within these bounds in pixels. */
const THUMBNAIL_SHARE = 0.16;
const THUMBNAIL_WIDTH = { min: 72, max: 150 } as const;
const DRAG_TYPE = 'application/x-lobster-slide';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function thumbnailWidth(editorWidth: number): number {
  return Math.round(Math.max(THUMBNAIL_WIDTH.min, Math.min(THUMBNAIL_WIDTH.max, editorWidth * THUMBNAIL_SHARE)));
}

export interface ThumbnailListHost {
  /** Draw a slide at its own size into a thumbnail frame; the list scales it to the frame. */
  draw: (ref: SlideRef, frame: HTMLElement) => void;
  select: (index: number) => void;
  move: (from: number, to: number) => void;
  /** Delete the current slide. */
  remove: () => void;
  editable: () => boolean;
  /** The pane's button was pressed: show or hide the thumbnails. */
  toggle: () => void;
}

export interface ThumbnailListLabels {
  /** The list's accessible name. */
  list: string;
  /** The pane's heading. */
  title: string;
  show: string;
  hide: string;
}

/** A chevron pointing left, to hide the thumbnails; the hidden pane mirrors it. */
function chevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M10 3.5 5.5 8l4.5 4.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function item(className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  return element;
}

export class SlidesThumbnailList {
  /** The header and the list; it is what the editor lays out. */
  readonly pane = item('lobster-slides-pane');
  /** The list itself, which takes the focus and handles the keys. */
  readonly element = item('lobster-slides-thumbnails');
  private readonly title = document.createElement('span');
  private readonly toggle = document.createElement('button');
  private labels?: ThumbnailListLabels;
  private refs: SlideRef[] = [];
  private currentId?: number;
  private dragIndex?: number;
  /** The slides' width and the thumbnails', in pixels. */
  private slideWidth = 0;
  private width: number = THUMBNAIL_WIDTH.max;
  private readonly observer: IntersectionObserver;

  constructor(private readonly host: ThumbnailListHost) {
    const header = item('lobster-slides-pane-header');
    this.title.className = 'lobster-slides-pane-title';
    this.toggle.type = 'button';
    this.toggle.className = 'lobster-slides-pane-toggle';
    this.toggle.appendChild(chevron());
    // Like the toolbar's buttons, pressing it leaves the focus where it was.
    this.toggle.addEventListener('mousedown', event => event.preventDefault());
    this.toggle.addEventListener('click', () => this.host.toggle());
    header.append(this.title, this.toggle);
    this.pane.append(header, this.element);
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'listbox');
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) this.draw(entry.target as HTMLElement);
    }, { root: this.element, rootMargin: '300px 0px' });
    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('keydown', this.onKeyDown);
    this.element.addEventListener('dragstart', this.onDragStart);
    this.element.addEventListener('dragover', this.onDragOver);
    this.element.addEventListener('drop', this.onDrop);
    this.element.addEventListener('dragend', this.onDragEnd);
  }

  setLabels(labels: ThumbnailListLabels): void {
    this.labels = labels;
    this.element.setAttribute('aria-label', labels.list);
    this.title.textContent = labels.title;
    this.labelToggle();
  }

  /** Rebuild the list for `refs` (in order) with slides of the given size in pixels; thumbnails draw lazily. */
  render(refs: SlideRef[], currentId: number | undefined, size: { width: number; height: number }): void {
    this.observer.disconnect();
    this.refs = refs;
    this.currentId = currentId;
    this.slideWidth = size.width;
    this.element.style.setProperty('--lobster-slides-thumb-ratio', `${size.width} / ${size.height}`);
    this.applyWidth();
    const editable = this.host.editable();
    this.element.replaceChildren(...refs.map(ref => {
      const entry = item('lobster-slides-thumb');
      entry.dataset.slideId = String(ref.id);
      entry.setAttribute('role', 'option');
      entry.setAttribute('aria-selected', String(ref.id === currentId));
      entry.draggable = editable;
      const number = document.createElement('span');
      number.className = `lobster-slides-thumb-number${ref.hidden ? ' lobster-slides-thumb-hidden' : ''}`;
      number.textContent = String(ref.index + 1);
      const frame = item('lobster-slides-thumb-frame');
      entry.append(number, frame);
      this.observer.observe(frame);
      return entry;
    }));
    this.scrollToCurrent();
  }

  /** Mark the current slide without rebuilding the list. */
  markCurrent(currentId: number | undefined): void {
    this.currentId = currentId;
    for (const entry of Array.from(this.element.children) as HTMLElement[]) {
      entry.setAttribute('aria-selected', String(entry.dataset.slideId === String(currentId)));
    }
    this.scrollToCurrent();
  }

  /** Draw a slide's thumbnail again if it has been drawn. */
  redraw(slideId: number | undefined): void {
    const frame = this.element.querySelector<HTMLElement>(`[data-slide-id="${slideId}"] .lobster-slides-thumb-frame`);
    if (frame?.firstChild) this.draw(frame);
  }

  /** Size the thumbnails for an editor this wide; drawn ones are rescaled, not drawn again. */
  fit(editorWidth: number): void {
    const width = thumbnailWidth(editorWidth);
    if (width === this.width) return;
    this.width = width;
    this.applyWidth();
  }

  get shown(): boolean {
    return !this.element.hidden;
  }

  /** Show or hide the thumbnails; they come back scrolled to the current slide. */
  setShown(shown: boolean): void {
    if (shown === this.shown) return;
    this.element.hidden = !shown;
    this.pane.classList.toggle('lobster-slides-pane-collapsed', !shown);
    this.labelToggle();
    if (shown) this.scrollToCurrent();
  }

  dispose(): void {
    this.observer.disconnect();
  }

  private scrollToCurrent(): void {
    this.element.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  private labelToggle(): void {
    const label = this.shown ? this.labels?.hide : this.labels?.show;
    if (!label) return;
    this.toggle.title = label;
    this.toggle.setAttribute('aria-label', label);
  }

  /** Frames take the width and the slides' proportions from the list; drawn slides, the scale. */
  private applyWidth(): void {
    this.element.style.setProperty('--lobster-slides-thumb-width', `${this.width}px`);
    if (this.slideWidth > 0) this.element.style.setProperty('--lobster-slides-thumb-scale', String(this.width / this.slideWidth));
  }

  private draw(frame: HTMLElement): void {
    const ref = this.refs.find(item => String(item.id) === frame.parentElement?.dataset.slideId);
    if (ref) this.host.draw(ref, frame);
  }

  private indexOf(target: EventTarget | null): number {
    const entry = (target as Element | null)?.closest?.('.lobster-slides-thumb');
    return entry ? Array.from(this.element.children).indexOf(entry) : -1;
  }

  private onClick = (event: MouseEvent): void => {
    const index = this.indexOf(event.target);
    this.element.focus({ preventScroll: true });
    if (index >= 0) this.host.select(index);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const index = this.refs.findIndex(ref => ref.id === this.currentId);
    const last = this.refs.length - 1;
    const go = (next: number) => {
      event.preventDefault();
      event.stopPropagation();
      this.host.select(Math.max(0, Math.min(last, next)));
    };
    switch (event.key) {
      case 'ArrowUp': case 'ArrowLeft': case 'PageUp': go(index - 1); break;
      case 'ArrowDown': case 'ArrowRight': case 'PageDown': go(index + 1); break;
      case 'Home': go(0); break;
      case 'End': go(last); break;
      case 'Delete': case 'Backspace':
        if (!this.host.editable()) return;
        event.preventDefault();
        event.stopPropagation();
        this.host.remove();
        break;
      default: break;
    }
  };

  private onDragStart = (event: DragEvent): void => {
    const index = this.indexOf(event.target);
    if (index < 0 || !this.host.editable()) {
      event.preventDefault();
      return;
    }
    this.dragIndex = index;
    event.dataTransfer?.setData(DRAG_TYPE, String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };

  /** Where a dragged slide would go: before the slide under the pointer, or after it past its middle. */
  private dropPosition(event: DragEvent): number | undefined {
    const index = this.indexOf(event.target);
    if (this.dragIndex === undefined || index < 0) return undefined;
    const rect = (this.element.children[index] as HTMLElement).getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
  }

  private onDragOver = (event: DragEvent): void => {
    const position = this.dropPosition(event);
    if (position === undefined) return;
    event.preventDefault();
    this.clearDropMarker();
    const entries = Array.from(this.element.children) as HTMLElement[];
    const marked = entries[position] ?? entries[entries.length - 1];
    marked?.classList.add(position < entries.length ? 'lobster-slides-drop-before' : 'lobster-slides-drop-after');
  };

  private onDrop = (event: DragEvent): void => {
    const position = this.dropPosition(event);
    const from = this.dragIndex;
    this.onDragEnd();
    if (position === undefined || from === undefined) return;
    event.preventDefault();
    this.host.move(from, position > from ? position - 1 : position);
  };

  private onDragEnd = (): void => {
    this.clearDropMarker();
    this.dragIndex = undefined;
  };

  private clearDropMarker(): void {
    for (const entry of Array.from(this.element.querySelectorAll('.lobster-slides-drop-before, .lobster-slides-drop-after'))) {
      entry.classList.remove('lobster-slides-drop-before', 'lobster-slides-drop-after');
    }
  }
}
