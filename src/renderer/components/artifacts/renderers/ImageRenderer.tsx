import { PencilSquareIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';

import {
  type CoworkPrepareImageEditDraftEventDetail,
  CoworkUiEvent,
} from '@/components/cowork/constants';
import {
  computeMediaLabels,
  MediaMentionType,
} from '@/components/cowork/mediaMentionUtils';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';
import {
  setDraftAttachments,
  setDraftPrompt,
  setMediaSelection,
} from '@/store/slices/coworkSlice';
import type { Artifact } from '@/types/artifact';

import type { PreparedImageEdit } from './ImageEditCanvas';
import { offsetImageEditPromptReferences } from './imageEditorModel';

const ImageEditCanvas = React.lazy(() => import('./ImageEditCanvas'));

interface ImageRendererProps {
  artifact: Artifact;
}

const ImageRenderer: React.FC<ImageRendererProps> = ({ artifact }) => {
  const dispatch = useDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setScale(prev => Math.max(0.1, Math.min(5, prev - e.deltaY * 0.001)));
    }
  }, []);

  const resetZoom = useCallback(() => setScale(1), []);

  const handlePrepareEdit = useCallback((edit: PreparedImageEdit) => {
    const coworkState = store.getState().cowork;
    const draftAttachments = coworkState.draftAttachments[artifact.sessionId] || [];
    const mediaSelection = coworkState.mediaSelection[artifact.sessionId];
    const editRunId = globalThis.crypto.randomUUID();
    const attachmentPathPrefix = `inline:image-edit:${artifact.id}:${editRunId}:`;
    const nextAttachments = edit.attachments.map(attachment => ({
      path: `${attachmentPathPrefix}${attachment.kind}`,
      name: attachment.name,
      isImage: true,
      dataUrl: attachment.dataUrl,
    }));
    const existingImageCount = computeMediaLabels(draftAttachments)
      .filter(label => label.mediaType === MediaMentionType.Image)
      .length;
    const prompt = offsetImageEditPromptReferences(edit.prompt, existingImageCount);
    dispatch(setDraftAttachments({
      draftKey: artifact.sessionId,
      attachments: [...draftAttachments, ...nextAttachments],
    }));

    const prepareDraftDetail: CoworkPrepareImageEditDraftEventDetail = {
      draftKey: artifact.sessionId,
      prompt,
      handled: false,
    };
    window.dispatchEvent(new CustomEvent(
      CoworkUiEvent.PrepareImageEditDraft,
      { detail: prepareDraftDetail },
    ));
    if (!prepareDraftDetail.handled) {
      const latestDraftPrompt = store.getState().cowork.draftPrompts[artifact.sessionId] || '';
      const currentPrompt = latestDraftPrompt.trim();
      dispatch(setDraftPrompt({
        sessionId: artifact.sessionId,
        draft: currentPrompt ? `${currentPrompt}\n\n${prompt}` : prompt,
      }));
    }

    if (mediaSelection?.mode !== 'image') {
      const imageModelId = mediaSelection?.imageModelId;
      dispatch(setMediaSelection({
        draftKey: artifact.sessionId,
        selection: {
          mode: 'image',
          ...(imageModelId ? { imageModelId, modelId: imageModelId } : {}),
        },
      }));
    }

    window.dispatchEvent(new CustomEvent('app:showToast', {
      detail: i18nService.t('imageEditorDraftReady'),
    }));
    setEditing(false);
  }, [artifact.id, artifact.sessionId, dispatch]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  if (!artifact.content) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading image...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Failed to load image
      </div>
    );
  }

  if (editing) {
    return (
      <React.Suspense
        fallback={(
          <div className="flex h-full items-center justify-center text-sm text-muted">
            {i18nService.t('imageEditorPreparing')}
          </div>
        )}
      >
        <ImageEditCanvas
          alt={artifact.title}
          sourceName={artifact.fileName || artifact.title}
          src={artifact.content}
          onCancel={() => setEditing(false)}
          onPrepare={handlePrepareEdit}
        />
      </React.Suspense>
    );
  }

  return (
    <div className="relative w-full h-full overflow-auto" ref={containerRef}>
      <div
        className="flex items-center justify-center min-h-full p-4"
        style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}
      >
        <img
          src={artifact.content}
          alt={artifact.title}
          className="max-w-full max-h-full object-contain"
          onError={() => setError(true)}
        />
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="absolute right-3 top-3 inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur transition-colors hover:bg-surface-hover"
        title={i18nService.t('imageEditorOpen')}
      >
        <PencilSquareIcon className="h-4 w-4" />
        {i18nService.t('imageEditorOpen')}
      </button>
      {scale !== 1 && (
        <button
          type="button"
          onClick={resetZoom}
          className="absolute bottom-3 right-3 px-2 py-1 text-xs rounded bg-surface text-secondary hover:bg-surface-hover"
        >
          {Math.round(scale * 100)}%
        </button>
      )}
    </div>
  );
};

export default ImageRenderer;
