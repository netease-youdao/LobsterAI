import type { SlideRef } from './slidesDeck';
import { resolveHorizontalThumbSize, SlidesThumbLayout } from './slidesLayout';

/**
 * Adaptive slide thumbnails:
 * - Narrow split panels (`bottom`): Manus-style horizontal filmstrip along the bottom so 16:9
 *   slides keep 100% of the horizontal width while remaining one-click navigable.
 * - Wide/expanded panels (`left`): PowerPoint-style docked vertical rail that collapses into a
 *   Codex-style left edge handle + translucent floating drawer with a pin button.
 *
 * Thumbnails render lazily via IntersectionObserver, support drag-and-drop reordering in both
 * orientations, include an inline "+" add-slide card, and trigger per-slide context actions.
 */

/** Vertical-rail thumbnails take this share of the editor's width, within these bounds in pixels. */
const THUMBNAIL_SHARE = 0.16;
const THUMBNAIL_WIDTH = { min: 72, max: 150 } as const;
const DRAG_TYPE = 'application/x-lobster-slide';
const SVG_NS = 'http://www.w3.org/2000/svg';
const FLOATING_CLOSE_DELAY_MS = 220;

export function thumbnailWidth(editorWidth: number): number {
  return Math.round(Math.max(THUMBNAIL_WIDTH.min, Math.min(THUMBNAIL_WIDTH.max, editorWidth * THUMBNAIL_SHARE)));
}

export interface ThumbnailListHost {
  /** Draw a slide at its own size into a thumbnail frame; the list scales it to the frame. */
  draw: (ref: SlideRef, frame: HTMLElement) => void;
  select: (index: number) => void;
  move: (from: number, to: number) => void;
  /** Add a new slide at the end (or after the current slide). */
  add: () => void;
  /** Delete the current slide. */
  remove: () => void;
  editable: () => boolean;
  /** The pane's dock/collapse toggle was pressed. */
  toggle: () => void;
  /** Open the per-slide action menu (duplicate, delete, new slide after). */
  openMenu?: (index: number, anchor: { x: number; y: number }) => void;
}

export interface ThumbnailListLabels {
  /** The list's accessible name. */
  list: string;
  /** The pane's heading. */
  title: string;
  /** Slide count label template with `{count}` (e.g. "{count} 页" / "{count} slides"). */
  count: string;
  show: string;
  hide: string;
  pin: string;
  unpin: string;
  addSlide: string;
  slideActions: string;
}

function createSvg(viewBox: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** Sidebar dock/pin icon (Codex-style split panel icon). */
function dockIcon(): SVGSVGElement {
  const svg = createSvg('0 0 16 16');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '2');
  rect.setAttribute('y', '2.5');
  rect.setAttribute('width', '12');
  rect.setAttribute('height', '11');
  rect.setAttribute('rx', '2');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', 'M6 2.5v11');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(rect, line);
  return svg;
}

/** Codex-style minimal 3-bar left-edge handle. */
function edgeHandleIcon(): SVGSVGElement {
  const svg = createSvg('0 0 14 24');
  const lines: [string, string, string][] = [
    ['2', '6', '10'],
    ['2', '12', '12'],
    ['2', '18', '8'],
  ];
  for (const [x1, y, x2] of lines) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M${x1} ${y}H${x2}`);
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
  }
  return svg;
}

/** Plus icon for the inline add-slide card. */
function plusIcon(): SVGSVGElement {
  const svg = createSvg('0 0 16 16');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 3.5v9M3.5 8h9');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

/** Horizontal ellipsis icon for per-slide quick actions. */
function moreDotsIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  for (const cx of ['3.5', '8', '12.5']) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', '8');
    circle.setAttribute('r', '1.25');
    svg.appendChild(circle);
  }
  return svg;
}

function item(className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  return element;
}

export class SlidesThumbnailList {
  /** The outer thumbnail pane placed in the workspace. */
  readonly pane = item('lobster-slides-pane');
  /** The scrollable list itself, which takes focus and handles arrow/Delete keys. */
  readonly element = item('lobster-slides-thumbnails');
  private readonly surface = item('lobster-slides-pane-surface');
  private readonly edgeHandle = document.createElement('button');
  private readonly title = document.createElement('span');
  private readonly toggle = document.createElement('button');
  private labels?: ThumbnailListLabels;
  private refs: SlideRef[] = [];
  private currentId?: number;
  private dragIndex?: number;
  /** The slides' intrinsic dimensions in pixels. */
  private slideDimensions = { width: 16, height: 9 };
  private layout: SlidesThumbLayout = SlidesThumbLayout.Bottom;
  private leftWidth: number = THUMBNAIL_WIDTH.max;
  private bottomShown = true;
  private leftDocked = true;
  private floatingOpen = false;
  private menuOpen = false;
  private floatingCloseTimer?: ReturnType<typeof setTimeout>;
  private readonly observer: IntersectionObserver;

  constructor(private readonly host: ThumbnailListHost) {
    this.edgeHandle.type = 'button';
    this.edgeHandle.className = 'lobster-slides-edge-handle';
    this.edgeHandle.appendChild(edgeHandleIcon());
    this.edgeHandle.addEventListener('mousedown', event => event.preventDefault());
    this.edgeHandle.addEventListener('pointerenter', () => {
      if (this.layout === SlidesThumbLayout.Left && !this.leftDocked) {
        this.openFloating();
      }
    });
    this.edgeHandle.addEventListener('click', () => {
      if (this.layout === SlidesThumbLayout.Left && !this.leftDocked) {
        if (this.floatingOpen) this.closeFloating();
        else this.openFloating();
      }
    });

    const header = item('lobster-slides-pane-header');
    this.title.className = 'lobster-slides-pane-title';
    this.toggle.type = 'button';
    this.toggle.className = 'lobster-slides-pane-toggle';
    this.toggle.appendChild(dockIcon());
    this.toggle.addEventListener('mousedown', event => event.preventDefault());
    this.toggle.addEventListener('click', () => this.host.toggle());
    header.append(this.title, this.toggle);

    this.surface.append(header, this.element);
    this.surface.addEventListener('pointerenter', this.cancelFloatingClose);
    this.surface.addEventListener('pointerleave', this.scheduleFloatingClose);
    this.pane.append(this.edgeHandle, this.surface);

    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'listbox');
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) this.draw(entry.target as HTMLElement);
    }, { root: this.element, rootMargin: '300px 300px' });

    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('contextmenu', this.onContextMenu);
    this.element.addEventListener('keydown', this.onKeyDown);
    this.element.addEventListener('dragstart', this.onDragStart);
    this.element.addEventListener('dragover', this.onDragOver);
    this.element.addEventListener('drop', this.onDrop);
    this.element.addEventListener('dragend', this.onDragEnd);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    this.syncPaneClasses();
  }

  setLabels(labels: ThumbnailListLabels): void {
    this.labels = labels;
    this.element.setAttribute('aria-label', labels.list);
    this.updateTitle();
    this.labelControls();
  }

  /** Rebuild the list for `refs` (in order) with slides of the given size in pixels; thumbnails draw lazily. */
  render(refs: SlideRef[], currentId: number | undefined, size: { width: number; height: number }): void {
    this.observer.disconnect();
    this.refs = refs;
    this.currentId = currentId;
    this.slideDimensions = size;
    this.element.style.setProperty('--lobster-slides-thumb-ratio', `${size.width} / ${size.height}`);
    this.applyDimensions();
    this.updateTitle();
    const editable = this.host.editable();
    const nodes: HTMLElement[] = refs.map(ref => {
      const entry = item('lobster-slides-thumb');
      entry.dataset.slideId = String(ref.id);
      entry.dataset.slideIndex = String(ref.index);
      entry.setAttribute('role', 'option');
      entry.setAttribute('aria-selected', String(ref.id === currentId));
      entry.draggable = editable;

      const number = document.createElement('span');
      number.className = `lobster-slides-thumb-number${ref.hidden ? ' lobster-slides-thumb-hidden' : ''}`;
      number.textContent = String(ref.index + 1);

      const frame = item('lobster-slides-thumb-frame');
      entry.append(number, frame);

      if (editable && this.host.openMenu) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'lobster-slides-thumb-more';
        more.title = this.labels?.slideActions ?? '';
        more.setAttribute('aria-label', this.labels?.slideActions ?? 'Slide actions');
        more.appendChild(moreDotsIcon());
        more.addEventListener('mousedown', event => event.preventDefault());
        more.addEventListener('click', event => {
          event.stopPropagation();
          const rect = more.getBoundingClientRect();
          this.host.openMenu?.(ref.index, { x: rect.right, y: rect.bottom + 4 });
        });
        entry.appendChild(more);
      }

      this.observer.observe(frame);
      return entry;
    });

    if (editable) {
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'lobster-slides-add-card';
      addButton.title = this.labels?.addSlide ?? '';
      addButton.setAttribute('aria-label', this.labels?.addSlide ?? 'New slide');
      addButton.appendChild(plusIcon());
      addButton.addEventListener('mousedown', event => event.preventDefault());
      addButton.addEventListener('click', () => this.host.add());
      nodes.push(addButton);
    }

    this.element.replaceChildren(...nodes);
    this.scrollToCurrent();
  }

  /** Mark the current slide without rebuilding the list. */
  markCurrent(currentId: number | undefined): void {
    this.currentId = currentId;
    for (const entry of Array.from(this.element.querySelectorAll<HTMLElement>('.lobster-slides-thumb'))) {
      entry.setAttribute('aria-selected', String(entry.dataset.slideId === String(currentId)));
    }
    this.scrollToCurrent();
  }

  /** Draw a slide's thumbnail again if it has been drawn. */
  redraw(slideId: number | undefined): void {
    const frame = this.element.querySelector<HTMLElement>(`[data-slide-id="${slideId}"] .lobster-slides-thumb-frame`);
    if (frame?.firstChild) this.draw(frame);
  }

  /** Update layout orientation (`bottom` vs `left`) and size thumbnails for `editorWidth`. */
  fit(editorWidth: number, nextLayout?: SlidesThumbLayout): void {
    const targetLayout = nextLayout ?? this.layout;
    const layoutChanged = targetLayout !== this.layout;
    const nextLeftWidth = thumbnailWidth(editorWidth);
    const widthChanged = nextLeftWidth !== this.leftWidth;

    this.layout = targetLayout;
    this.leftWidth = nextLeftWidth;

    if (layoutChanged) {
      this.closeFloating();
      this.syncPaneClasses();
      this.labelControls();
    }
    if (layoutChanged || widthChanged) {
      this.applyDimensions();
      if (layoutChanged && this.shown) {
        this.scrollToCurrent();
      }
    }
  }

  get currentLayout(): SlidesThumbLayout {
    return this.layout;
  }

  /** Whether thumbnails are currently docked/visible in the layout flow. */
  get shown(): boolean {
    return this.layout === SlidesThumbLayout.Left ? this.leftDocked : this.bottomShown;
  }

  /** Show/dock or hide/collapse thumbnails for the active orientation. */
  setShown(shown: boolean): void {
    if (this.layout === SlidesThumbLayout.Left) {
      if (shown === this.leftDocked) return;
      this.leftDocked = shown;
      if (shown) this.closeFloating();
    } else {
      if (shown === this.bottomShown) return;
      this.bottomShown = shown;
    }
    this.syncPaneClasses();
    this.labelControls();
    if (shown) this.scrollToCurrent();
  }

  /** Keep the floating drawer open while an external slide context menu is open. */
  setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    if (open) {
      this.cancelFloatingClose();
    }
  }

  dispose(): void {
    this.cancelFloatingClose();
    this.observer.disconnect();
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
  }

  private openFloating(): void {
    this.cancelFloatingClose();
    if (this.floatingOpen) return;
    this.floatingOpen = true;
    this.syncPaneClasses();
    this.scrollToCurrent();
  }

  private closeFloating(): void {
    this.cancelFloatingClose();
    if (!this.floatingOpen) return;
    this.floatingOpen = false;
    this.syncPaneClasses();
  }

  private cancelFloatingClose = (): void => {
    if (this.floatingCloseTimer !== undefined) {
      clearTimeout(this.floatingCloseTimer);
      this.floatingCloseTimer = undefined;
    }
  };

  private scheduleFloatingClose = (): void => {
    if (this.layout !== SlidesThumbLayout.Left || this.leftDocked || !this.floatingOpen) return;
    if (this.menuOpen || this.dragIndex !== undefined) return;
    this.cancelFloatingClose();
    this.floatingCloseTimer = setTimeout(() => {
      this.floatingCloseTimer = undefined;
      if (!this.menuOpen && this.dragIndex === undefined) {
        this.closeFloating();
      }
    }, FLOATING_CLOSE_DELAY_MS);
  };

  private onDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.floatingOpen || this.menuOpen) return;
    const target = event.target as Node | null;
    if (target && this.pane.contains(target)) return;
    this.closeFloating();
  };

  private syncPaneClasses(): void {
    const isLeft = this.layout === SlidesThumbLayout.Left;
    const isDocked = this.shown;
    this.pane.dataset.layout = this.layout;
    this.pane.classList.toggle('lobster-slides-pane-left', isLeft);
    this.pane.classList.toggle('lobster-slides-pane-bottom', !isLeft);
    this.pane.classList.toggle('lobster-slides-pane-collapsed', !isDocked);
    this.pane.classList.toggle('lobster-slides-pane-floating-open', isLeft && !isDocked && this.floatingOpen);
    this.element.setAttribute('aria-orientation', isLeft ? 'vertical' : 'horizontal');
  }

  private scrollToCurrent(): void {
    this.element.querySelector<HTMLElement>('.lobster-slides-thumb[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private updateTitle(): void {
    if (!this.labels) return;
    this.title.textContent = this.labels.count
      ? this.labels.count.replace('{count}', String(this.refs.length))
      : this.labels.title;
  }

  private labelControls(): void {
    if (!this.labels) return;
    const isLeft = this.layout === SlidesThumbLayout.Left;
    const toggleLabel = isLeft
      ? (this.leftDocked ? this.labels.unpin : this.labels.pin)
      : (this.bottomShown ? this.labels.hide : this.labels.show);
    this.toggle.title = toggleLabel;
    this.toggle.setAttribute('aria-label', toggleLabel);
    this.toggle.setAttribute('aria-pressed', String(isLeft && this.leftDocked));
    this.edgeHandle.title = this.labels.show;
    this.edgeHandle.setAttribute('aria-label', this.labels.show);
    const addButton = this.element.querySelector<HTMLButtonElement>('.lobster-slides-add-card');
    if (addButton) {
      addButton.title = this.labels.addSlide;
      addButton.setAttribute('aria-label', this.labels.addSlide);
    }
    for (const moreButton of Array.from(this.element.querySelectorAll<HTMLButtonElement>('.lobster-slides-thumb-more'))) {
      moreButton.title = this.labels.slideActions;
      moreButton.setAttribute('aria-label', this.labels.slideActions);
    }
  }

  /** Frames take the width and the slides' proportions from the list; drawn slides, the scale. */
  private applyDimensions(): void {
    const horizontalSize = resolveHorizontalThumbSize(this.slideDimensions);
    const thumbWidth = this.layout === SlidesThumbLayout.Left
      ? this.leftWidth
      : horizontalSize.width;
    this.element.style.setProperty('--lobster-slides-thumb-width', `${thumbWidth}px`);
    this.element.style.setProperty('--lobster-slides-thumb-height', `${horizontalSize.height}px`);
    if (this.slideDimensions.width > 0) {
      this.element.style.setProperty('--lobster-slides-thumb-scale', String(thumbWidth / this.slideDimensions.width));
    }
  }

  private draw(frame: HTMLElement): void {
    const ref = this.refs.find(candidate => String(candidate.id) === frame.parentElement?.dataset.slideId);
    if (ref) this.host.draw(ref, frame);
  }

  private thumbEntries(): HTMLElement[] {
    return Array.from(this.element.querySelectorAll<HTMLElement>('.lobster-slides-thumb'));
  }

  private indexOf(target: EventTarget | null): number {
    const entry = (target as Element | null)?.closest?.<HTMLElement>('.lobster-slides-thumb');
    if (!entry) return -1;
    const parsed = Number(entry.dataset.slideIndex);
    return Number.isInteger(parsed) ? parsed : this.thumbEntries().indexOf(entry);
  }

  private onClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (target?.closest('.lobster-slides-thumb-more, .lobster-slides-add-card')) return;
    const index = this.indexOf(target);
    this.element.focus({ preventScroll: true });
    if (index >= 0) this.host.select(index);
  };

  private onContextMenu = (event: MouseEvent): void => {
    if (!this.host.editable() || !this.host.openMenu) return;
    const index = this.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    this.host.openMenu(index, { x: event.clientX, y: event.clientY });
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
    this.cancelFloatingClose();
    event.dataTransfer?.setData(DRAG_TYPE, String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };

  /** Where a dragged slide would go: horizontal in bottom strip, vertical in left rail. */
  private dropPosition(event: DragEvent): number | undefined {
    const index = this.indexOf(event.target);
    if (this.dragIndex === undefined || index < 0) return undefined;
    const entry = this.thumbEntries()[index];
    if (!entry) return undefined;
    const rect = entry.getBoundingClientRect();
    if (this.layout === SlidesThumbLayout.Bottom) {
      return event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
    }
    return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
  }

  private onDragOver = (event: DragEvent): void => {
    const position = this.dropPosition(event);
    if (position === undefined) return;
    event.preventDefault();
    this.clearDropMarker();
    const entries = this.thumbEntries();
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
