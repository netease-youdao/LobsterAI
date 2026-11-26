import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import CoworkPageFileDropOverlay from './CoworkPageFileDropOverlay';
import {
  BLOCKING_MODAL_SELECTOR,
  createPageFileDropController,
  type DataTransferLike,
  type DocumentLike,
  type DragEventLike,
  type ElementLike,
  hasFileTransfer,
  hasVisibleBlockingModal,
  isElementVisible,
  isLocalFileDropTarget,
  LOCAL_FILE_DROP_SELECTOR,
  type WindowLike,
} from './pageFileDrop';

class FakeEventTarget implements WindowLike {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeDocument extends FakeEventTarget implements DocumentLike {
  hidden = false;
  modals: ElementLike[] = [];

  querySelectorAll(selector: string): Iterable<ElementLike> {
    if (selector === BLOCKING_MODAL_SELECTOR) {
      return this.modals;
    }
    return [];
  }
}

const visibleElement = (overrides: Partial<ElementLike> = {}): ElementLike => ({
  isConnected: true,
  getClientRects: () => [{}],
  closest: () => null,
  ...overrides,
});

const hiddenElement = (overrides: Partial<ElementLike> = {}): ElementLike => ({
  isConnected: true,
  getClientRects: () => [],
  closest: () => null,
  ...overrides,
});

const makeDragEvent = (overrides: {
  dataTransfer?: DataTransferLike | null;
  defaultPrevented?: boolean;
  target?: unknown;
  relatedTarget?: unknown;
} = {}): DragEventLike & { preventDefaultMock: ReturnType<typeof vi.fn> } => {
  const preventDefaultMock = vi.fn();
  const event: DragEventLike & { preventDefaultMock: ReturnType<typeof vi.fn> } = {
    dataTransfer: overrides.dataTransfer !== undefined
      ? overrides.dataTransfer
      : { files: [], types: ['Files'], dropEffect: 'none' },
    defaultPrevented: overrides.defaultPrevented ?? false,
    target: overrides.target ?? visibleElement(),
    relatedTarget: overrides.relatedTarget,
    preventDefault: () => {
      event.defaultPrevented = true;
      preventDefaultMock();
    },
    preventDefaultMock,
  };
  return event;
};

describe('pageFileDrop helpers', () => {
  test('hasFileTransfer detects file drags and ignores non-file drags', () => {
    const file = { name: 'report.pdf' } as File;
    expect(hasFileTransfer(null)).toBe(false);
    expect(hasFileTransfer(undefined)).toBe(false);
    expect(hasFileTransfer({ files: [], types: ['text/plain', 'text/html'] })).toBe(false);
    expect(hasFileTransfer({ files: [], types: ['Files'] })).toBe(true);
    expect(hasFileTransfer({ files: [file], types: [] })).toBe(true);
  });

  test('isLocalFileDropTarget detects both element and text-node targets inside local drop zones', () => {
    const localZone = visibleElement({
      closest: selector => (selector === LOCAL_FILE_DROP_SELECTOR ? {} : null),
    });
    const textNodeInsideLocalZone = { parentElement: localZone };
    const regularElement = visibleElement();

    expect(isLocalFileDropTarget(localZone)).toBe(true);
    expect(isLocalFileDropTarget(textNodeInsideLocalZone)).toBe(true);
    expect(isLocalFileDropTarget(regularElement)).toBe(false);
    expect(isLocalFileDropTarget(null)).toBe(false);
  });

  test('hasVisibleBlockingModal ignores hidden or minimized modals', () => {
    const doc = new FakeDocument();
    expect(hasVisibleBlockingModal(doc)).toBe(false);

    doc.modals = [hiddenElement()];
    expect(hasVisibleBlockingModal(doc)).toBe(false);

    doc.modals = [hiddenElement(), visibleElement()];
    expect(hasVisibleBlockingModal(doc)).toBe(true);
  });

  test('isElementVisible requires connected element with client rects', () => {
    expect(isElementVisible(null)).toBe(false);
    expect(isElementVisible(hiddenElement())).toBe(false);
    expect(isElementVisible({ isConnected: false, getClientRects: () => [{}] })).toBe(false);
    expect(isElementVisible(visibleElement())).toBe(true);
  });
});

describe('createPageFileDropController', () => {
  const setup = (overrides: {
    enabled?: boolean;
    anchor?: ElementLike | null;
    modals?: ElementLike[];
  } = {}) => {
    const windowTarget = new FakeEventTarget();
    const documentTarget = new FakeDocument();
    documentTarget.modals = overrides.modals ?? [];
    let enabled = overrides.enabled ?? true;
    let anchor: ElementLike | null = overrides.anchor !== undefined ? overrides.anchor : visibleElement();
    const activeChanges: boolean[] = [];
    const droppedBatches: File[][] = [];

    const controller = createPageFileDropController({
      windowTarget,
      documentTarget,
      isEnabled: () => enabled,
      getAnchorElement: () => anchor,
      onActiveChange: next => activeChanges.push(next),
      onDropFiles: files => droppedBatches.push(files),
    });

    return {
      windowTarget,
      documentTarget,
      controller,
      activeChanges,
      droppedBatches,
      setEnabled: (next: boolean) => { enabled = next; },
      setAnchor: (next: ElementLike | null) => { anchor = next; },
    };
  };

  test('activates across nested elements and forwards dropped files from anywhere on the page', () => {
    const { windowTarget, activeChanges, droppedBatches, controller } = setup();
    const fileA = { name: 'a.pdf' } as File;
    const fileB = { name: 'b.png' } as File;
    const outer = visibleElement();
    const inner = visibleElement();

    const enterOuter = makeDragEvent({ target: outer });
    windowTarget.dispatch('dragenter', enterOuter);
    expect(enterOuter.preventDefaultMock).toHaveBeenCalledTimes(1);
    expect(activeChanges).toEqual([true]);

    // Crossing into a child fires dragenter on child then dragleave on parent
    windowTarget.dispatch('dragenter', makeDragEvent({ target: inner }));
    windowTarget.dispatch('dragleave', makeDragEvent({ target: outer, relatedTarget: inner }));
    expect(activeChanges).toEqual([true]);

    const overInner = makeDragEvent({ target: inner });
    windowTarget.dispatch('dragover', overInner);
    expect(overInner.preventDefaultMock).toHaveBeenCalledTimes(1);
    expect(overInner.dataTransfer?.dropEffect).toBe('copy');

    const dropEvent = makeDragEvent({
      target: inner,
      dataTransfer: { files: [fileA, fileB], types: ['Files'] },
    });
    windowTarget.dispatch('drop', dropEvent);
    expect(dropEvent.preventDefaultMock).toHaveBeenCalledTimes(1);
    expect(activeChanges).toEqual([true, false]);
    expect(droppedBatches).toEqual([[fileA, fileB]]);

    controller.dispose();
  });

  test('clears active overlay immediately when leaving the viewport (relatedTarget is null)', () => {
    const { windowTarget, activeChanges, controller } = setup();
    const outer = visibleElement();
    const inner = visibleElement();

    windowTarget.dispatch('dragenter', makeDragEvent({ target: outer }));
    windowTarget.dispatch('dragenter', makeDragEvent({ target: inner }));
    expect(activeChanges).toEqual([true]);

    // Leaving window or entering webview reports relatedTarget === null even if depth > 1
    windowTarget.dispatch('dragleave', makeDragEvent({ target: inner, relatedTarget: null }));
    expect(activeChanges).toEqual([true, false]);

    controller.dispose();
  });

  test('yields cleanly to local drop targets (such as editable Word editor) without double-uploading', () => {
    const { windowTarget, activeChanges, droppedBatches, controller } = setup();
    const pageTarget = visibleElement();
    const wordEditorTarget = visibleElement({
      closest: selector => (selector === LOCAL_FILE_DROP_SELECTOR ? {} : null),
    });
    const imageFile = { name: 'photo.png' } as File;

    // Enter page first -> overlay activates
    windowTarget.dispatch('dragenter', makeDragEvent({ target: pageTarget }));
    expect(activeChanges).toEqual([true]);

    // Move onto editable Word editor -> overlay hides and event is not intercepted
    const overWord = makeDragEvent({ target: wordEditorTarget });
    windowTarget.dispatch('dragover', overWord);
    expect(overWord.preventDefaultMock).not.toHaveBeenCalled();
    expect(activeChanges).toEqual([true, false]);

    // Drop on Word editor -> page drop does not capture it
    const dropWord = makeDragEvent({
      target: wordEditorTarget,
      dataTransfer: { files: [imageFile], types: ['Files'] },
    });
    windowTarget.dispatch('drop', dropWord);
    expect(dropWord.preventDefaultMock).not.toHaveBeenCalled();
    expect(droppedBatches).toEqual([]);

    // Moving back onto page restores overlay via dragover
    const overPageAgain = makeDragEvent({ target: pageTarget });
    windowTarget.dispatch('dragover', overPageAgain);
    expect(overPageAgain.preventDefaultMock).toHaveBeenCalledTimes(1);
    expect(activeChanges).toEqual([true, false, true]);

    controller.dispose();
  });

  test('ignores events already handled by a child drop target (defaultPrevented)', () => {
    const { windowTarget, activeChanges, droppedBatches, controller } = setup();
    const file = { name: 'image.png' } as File;

    const handledOver = makeDragEvent({ defaultPrevented: true });
    windowTarget.dispatch('dragover', handledOver);
    expect(activeChanges).toEqual([]);

    const handledDrop = makeDragEvent({
      defaultPrevented: true,
      dataTransfer: { files: [file], types: ['Files'] },
    });
    windowTarget.dispatch('drop', handledDrop);
    expect(droppedBatches).toEqual([]);

    controller.dispose();
  });

  test('blocks activation and drop while a visible modal is open, but allows when modal is hidden', () => {
    const { windowTarget, documentTarget, activeChanges, droppedBatches, controller } = setup();
    const file = { name: 'doc.md' } as File;

    documentTarget.modals = [visibleElement()];
    const blockedEnter = makeDragEvent();
    windowTarget.dispatch('dragenter', blockedEnter);
    expect(blockedEnter.preventDefaultMock).not.toHaveBeenCalled();
    expect(activeChanges).toEqual([]);

    const blockedDrop = makeDragEvent({ dataTransfer: { files: [file], types: ['Files'] } });
    windowTarget.dispatch('drop', blockedDrop);
    expect(droppedBatches).toEqual([]);

    // Minimized permission modal remains in DOM but hidden (no client rects)
    documentTarget.modals = [hiddenElement()];
    windowTarget.dispatch('dragenter', makeDragEvent());
    expect(activeChanges).toEqual([true]);

    windowTarget.dispatch('drop', makeDragEvent({ dataTransfer: { files: [file], types: ['Files'] } }));
    expect(droppedBatches).toEqual([[file]]);

    controller.dispose();
  });

  test('ignores drags when prompt input is hidden or disabled, and ignores non-file drags', () => {
    const { windowTarget, activeChanges, droppedBatches, setAnchor, setEnabled, controller } = setup();
    const file = { name: 'notes.txt' } as File;

    // Non-file drag (e.g. text selection or tab drag)
    const textDrag = makeDragEvent({ dataTransfer: { files: [], types: ['text/plain'] } });
    windowTarget.dispatch('dragenter', textDrag);
    expect(textDrag.preventDefaultMock).not.toHaveBeenCalled();
    expect(activeChanges).toEqual([]);

    // Hidden prompt (e.g. collapsed input in expanded artifact panel)
    setAnchor(hiddenElement());
    windowTarget.dispatch('dragenter', makeDragEvent());
    windowTarget.dispatch('drop', makeDragEvent({ dataTransfer: { files: [file], types: ['Files'] } }));
    expect(activeChanges).toEqual([]);
    expect(droppedBatches).toEqual([]);

    // Disabled prompt (e.g. remoteManaged or voice input active)
    setAnchor(visibleElement());
    setEnabled(false);
    windowTarget.dispatch('dragenter', makeDragEvent());
    windowTarget.dispatch('drop', makeDragEvent({ dataTransfer: { files: [file], types: ['Files'] } }));
    expect(activeChanges).toEqual([]);
    expect(droppedBatches).toEqual([]);

    controller.dispose();
  });

  test('self-heals overlay on blur, dragend, hidden tab, Escape, pointer activity, and dispose', () => {
    const { windowTarget, documentTarget, activeChanges, controller } = setup();

    const activate = () => windowTarget.dispatch('dragenter', makeDragEvent());

    activate();
    windowTarget.dispatch('blur', {});
    activate();
    windowTarget.dispatch('dragend', {});
    activate();
    documentTarget.hidden = true;
    documentTarget.dispatch('visibilitychange', {});
    documentTarget.hidden = false;
    activate();
    windowTarget.dispatch('keydown', { key: 'Escape' });
    activate();
    windowTarget.dispatch('pointermove', {});
    activate();
    windowTarget.dispatch('pointerdown', {});

    expect(activeChanges).toEqual([
      true, false,
      true, false,
      true, false,
      true, false,
      true, false,
      true, false,
    ]);

    activate();
    controller.dispose();
    expect(activeChanges[activeChanges.length - 1]).toBe(false);
    expect(windowTarget.listenerCount('dragenter')).toBe(0);
    expect(windowTarget.listenerCount('drop')).toBe(0);
    expect(documentTarget.listenerCount('visibilitychange')).toBe(0);
  });
});

describe('CoworkPageFileDropOverlay', () => {
  test('renders nothing when hidden and localized full-page overlay markup when visible', () => {
    expect(renderToStaticMarkup(React.createElement(CoworkPageFileDropOverlay, { visible: false }))).toBe('');

    for (const language of ['zh', 'en'] as const) {
      i18nService.setLanguage(language, { persist: false });
      const title = i18nService.t('coworkPageDropFileTitle');
      const description = i18nService.t('coworkPageDropFileDescription');
      expect(title).not.toBe('coworkPageDropFileTitle');
      expect(description).not.toBe('coworkPageDropFileDescription');

      const html = renderToStaticMarkup(React.createElement(CoworkPageFileDropOverlay, { visible: true }));
      expect(html).toContain('data-page-file-drop-overlay="true"');
      expect(html).toContain('pointer-events-none');
      expect(html).toContain('fixed inset-0');
      expect(html).toContain(title);
      expect(html).toContain(description);
    }
    i18nService.setLanguage('zh', { persist: false });
  });
});
