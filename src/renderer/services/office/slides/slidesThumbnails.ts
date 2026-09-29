import type { SlideRef } from './slidesDeck';

/**
 * The slide list: a thumbnail per slide, drawn when it scrolls near view, with the current slide
 * marked. Clicking, the arrow keys and Delete act on slides, and dragging a thumbnail reorders.
 */

const THUMBNAIL_WIDTH = 150;
const DRAG_TYPE = 'application/x-lobster-slide';

export interface ThumbnailListHost {
  /** Draw a slide into a thumbnail frame of the given width. */
  draw: (ref: SlideRef, frame: HTMLElement, width: number) => void;
  select: (index: number) => void;
  move: (from: number, to: number) => void;
  /** Delete the current slide. */
  remove: () => void;
  editable: () => boolean;
}

function item(className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  return element;
}

export class SlidesThumbnailList {
  readonly element = item('lobster-slides-thumbnails');
  private refs: SlideRef[] = [];
  private currentId?: number;
  private dragIndex?: number;
  private readonly observer: IntersectionObserver;

  constructor(private readonly host: ThumbnailListHost) {
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

  setLabel(label: string): void {
    this.element.setAttribute('aria-label', label);
  }

  /** Rebuild the list for `refs` (in order) with slides of the given size; thumbnails draw lazily. */
  render(refs: SlideRef[], currentId: number | undefined, size: { cx: number; cy: number }): void {
    this.observer.disconnect();
    this.refs = refs;
    this.currentId = currentId;
    const height = Math.round((THUMBNAIL_WIDTH * size.cy) / size.cx);
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
      frame.style.width = `${THUMBNAIL_WIDTH}px`;
      frame.style.height = `${height}px`;
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

  dispose(): void {
    this.observer.disconnect();
  }

  private scrollToCurrent(): void {
    this.element.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  private draw(frame: HTMLElement): void {
    const ref = this.refs.find(item => String(item.id) === frame.parentElement?.dataset.slideId);
    if (ref) this.host.draw(ref, frame, THUMBNAIL_WIDTH);
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
