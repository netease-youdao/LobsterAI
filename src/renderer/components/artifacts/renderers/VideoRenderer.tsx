import { ArtifactPreviewHost, ArtifactPreviewProtocol } from '@shared/artifactPreview/constants';
import {
  LOCAL_FILE_THUMBNAIL_FIT_PARAM,
  LOCAL_FILE_THUMBNAIL_PARAM,
  LocalFileThumbnailFit,
} from '@shared/artifactPreview/localFileThumbnail';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import VideoPreviewModal, { type VideoPreviewSource } from '@/components/cowork/VideoPreviewModal';
import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import { clampVideoAspectRatio, formatVideoMetaLabel } from '../inlineVideoLayout';
import VideoPlayer, {
  VideoPlayerFullscreenMode,
  type VideoPlayerHandle,
} from '../VideoPlayer';

interface VideoRendererProps {
  artifact: Artifact;
}

const t = (key: string) => i18nService.t(key);

function normalizeLocalPath(filePath: string): string {
  let normalized = filePath.trim();
  const mediaMatch = normalized.match(/(?:^|\/)MEDIA:\s*(.+)$/i);
  if (mediaMatch) {
    normalized = mediaMatch[1].trim();
  } else {
    normalized = normalized.replace(/^MEDIA:\s*/i, '').trim();
  }
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file:/')) {
    normalized = normalized.slice(5);
  }
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original path when it contains a literal percent sign.
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\\/g, '/');
}

/**
 * `thumbnail` asks for a copy downscaled to `edge` pixels on the side its `fit` names; the protocol
 * serves the original when it is no larger.
 */
export function buildLocalFileSrc(
  filePath: string,
  cacheKey: number,
  thumbnail?: { edge: number; fit: LocalFileThumbnailFit },
): string {
  const normalized = normalizeLocalPath(filePath);
  const pathForUrl = normalized.startsWith('/')
    ? normalized
    : `/${normalized}`;
  const encoded = pathForUrl.split('/').map(encodeURIComponent).join('/');
  // Standard custom schemes need an authority; an empty host is rejected by Chromium media loading.
  const thumbnailQuery = !thumbnail ? ''
    : `&${LOCAL_FILE_THUMBNAIL_PARAM}=${thumbnail.edge}${thumbnail.fit === LocalFileThumbnailFit.Cover
      ? `&${LOCAL_FILE_THUMBNAIL_FIT_PARAM}=${thumbnail.fit}` : ''}`;
  return `${ArtifactPreviewProtocol.LocalFile}://${ArtifactPreviewHost.LocalFile}${encoded}?v=${cacheKey}${thumbnailQuery}`;
}

function buildFileUrlSrc(filePath: string): string {
  const normalized = normalizeLocalPath(filePath);
  const pathForUrl = /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')
    ? normalized
    : `/${normalized}`;
  const encoded = pathForUrl.split('/').map(encodeURIComponent).join('/');
  return /^[A-Za-z]:/.test(pathForUrl)
    ? `file:///${encoded}`
    : `file://${encoded}`;
}

export function buildVideoSources(
  filePath: string | undefined,
  remoteUrl: string | undefined,
  content: string,
  createdAt: number,
): string[] {
  const sources: string[] = [];
  if (filePath) {
    sources.push(buildLocalFileSrc(filePath, createdAt));
    sources.push(buildFileUrlSrc(filePath));
  }
  for (const candidate of [remoteUrl, content]) {
    const value = candidate?.trim();
    if (value && /^https:\/\//i.test(value) && !sources.includes(value)) {
      sources.push(value);
    }
  }
  return sources;
}

const VideoRenderer: React.FC<VideoRendererProps> = ({ artifact }) => {
  const sources = useMemo(
    () => buildVideoSources(
      artifact.filePath,
      artifact.remoteUrl,
      artifact.content,
      artifact.createdAt,
    ),
    [artifact.content, artifact.createdAt, artifact.filePath, artifact.remoteUrl],
  );
  const playerRef = useRef<VideoPlayerHandle>(null);
  const [aspectRatio, setAspectRatio] = useState<number | undefined>();
  const [metaLabel, setMetaLabel] = useState<string | null>(null);
  const [fullscreenVideo, setFullscreenVideo] = useState<VideoPreviewSource | null>(null);

  useEffect(() => {
    setAspectRatio(undefined);
    setMetaLabel(null);
  }, [sources]);

  if (sources.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {t('artifactVideoLoading')}
      </div>
    );
  }

  const title = artifact.fileName || artifact.title || t('artifactFileKindVideo');
  const clampedRatio = aspectRatio ? clampVideoAspectRatio(aspectRatio) : undefined;

  return (
    <div className="flex items-center justify-center w-full h-full overflow-hidden p-4">
      <VideoPlayer
        ref={playerRef}
        sources={sources}
        title={title}
        posterMode={false}
        fullscreenMode={VideoPlayerFullscreenMode.Enter}
        className="max-h-full max-w-full rounded-xl bg-black"
        style={clampedRatio && clampedRatio < 1
          ? { aspectRatio: String(clampedRatio), height: '100%', maxWidth: '100%' }
          : { aspectRatio: String(clampedRatio ?? 16 / 9), width: '100%', maxHeight: '100%' }}
        onToggleFullscreen={(currentTime) => {
          setFullscreenVideo({
            sources,
            name: title,
            metaLabel,
            aspectRatio: clampedRatio,
            initialTime: currentTime,
            autoPlay: true,
          });
        }}
        onMetadataLoaded={(meta) => {
          if (meta.width > 0 && meta.height > 0) {
            setAspectRatio(meta.width / meta.height);
          }
          setMetaLabel(formatVideoMetaLabel(meta));
        }}
        onSourceError={(info) => {
          window.electron?.log?.fromRenderer?.('warn', 'ArtifactPreview', `Video source failed: ${JSON.stringify(info)}`);
        }}
      />
      <VideoPreviewModal
        video={fullscreenVideo}
        onClose={(lastTime) => {
          if (typeof lastTime === 'number' && lastTime > 0) {
            playerRef.current?.seekTo(lastTime, true);
          }
          setFullscreenVideo(null);
        }}
      />
    </div>
  );
};

export default VideoRenderer;
