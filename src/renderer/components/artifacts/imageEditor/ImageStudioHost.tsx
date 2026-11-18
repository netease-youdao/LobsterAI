import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../../services/i18n';
import type { RootState } from '../../../store';
import { closeImageStudio } from '../../../store/slices/imageEditorSlice';
import ImageEditor, { ImageEditorSurface } from './ImageEditor';
import { registerImageStudioHost } from './imageStudioAvailability';

/** Full-screen image viewer and editor for the session page; images in the conversation open here. */
export default function ImageStudioHost({ sessionId }: { sessionId: string }) {
  const dispatch = useDispatch();
  const studio = useSelector((state: RootState) => state.imageEditor.studio);
  const container = useRef<HTMLDivElement>(null);
  const open = Boolean(studio);

  useEffect(() => registerImageStudioHost(), []);
  // The studio belongs to the session it was opened from.
  useEffect(() => () => { dispatch(closeImageStudio()); }, [dispatch, sessionId]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    container.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);

  if (!studio) return null;
  return createPortal(
    <div ref={container} tabIndex={-1} role="dialog" aria-modal="true" aria-label={studio.artifact.title || i18nService.t('imageEditTitle')}
      className="fixed inset-0 z-50 animate-fade-in bg-background outline-none">
      <ImageEditor key={studio.artifact.id} artifact={studio.artifact} surface={ImageEditorSurface.Studio}
        initialOperation={studio.operation} initialVersionId={studio.versionId} onClose={() => dispatch(closeImageStudio())} />
    </div>,
    document.body,
  );
}
