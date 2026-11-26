import { type RefObject, useEffect, useRef, useState } from 'react';

export const LOCAL_FILE_DROP_ATTRIBUTE = 'data-local-file-drop';
export const LOCAL_FILE_DROP_SELECTOR = `[${LOCAL_FILE_DROP_ATTRIBUTE}="true"]`;
export const BLOCKING_MODAL_SELECTOR = '[data-app-modal], [aria-modal="true"], .modal-backdrop';

export interface DataTransferLike {
  files?: ArrayLike<File> | null;
  types?: ArrayLike<string> | Iterable<string> | null;
  dropEffect?: string;
}

export interface ElementLike {
  isConnected?: boolean;
  getClientRects?: () => ArrayLike<unknown>;
  closest?: (selector: string) => unknown;
  parentElement?: ElementLike | null;
}

export interface DocumentLike {
  hidden?: boolean;
  querySelectorAll: (selector: string) => Iterable<ElementLike>;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}

export interface WindowLike {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}

export interface DragEventLike {
  dataTransfer?: DataTransferLike | null;
  defaultPrevented: boolean;
  target: unknown;
  relatedTarget?: unknown;
  preventDefault: () => void;
}

export interface KeyboardEventLike {
  key: string;
}

export const hasFileTransfer = (dataTransfer: DataTransferLike | null | undefined): boolean => {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  if (!dataTransfer.types) return false;
  return Array.from(dataTransfer.types).includes('Files');
};

export const isElementVisible = (element: ElementLike | null | undefined): boolean => {
  if (!element || element.isConnected === false) return false;
  return (element.getClientRects?.().length ?? 0) > 0;
};

export const hasVisibleBlockingModal = (documentRoot: Pick<DocumentLike, 'querySelectorAll'> | null | undefined): boolean => {
  if (!documentRoot) return false;
  for (const element of documentRoot.querySelectorAll(BLOCKING_MODAL_SELECTOR)) {
    if (isElementVisible(element)) {
      return true;
    }
  }
  return false;
};

const toElementLike = (target: unknown): ElementLike | null => {
  if (!target || typeof target !== 'object') return null;
  const candidate = target as ElementLike;
  if (typeof candidate.closest === 'function') {
    return candidate;
  }
  if (candidate.parentElement && typeof candidate.parentElement.closest === 'function') {
    return candidate.parentElement;
  }
  return null;
};

export const isLocalFileDropTarget = (target: unknown): boolean => {
  const element = toElementLike(target);
  if (!element?.closest) return false;
  return element.closest(LOCAL_FILE_DROP_SELECTOR) !== null;
};

export interface PageFileDropControllerOptions {
  windowTarget: WindowLike;
  documentTarget: DocumentLike;
  isEnabled: () => boolean;
  getAnchorElement: () => ElementLike | null;
  onActiveChange: (active: boolean) => void;
  onDropFiles: (files: File[]) => void;
}

export interface PageFileDropController {
  reset: () => void;
  dispose: () => void;
}

/**
 * Window-scoped file drag-and-drop state machine for Cowork views.
 * Lets users drop files anywhere on the page while yielding cleanly to
 * visible blocking modals and dedicated local drop zones (e.g. Word editor).
 */
export const createPageFileDropController = (
  options: PageFileDropControllerOptions,
): PageFileDropController => {
  const {
    windowTarget,
    documentTarget,
    isEnabled,
    getAnchorElement,
    onActiveChange,
    onDropFiles,
  } = options;

  let dragDepth = 0;
  let active = false;

  const setActive = (next: boolean): void => {
    if (active === next) return;
    active = next;
    onActiveChange(next);
  };

  const reset = (): void => {
    dragDepth = 0;
    setActive(false);
  };

  const canHandleDragEvent = (event: DragEventLike): boolean => {
    if (!isEnabled()) return false;
    if (!hasFileTransfer(event.dataTransfer)) return false;
    if (event.defaultPrevented) return false;
    if (isLocalFileDropTarget(event.target)) return false;
    if (!isElementVisible(getAnchorElement())) return false;
    if (hasVisibleBlockingModal(documentTarget)) return false;
    return true;
  };

  const handleDragEnter = (rawEvent: Event): void => {
    const event = rawEvent as unknown as DragEventLike;
    if (!hasFileTransfer(event.dataTransfer)) return;
    if (!canHandleDragEvent(event)) {
      if (active) reset();
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    setActive(true);
  };

  const handleDragOver = (rawEvent: Event): void => {
    const event = rawEvent as unknown as DragEventLike;
    if (!hasFileTransfer(event.dataTransfer)) return;
    if (!canHandleDragEvent(event)) {
      if (active) reset();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    if (dragDepth === 0) {
      dragDepth = 1;
    }
    setActive(true);
  };

  const handleDragLeave = (rawEvent: Event): void => {
    const event = rawEvent as unknown as DragEventLike;
    if (!active && dragDepth === 0) return;
    if (!hasFileTransfer(event.dataTransfer)) return;
    // Leaving the document viewport (to the OS or an embedded webview/iframe)
    // reports relatedTarget === null; reset immediately so the overlay never sticks.
    if (event.relatedTarget == null) {
      reset();
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      setActive(false);
    }
  };

  const handleDrop = (rawEvent: Event): void => {
    const event = rawEvent as unknown as DragEventLike;
    const wasActive = active || dragDepth > 0;
    if (!hasFileTransfer(event.dataTransfer)) {
      if (wasActive) reset();
      return;
    }
    if (!canHandleDragEvent(event)) {
      if (wasActive) reset();
      return;
    }
    event.preventDefault();
    reset();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) {
      onDropFiles(files);
    }
  };

  const handleDragEnd = (): void => {
    if (active || dragDepth > 0) reset();
  };

  const handleBlur = (): void => {
    if (active || dragDepth > 0) reset();
  };

  const handleVisibilityChange = (): void => {
    if (documentTarget.hidden && (active || dragDepth > 0)) {
      reset();
    }
  };

  // Normal pointer events do not fire during a native OS file drag, so any
  // pointer movement/click or Escape while active guarantees instant recovery
  // if the OS aborts a drag without dispatching a terminal dragleave.
  const handlePointerActivity = (): void => {
    if (active || dragDepth > 0) reset();
  };

  const handleKeyDown = (rawEvent: Event): void => {
    const event = rawEvent as unknown as KeyboardEventLike;
    if (event.key === 'Escape' && (active || dragDepth > 0)) {
      reset();
    }
  };

  windowTarget.addEventListener('dragenter', handleDragEnter);
  windowTarget.addEventListener('dragover', handleDragOver);
  windowTarget.addEventListener('dragleave', handleDragLeave);
  windowTarget.addEventListener('drop', handleDrop);
  windowTarget.addEventListener('dragend', handleDragEnd);
  windowTarget.addEventListener('blur', handleBlur);
  windowTarget.addEventListener('pointermove', handlePointerActivity);
  windowTarget.addEventListener('pointerdown', handlePointerActivity);
  windowTarget.addEventListener('keydown', handleKeyDown);
  documentTarget.addEventListener('visibilitychange', handleVisibilityChange);

  const dispose = (): void => {
    reset();
    windowTarget.removeEventListener('dragenter', handleDragEnter);
    windowTarget.removeEventListener('dragover', handleDragOver);
    windowTarget.removeEventListener('dragleave', handleDragLeave);
    windowTarget.removeEventListener('drop', handleDrop);
    windowTarget.removeEventListener('dragend', handleDragEnd);
    windowTarget.removeEventListener('blur', handleBlur);
    windowTarget.removeEventListener('pointermove', handlePointerActivity);
    windowTarget.removeEventListener('pointerdown', handlePointerActivity);
    windowTarget.removeEventListener('keydown', handleKeyDown);
    documentTarget.removeEventListener('visibilitychange', handleVisibilityChange);
  };

  return { reset, dispose };
};

export interface UsePageFileDropOptions {
  enabled: boolean;
  anchorRef: RefObject<HTMLElement>;
  onDropFiles: (files: File[]) => void;
}

export const usePageFileDrop = ({
  enabled,
  anchorRef,
  onDropFiles,
}: UsePageFileDropOptions): boolean => {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const enabledRef = useRef(enabled);
  const onDropFilesRef = useRef(onDropFiles);
  enabledRef.current = enabled;
  onDropFilesRef.current = onDropFiles;

  useEffect(() => {
    if (!enabled) {
      setIsDraggingFiles(false);
      return;
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const controller = createPageFileDropController({
      windowTarget: window,
      documentTarget: document,
      isEnabled: () => enabledRef.current,
      getAnchorElement: () => anchorRef.current,
      onActiveChange: setIsDraggingFiles,
      onDropFiles: (files) => onDropFilesRef.current(files),
    });
    return () => controller.dispose();
  }, [anchorRef, enabled]);

  return enabled && isDraggingFiles;
};
