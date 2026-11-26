import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import {
  clampVideoAspectRatio,
  formatVideoMetaLabel,
  INLINE_VIDEO_DEFAULT_ASPECT_RATIO,
} from '../artifacts/inlineVideoLayout';
import VideoPlayer, {
  VideoPlayerFullscreenMode,
  type VideoPlayerHandle,
} from '../artifacts/VideoPlayer';
import {
  createModalEscapeLayerId,
  isDismissEscapeEvent,
  isTopModalEscapeLayer,
  registerModalEscapeLayer,
  unregisterModalEscapeLayer,
} from '../common/modalEscape';

export interface VideoPreviewSource {
  sources: readonly string[];
  name: string;
  metaLabel?: string | null;
  aspectRatio?: number;
  initialTime?: number;
  autoPlay?: boolean;
}

interface VideoPreviewModalProps {
  video: VideoPreviewSource | null;
  onClose: (lastTime?: number) => void;
}

const VideoPreviewModal: React.FC<VideoPreviewModalProps> = ({ video, onClose }) => {
  const mouseDownOnBackdropRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const layerIdRef = useRef<number | null>(null);
  const [resolvedAspectRatio, setResolvedAspectRatio] = useState<number | null>(null);
  const [resolvedMetaLabel, setResolvedMetaLabel] = useState<string | null>(null);

  const isOpen = video !== null;
  if (isOpen && layerIdRef.current === null) {
    layerIdRef.current = createModalEscapeLayerId();
  } else if (!isOpen) {
    layerIdRef.current = null;
  }
  const layerId = layerIdRef.current;

  const sourcesKey = video?.sources.join('\n') ?? '';

  useEffect(() => {
    setResolvedAspectRatio(video?.aspectRatio ?? null);
    setResolvedMetaLabel(video?.metaLabel ?? null);
  }, [sourcesKey, video?.aspectRatio, video?.metaLabel]);

  const handleClose = useCallback(() => {
    const currentTime = playerRef.current?.getCurrentTime();
    onClose(typeof currentTime === 'number' && Number.isFinite(currentTime) ? currentTime : undefined);
  }, [onClose]);

  useEffect(() => {
    if (layerId === null) return;
    registerModalEscapeLayer(layerId);
    return () => {
      unregisterModalEscapeLayer(layerId);
    };
  }, [layerId]);

  useEffect(() => {
    if (layerId === null) return;
    const handler = (event: KeyboardEvent) => {
      if (!isTopModalEscapeLayer(layerId)) return;
      if (isDismissEscapeEvent(event)) {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key === ' ') {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
        event.preventDefault();
        playerRef.current?.togglePlay();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [handleClose, layerId]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  if (!video) return null;

  const label = video.name.trim() || i18nService.t('artifactFileKindVideo');
  const displayMeta = resolvedMetaLabel || video.metaLabel;
  const aspectRatio = clampVideoAspectRatio(
    resolvedAspectRatio ?? video.aspectRatio ?? INLINE_VIDEO_DEFAULT_ASPECT_RATIO,
  );

  const handleBackdropMouseDown: React.MouseEventHandler<HTMLDivElement> = (event) => {
    event.stopPropagation();
    mouseDownOnBackdropRef.current = event.target === event.currentTarget;
  };

  const handleBackdropClick: React.MouseEventHandler<HTMLDivElement> = (event) => {
    event.stopPropagation();
    if (event.target === event.currentTarget && mouseDownOnBackdropRef.current) {
      mouseDownOnBackdropRef.current = false;
      handleClose();
    }
  };

  const modal = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[10000] flex flex-col bg-neutral-950/80 backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        event.stopPropagation();
      }}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-end p-4">
        <button
          ref={closeButtonRef}
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            handleClose();
          }}
          className="pointer-events-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
          title={i18nService.t('close')}
          aria-label={i18nService.t('close')}
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 items-center justify-center px-6 py-14"
        onMouseDown={handleBackdropMouseDown}
        onClick={handleBackdropClick}
      >
        <div
          className="flex max-h-full max-w-full flex-col items-center gap-3"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex max-w-[min(90vw,760px)] items-center gap-2 rounded-full bg-black/45 px-3.5 py-1 text-center text-xs font-medium text-white/90 ring-1 ring-white/10">
            <span className="truncate">{label}</span>
            {displayMeta && (
              <span className="shrink-0 tabular-nums text-white/60">{displayMeta}</span>
            )}
          </div>

          <div
            className="overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/15"
            style={{
              aspectRatio: String(aspectRatio),
              width: `min(calc(100vw - 4rem), calc((100vh - 9.5rem) * ${aspectRatio}))`,
            }}
          >
            <VideoPlayer
              ref={playerRef}
              sources={video.sources}
              title={label}
              initialTime={video.initialTime}
              autoPlay={video.autoPlay ?? true}
              posterMode={false}
              fullscreenMode={VideoPlayerFullscreenMode.Exit}
              className="h-full w-full"
              onToggleFullscreen={(time) => onClose(time)}
              onMetadataLoaded={(meta) => {
                if (meta.width > 0 && meta.height > 0) {
                  setResolvedAspectRatio(meta.width / meta.height);
                }
                const nextMeta = formatVideoMetaLabel(meta);
                if (nextMeta) setResolvedMetaLabel(nextMeta);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modal;
  }

  return createPortal(modal, document.body);
};

export default VideoPreviewModal;
