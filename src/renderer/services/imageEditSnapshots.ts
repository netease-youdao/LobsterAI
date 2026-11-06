import { useEffect, useState } from 'react';

import type { ImageEditMessageSnapshot, ImageEditSnapshotFile } from '../../shared/imageEditing/types';
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

interface SnapshotImageUrls { src: string; maskSrc?: string; markupSrc?: string }

export function useImageEditSnapshotImage(snapshot: ImageEditMessageSnapshot, fallback: string | undefined, preview: boolean) {
  const key = `${snapshot.source.sessionId}:${snapshot.requestId}:${preview}`;
  const [loaded, setLoaded] = useState<{ key: string; images?: SnapshotImageUrls; failed: boolean }>();
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    // Object URLs keep multi-MB images out of props and DOM attributes, so switching views stays cheap.
    const objectUrl = (file: ImageEditSnapshotFile) => {
      const url = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }));
      urls.push(url);
      return url;
    };
    void window.electron.artifact.imageEditing.readSnapshot({
      sessionId: snapshot.source.sessionId, requestId: snapshot.requestId, preview,
    }).then(result => {
      if (cancelled) return;
      setLoaded({ key, failed: !result.success, images: result.success ? {
        src: objectUrl(result.data.image),
        maskSrc: result.data.mask && objectUrl(result.data.mask),
        markupSrc: result.data.markup && objectUrl(result.data.markup),
      } : undefined });
    }).catch(() => {
      if (!cancelled) setLoaded({ key, failed: true });
    });
    return () => {
      cancelled = true;
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [key, snapshot.source.sessionId, snapshot.requestId, preview]);
  return {
    src: loaded?.key === key ? loaded.images?.src ?? fallback : fallback,
    maskSrc: loaded?.key === key ? loaded.images?.maskSrc : undefined,
    markupSrc: loaded?.key === key ? loaded.images?.markupSrc : undefined,
    loading: loaded?.key !== key,
    failed: loaded?.key === key && loaded.failed,
  };
}
