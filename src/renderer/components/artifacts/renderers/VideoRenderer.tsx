import { ArtifactPreviewProtocol } from '@shared/artifactPreview/constants';
import React, { useEffect, useMemo, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

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

function buildLocalFileSrc(filePath: string, cacheKey: number): string {
  const normalized = normalizeLocalPath(filePath);
  const pathForUrl = /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')
    ? normalized
    : `/${normalized}`;
  const encoded = pathForUrl.split('/').map(encodeURIComponent).join('/');
  const prefix = /^[A-Za-z]:/.test(pathForUrl)
    ? `${ArtifactPreviewProtocol.LocalFile}:///`
    : `${ArtifactPreviewProtocol.LocalFile}://`;
  return `${prefix}${encoded}?v=${cacheKey}`;
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

function buildVideoSources(
  filePath: string | undefined,
  createdAt: number,
): string[] {
  const sources: string[] = [];
  if (filePath) {
    sources.push(buildLocalFileSrc(filePath, createdAt));
    sources.push(buildFileUrlSrc(filePath));
  }
  return sources;
}

const VideoRenderer: React.FC<VideoRendererProps> = ({ artifact }) => {
  const sources = useMemo(
    () => buildVideoSources(
      artifact.filePath,
      artifact.createdAt,
    ),
    [artifact.createdAt, artifact.filePath],
  );
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const [error, setError] = useState(false);
  const [videoAspectRatio, setVideoAspectRatio] = useState<string | undefined>();
  const src = sources[activeSourceIndex] || '';

  useEffect(() => {
    setActiveSourceIndex(0);
    setError(false);
    setVideoAspectRatio(undefined);
  }, [sources]);

  if (!src) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {t('artifactVideoLoading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {t('artifactVideoError')}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center w-full h-full overflow-hidden p-4">
      <video
        key={src}
        src={src}
        controls
        playsInline
        preload="metadata"
        className="block max-w-full max-h-full rounded bg-black object-contain"
        style={videoAspectRatio ? { aspectRatio: videoAspectRatio } : undefined}
        onLoadedMetadata={(event) => {
          const { videoHeight, videoWidth } = event.currentTarget;
          if (videoWidth > 0 && videoHeight > 0) {
            setVideoAspectRatio(`${videoWidth} / ${videoHeight}`);
          }
        }}
        onError={() => {
          if (activeSourceIndex < sources.length - 1) {
            setActiveSourceIndex(index => index + 1);
            return;
          }
          setError(true);
        }}
      />
    </div>
  );
};

export default VideoRenderer;
