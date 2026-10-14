import {
  captureImageMutationPreconditions, computeImageResizeResult, cssPixelsToLayoutPoints, type DrawingPositionInput,
  finalizeImageOverlayInteraction, type ImageInteractionSession, type ImageResizeHandle, isStaleImageInteractionCommit,
  overlayFrameToSheetCssPixels, overlayHostOrigin, resizePreservesAspect, type SelectedDrawingOverlayTarget,
  selectedDrawingOverlayTargetOf,
} from '@docx-editor.dev/core/editor';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/office/word/wordEditorSession';

const t = (key: string) => i18nService.t(key);
/** Word's eight handles, with where each sits on the frame as fractions of its width and height. */
const HANDLES: readonly { handle: ImageResizeHandle; at: [number, number]; cursor: string }[] = [
  { handle: 'nw', at: [0, 0], cursor: 'nwse-resize' },
  { handle: 'n', at: [0.5, 0], cursor: 'ns-resize' },
  { handle: 'ne', at: [1, 0], cursor: 'nesw-resize' },
  { handle: 'e', at: [1, 0.5], cursor: 'ew-resize' },
  { handle: 'se', at: [1, 1], cursor: 'nwse-resize' },
  { handle: 's', at: [0.5, 1], cursor: 'ns-resize' },
  { handle: 'sw', at: [0, 1], cursor: 'nesw-resize' },
  { handle: 'w', at: [0, 0.5], cursor: 'ew-resize' },
];

interface ResizeDrag {
  session: ImageInteractionSession;
  pointer: { x: number; y: number };
  /** The frame as it follows the pointer; the document changes once, on release. */
  bounds: SelectedDrawingOverlayTarget;
}

/** A floating picture keeps its opposite edge in place, so a resize can move its anchor offsets too. */
function positionFields(position: DrawingPositionInput | null): { horizontalEmu?: number; verticalEmu?: number } {
  if (!position) return {};
  return {
    ...(position.horizontalEmu !== undefined ? { horizontalEmu: position.horizontalEmu } : {}),
    ...(position.verticalEmu !== undefined ? { verticalEmu: position.verticalEmu } : {}),
  };
}

/**
 * The selected picture's frame and resize handles, drawn over the pages inside `mount`, the
 * scrolled element that holds the editor. Delete and Backspace remove the selected picture.
 */
export function WordImageOverlay({ session, mount }: { session: WordEditorSession; mount: React.RefObject<HTMLElement> }): React.ReactPortal | null {
  const snapshot = useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const [drag, setDrag] = useState<ResizeDrag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [, setLayoutTick] = useState(0);
  const dragging = drag !== null;

  // Fitting the pages to a resized panel moves them without an editor event.
  useEffect(() => {
    const observer = new ResizeObserver(() => setLayoutTick(tick => tick + 1));
    observer.observe(session.host);
    if (mount.current) observer.observe(mount.current);
    return () => observer.disconnect();
  }, [session, mount]);

  // The engine's caret sits beside a selected picture, so it would delete a character instead.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== 'Delete' && event.key !== 'Backspace') || event.isComposing
        || event.metaKey || event.ctrlKey || event.altKey) return;
      const editor = session.editor;
      if (!editor?.snapshot().editable || !selectedDrawingOverlayTargetOf(editor.surface)) return;
      event.preventDefault();
      event.stopPropagation();
      editor.exec({ type: 'deleteImage' });
    };
    session.host.addEventListener('keydown', onKeyDown, true);
    return () => session.host.removeEventListener('keydown', onKeyDown, true);
  }, [session]);

  useEffect(() => {
    const editor = session.editor;
    if (!dragging || !editor?.surface) return undefined;
    const { paintScale } = editor.surface.overlayCoordinates();
    const delta = (event: PointerEvent, from: ResizeDrag['pointer']) => ({
      x: cssPixelsToLayoutPoints(event.clientX - from.x, paintScale),
      y: cssPixelsToLayoutPoints(event.clientY - from.y, paintScale),
    });
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      const handle = current?.session.handle;
      if (!current || !handle) return;
      const { x, y } = delta(event, current.pointer);
      const { session: start } = current;
      const resized = computeImageResizeResult({
        handle, startWidthEmu: start.startWidthEmu, startHeightEmu: start.startHeightEmu, startBounds: start.startBounds,
        startPosition: start.startPosition, anchorFrameOrigin: start.anchorFrameOrigin, deltaXPt: x, deltaYPt: y,
        transform: start.transform, preserveAspect: resizePreservesAspect(handle, current.bounds.aspectLocked, event.shiftKey), kind: start.kind,
      });
      setDrag({ ...current, bounds: { ...current.bounds, ...resized.previewBounds, widthEmu: resized.widthEmu, heightEmu: resized.heightEmu } });
    };
    const onEnd = (event: PointerEvent) => {
      const current = dragRef.current;
      setDrag(null);
      if (!current || event.type !== 'pointerup') return;
      const { x, y } = delta(event, current.pointer);
      const result = finalizeImageOverlayInteraction({
        session: current.session, deltaXPt: x, deltaYPt: y, accumulatedScrollPt: 0, aspectLocked: current.bounds.aspectLocked,
        shiftKey: event.shiftKey, anchorFrameOrigin: current.session.anchorFrameOrigin,
      });
      // The document may have changed under a long drag; its coordinates would no longer apply.
      if (isStaleImageInteractionCommit(editor, current.session)) return;
      if (result.widthEmu === current.session.startWidthEmu && result.heightEmu === current.session.startHeightEmu) return;
      editor.exec({ type: 'setImageProperties', widthEmu: result.widthEmu, heightEmu: result.heightEmu, ...positionFields(result.position) });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dragging, session]);

  const editor = session.editor;
  const surface = editor?.surface;
  const container = mount.current;
  const target = drag?.bounds ?? (snapshot?.editable && surface ? selectedDrawingOverlayTargetOf(surface) : null);
  if (!surface || !container || !target || !session.mounted) return null;

  const begin = (event: React.PointerEvent, handle: ImageResizeHandle) => {
    if (event.button !== 0 || !editor) return;
    event.preventDefault();
    event.stopPropagation();
    // Lay out pending input first, so the drag is checked against the layout it starts from.
    const layout = surface.layout();
    const preconditions = captureImageMutationPreconditions(editor);
    if (!preconditions) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointer: { x: event.clientX, y: event.clientY },
      bounds: target,
      session: {
        drawingNodeId: target.id, mode: 'resize', handle, kind: target.kind, preconditions,
        startBounds: { x: target.x, y: target.y, width: target.width, height: target.height },
        startWidthEmu: target.widthEmu, startHeightEmu: target.heightEmu, startPosition: target.position,
        anchorFrameOrigin: target.anchorFrameOrigin, transform: target.transform,
        layoutRevision: layout.revision, packageRevision: surface.session.packageRevision(),
      },
    });
  };

  const sheet = overlayFrameToSheetCssPixels(surface.publishedLayout(), {
    pageIndex: target.pageIndex, x: target.x, y: target.y, width: target.width, height: target.height,
  }, surface.overlayCoordinates());
  // Pages paint inside the editor's host, which the mount centres with a margin.
  const origin = overlayHostOrigin(session.host);
  const rect = { left: sheet.left + origin.left, top: sheet.top + origin.top, width: sheet.width, height: sheet.height };
  return createPortal(
    <div className="lobster-word-image-overlay" role="group" aria-label={t('wordImageSelected')}>
      <div className="lobster-word-image-frame" style={rect} />
      {target.canResize && HANDLES.map(({ handle, at: [x, y], cursor }) => (
        <span key={handle} className="lobster-word-image-handle" title={t('wordImageResize')}
          style={{ left: rect.left + rect.width * x, top: rect.top + rect.height * y, cursor }}
          onMouseDown={event => event.preventDefault()} onPointerDown={event => begin(event, handle)} />
      ))}
    </div>,
    container,
  );
}
