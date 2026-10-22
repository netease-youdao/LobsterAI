import { useEffect, useState } from 'react';

import type { ImageEditMessageSnapshot, ImageEditSnapshotImages } from '../../shared/imageEditing/types';
import type { CoworkMessage } from '../types/cowork';

/** Backfill only from the exact staged attachment; ordinary images remain ordinary attachments. */
export function useImageEditSnapshots(message: CoworkMessage, sessionId?: string): ImageEditMessageSnapshot[] {
  const saved = message.metadata?.imageEdits;
  const hasPreviews = Boolean(message.metadata?.imageAttachmentPreviews?.length);
  const key = `${sessionId}:${message.id}`;
  const [recovered, setRecovered] = useState<{ key: string; snapshots: ImageEditMessageSnapshot[] }>();
  useEffect(() => {
    if (saved || !hasPreviews || !sessionId) return;
    let cancelled = false;
    void window.electron.artifact.imageEditing.history({ sessionId, messageId: message.id }).then(result => {
      if (!cancelled && result.success) setRecovered({ key, snapshots: result.data });
    }).catch(() => { /* Keep the original attachment when history is unavailable. */ });
    return () => { cancelled = true; };
  }, [key, saved, hasPreviews, sessionId, message.id]);
  return saved ?? (recovered?.key === key ? recovered.snapshots : []);
}

export function useImageEditSnapshotImage(snapshot: ImageEditMessageSnapshot, fallback: string | undefined, preview: boolean) {
  const key = `${snapshot.source.sessionId}:${snapshot.requestId}:${preview}`;
  const [loaded, setLoaded] = useState<{ key: string; images?: ImageEditSnapshotImages; failed: boolean }>();
  useEffect(() => {
    let cancelled = false;
    void window.electron.artifact.imageEditing.readSnapshot({
      sessionId: snapshot.source.sessionId, requestId: snapshot.requestId, preview,
    }).then(result => {
      if (!cancelled) setLoaded({ key, images: result.success ? result.data : undefined, failed: !result.success });
    }).catch(() => {
      if (!cancelled) setLoaded({ key, failed: true });
    });
    return () => { cancelled = true; };
  }, [key, snapshot.source.sessionId, snapshot.requestId, preview]);
  return {
    src: loaded?.key === key ? loaded.images?.dataUrl ?? fallback : fallback,
    maskSrc: loaded?.key === key ? loaded.images?.maskDataUrl : undefined,
    markupSrc: loaded?.key === key ? loaded.images?.markupDataUrl : undefined,
    loading: loaded?.key !== key,
    failed: loaded?.key === key && loaded.failed,
  };
}
