import {
  ArrowUpTrayIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { openImageInStudio } from '@/services/imageEditing';
import { normalizeShellFilePath, prefetchAppsForFile } from '@/services/shellAppsCache';
import type { Artifact } from '@/types/artifact';
import { revealLocalPathWithToast } from '@/utils/localFileActions';

import { LocalFileThumbnailFit } from '../../../shared/artifactPreview/localFileThumbnail';
import { ImageEditOperation } from '../../../shared/imageEditing/types';
import ImagePreviewModal, { type ImagePreviewSource } from '../cowork/ImagePreviewModal';
import VideoPreviewModal, { type VideoPreviewSource } from '../cowork/VideoPreviewModal';
import {
  ArtifactPreviewActionSource,
  ArtifactPublishEntryPoint,
  reportArtifactPreviewAction,
} from './artifactAnalytics';
import { useOptionalArtifactFileShare } from './ArtifactFileShareController';
import { isArtifactFileShareable } from './artifactFileSharePolicy';
import { ArtifactOpenDropdown } from './ArtifactPreviewCard';
import { PaletteBrushIcon } from './imageEditor/ImageEditingIcons';
import { isImageStudioAvailable } from './imageEditor/imageStudioAvailability';
import {
  computeSingleVideoBox,
  formatVideoMetaLabel,
  getCachedVideoMetadata,
  getVideoDisplayName,
  getVideoFileExtension,
  INLINE_VIDEO_MAX_WIDTH,
  MAX_COLLAPSED_VIDEO_TILES,
  rememberVideoMetadata,
  VideoCardVariant,
  type VideoMediaMetadata,
} from './inlineVideoLayout';
import { getImageArtifactDisplaySrc, getImageArtifactSrc } from './renderers/imageArtifactSource';
import { buildVideoSources } from './renderers/VideoRenderer';
import VideoPlayer, {
  VideoPlayerFullscreenMode,
  type VideoPlayerHandle,
} from './VideoPlayer';

const t = (key: string) => i18nService.t(key);

const PROCESS_IMAGE_THUMBNAIL_EDGE = 480;

function formatProcessAssetsLabel(clipCount: number, imageCount: number): string {
  const parts: string[] = [];
  if (clipCount > 0) {
    parts.push(
      clipCount === 1
        ? t('artifactVideoProcessClipOne')
        : t('artifactVideoProcessClipMany').replace('{count}', String(clipCount)),
    );
  }
  if (imageCount > 0) {
    parts.push(
      imageCount === 1
        ? t('artifactVideoProcessImageOne')
        : t('artifactVideoProcessImageMany').replace('{count}', String(imageCount)),
    );
  }
  return t('artifactVideoProcessAssets').replace(
    '{summary}',
    parts.join(t('artifactVideoProcessListSeparator')),
  );
}

interface ActionIconButtonProps {
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: () => void;
  onFocus?: () => void;
  buttonRef?: React.RefObject<HTMLButtonElement>;
  compact?: boolean;
  children: React.ReactNode;
}

const ActionIconButton: React.FC<ActionIconButtonProps> = ({
  label,
  onClick,
  onMouseEnter,
  onFocus,
  buttonRef,
  compact = false,
  children,
}) => (
  <button
    ref={buttonRef}
    type="button"
    title={label}
    aria-label={label}
    onClick={onClick}
    onMouseEnter={onMouseEnter}
    onFocus={onFocus}
    className={`inline-flex ${compact ? 'h-6 w-6' : 'h-7 w-7'} shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
  >
    {children}
  </button>
);

interface InlineVideoCardProps {
  artifact: Artifact;
  variant: VideoCardVariant;
  showFinalBadge?: boolean;
  canShare: boolean;
  onShare: () => void;
  onOpenFullscreen: (source: VideoPreviewSource, onReturnTime: (time: number) => void) => void;
}

const InlineVideoCard: React.FC<InlineVideoCardProps> = ({
  artifact,
  variant,
  showFinalBadge = false,
  canShare,
  onShare,
  onOpenFullscreen,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const openMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const isHero = variant === VideoCardVariant.Hero;

  const sources = useMemo(
    () => buildVideoSources(artifact.filePath, artifact.remoteUrl, artifact.content, artifact.createdAt),
    [artifact.content, artifact.createdAt, artifact.filePath, artifact.remoteUrl],
  );
  const metadataCacheKey = sources[0] ?? artifact.id;

  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined');
  const [metadata, setMetadata] = useState<VideoMediaMetadata | null>(() => getCachedVideoMetadata(metadataCacheKey));
  const [openMenuOpen, setOpenMenuOpen] = useState(false);

  const displayName = getVideoDisplayName(artifact, t('artifactFileKindVideo'));
  const extension = getVideoFileExtension(artifact);
  const metaLabel = formatVideoMetaLabel(metadata);
  const footerMeta = isHero
    ? [extension, metaLabel].filter(Boolean).join(' · ')
    : (metaLabel || extension);
  const singleBox = useMemo(
    () => computeSingleVideoBox(metadata?.width, metadata?.height),
    [metadata?.height, metadata?.width],
  );

  useEffect(() => {
    setMetadata(getCachedVideoMetadata(metadataCacheKey));
  }, [metadataCacheKey]);

  // Lazy-load media near the viewport and pause playback if the card scrolls away.
  useEffect(() => {
    const element = cardRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return undefined;
    }

    const nearObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some(entry => entry.isIntersecting)) {
          setNearViewport(true);
          nearObserver.disconnect();
        }
      },
      { rootMargin: '360px 0px' },
    );

    const visibleObserver = new IntersectionObserver(
      (entries) => {
        const isVisible = entries.some(entry => entry.isIntersecting);
        if (!isVisible) {
          playerRef.current?.pause();
        }
      },
      { threshold: 0.1 },
    );

    nearObserver.observe(element);
    visibleObserver.observe(element);
    return () => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
    };
  }, []);

  const handleOpenFullscreen = useCallback((currentTime: number) => {
    reportArtifactPreviewAction({
      actionType: 'card_open',
      source: ArtifactPreviewActionSource.ConversationArtifactCard,
      artifact,
      params: {
        openTarget: 'video_modal',
      },
    });
    const aspectRatio = metadata && metadata.width > 0 && metadata.height > 0
      ? metadata.width / metadata.height
      : undefined;
    onOpenFullscreen(
      {
        sources,
        name: displayName,
        metaLabel,
        aspectRatio,
        initialTime: currentTime,
        autoPlay: true,
      },
      (returnTime) => {
        if (returnTime > 0) {
          playerRef.current?.seekTo(returnTime, true);
        }
      },
    );
  }, [artifact, displayName, metaLabel, metadata, onOpenFullscreen, sources]);

  const handleRevealInFolder = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!artifact.filePath) return;
    void revealLocalPathWithToast(normalizeShellFilePath(artifact.filePath));
    reportArtifactPreviewAction({
      actionType: 'reveal_in_folder',
      source: ArtifactPreviewActionSource.ConversationArtifactCard,
      artifact,
      params: {
        openTarget: 'folder',
      },
    });
  }, [artifact]);

  const handlePrefetchApps = useCallback(() => {
    if (artifact.filePath) {
      void prefetchAppsForFile(artifact.filePath);
    }
  }, [artifact.filePath]);

  const handleToggleOpenMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setOpenMenuOpen(prev => {
      const next = !prev;
      reportArtifactPreviewAction({
        actionType: 'open_menu_toggle',
        source: ArtifactPreviewActionSource.ConversationArtifactCard,
        artifact,
        params: {
          targetOpen: next,
        },
      });
      return next;
    });
  }, [artifact]);

  const handleShareClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onShare();
  }, [onShare]);

  const iconSizeClass = isHero ? 'h-4 w-4' : 'h-3.5 w-3.5';

  return (
    <div
      ref={cardRef}
      data-inline-video-id={artifact.id}
      className="artifact-preview-card-group overflow-hidden rounded-2xl border border-border transition-colors"
      style={isHero ? { width: `min(100%, ${singleBox.width}px)` } : undefined}
    >
      <VideoPlayer
        ref={playerRef}
        sources={sources}
        title={displayName}
        compact={!isHero}
        posterMode
        nearViewport={nearViewport}
        coverUntilPlay={!isHero}
        metaBadge={metaLabel}
        fullscreenMode={VideoPlayerFullscreenMode.Enter}
        className={isHero ? 'w-full' : 'aspect-video w-full'}
        style={isHero ? { aspectRatio: String(singleBox.aspectRatio) } : undefined}
        onToggleFullscreen={handleOpenFullscreen}
        onMetadataLoaded={(nextMeta) => {
          setMetadata(nextMeta);
          rememberVideoMetadata(metadataCacheKey, nextMeta);
        }}
        onSourceError={(info) => {
          window.electron?.log?.fromRenderer?.('warn', 'InlineVideoGallery', `Video source failed: ${JSON.stringify(info)}`);
        }}
      />

      <div className={`flex items-center border-t border-border ${isHero ? 'gap-2 px-3 py-2' : 'gap-1.5 px-2.5 py-2'}`}>
        <div className="min-w-0 flex-1" title={displayName}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate font-medium text-foreground ${isHero ? 'text-[13px] leading-5' : 'text-xs leading-4'}`}>
              {displayName}
            </span>
            {showFinalBadge && (
              <span className="shrink-0 rounded-md bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium leading-3 text-primary">
                {t('artifactVideoFinalBadge')}
              </span>
            )}
          </div>
          {footerMeta && (
            <div className="mt-0.5 truncate text-[11px] leading-4 tabular-nums text-secondary">
              {footerMeta}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {canShare && (
            <ActionIconButton
              label={t('htmlShare')}
              onClick={handleShareClick}
              compact={!isHero}
            >
              <ArrowUpTrayIcon className={iconSizeClass} />
            </ActionIconButton>
          )}
          {isHero && artifact.filePath && (
            <ActionIconButton
              label={t('showInFolder')}
              onClick={handleRevealInFolder}
            >
              <FolderIcon className={iconSizeClass} />
            </ActionIconButton>
          )}
          {artifact.filePath && (
            <ActionIconButton
              buttonRef={openMenuAnchorRef}
              label={t('artifactPreviewCardOpenWith')}
              onClick={handleToggleOpenMenu}
              onMouseEnter={handlePrefetchApps}
              onFocus={handlePrefetchApps}
              compact={!isHero}
            >
              <EllipsisHorizontalIcon className={iconSizeClass} />
            </ActionIconButton>
          )}
        </div>

        {openMenuOpen && artifact.filePath && (
          <ArtifactOpenDropdown
            anchorRef={openMenuAnchorRef as React.RefObject<HTMLElement>}
            artifact={artifact}
            filePath={artifact.filePath}
            onClose={() => setOpenMenuOpen(false)}
          />
        )}
      </div>
    </div>
  );
};

interface ProcessImageCardProps {
  artifact: Artifact;
  editable: boolean;
  canShare: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onShare: () => void;
}

const ProcessImageCard: React.FC<ProcessImageCardProps> = ({
  artifact,
  editable,
  canShare,
  onOpen,
  onEdit,
  onShare,
}) => {
  const openMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);

  const displayName = getVideoDisplayName(artifact, t('artifactImageAlt'));
  const extension = getVideoFileExtension(artifact);
  const subtitle = [t('artifactVideoReferenceImageBadge'), extension].filter(Boolean).join(' · ');
  const thumbSrc = getImageArtifactDisplaySrc(artifact, PROCESS_IMAGE_THUMBNAIL_EDGE, LocalFileThumbnailFit.Cover);

  const handlePrefetchApps = useCallback(() => {
    if (artifact.filePath) {
      void prefetchAppsForFile(artifact.filePath);
    }
  }, [artifact.filePath]);

  return (
    <div
      data-process-image-id={artifact.id}
      className="artifact-preview-card-group overflow-hidden rounded-2xl border border-border transition-colors"
    >
      <button
        type="button"
        onClick={onOpen}
        title={displayName}
        aria-label={displayName}
        className="group/thumb relative block aspect-video w-full cursor-zoom-in overflow-hidden bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
      >
        {failed ? (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-xs text-muted">
            <PhotoIcon className="h-5 w-5" aria-hidden="true" />
            <span>{t('imageStudioLoadFailed')}</span>
          </span>
        ) : (
          <img
            src={thumbSrc}
            alt={displayName}
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={`h-full w-full object-cover transition-[opacity,transform] duration-200 group-hover/thumb:scale-[1.02] ${
              loaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}
        {!loaded && !failed && (
          <span aria-hidden="true" className="absolute inset-0 animate-pulse bg-black/[0.04] dark:bg-white/[0.05]" />
        )}
      </button>

      <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-2">
        <button
          type="button"
          onClick={onOpen}
          title={displayName}
          className="min-w-0 flex-1 cursor-pointer bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        >
          <div className="truncate text-xs font-medium leading-4 text-foreground">
            {displayName}
          </div>
          {subtitle && (
            <div className="mt-0.5 truncate text-[11px] leading-4 text-secondary">
              {subtitle}
            </div>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {editable && isImageStudioAvailable() && (
            <ActionIconButton
              label={t('imageStudioEdit')}
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
              compact
            >
              <PaletteBrushIcon className="h-3.5 w-3.5" />
            </ActionIconButton>
          )}
          {canShare && (
            <ActionIconButton
              label={t('htmlShare')}
              onClick={(event) => {
                event.stopPropagation();
                onShare();
              }}
              compact
            >
              <ArrowUpTrayIcon className="h-3.5 w-3.5" />
            </ActionIconButton>
          )}
          {artifact.filePath && (
            <ActionIconButton
              buttonRef={openMenuAnchorRef}
              label={t('artifactPreviewCardOpenWith')}
              onClick={(event) => {
                event.stopPropagation();
                setOpenMenuOpen(prev => !prev);
              }}
              onMouseEnter={handlePrefetchApps}
              onFocus={handlePrefetchApps}
              compact
            >
              <EllipsisHorizontalIcon className="h-3.5 w-3.5" />
            </ActionIconButton>
          )}
        </div>

        {openMenuOpen && artifact.filePath && (
          <ArtifactOpenDropdown
            anchorRef={openMenuAnchorRef as React.RefObject<HTMLElement>}
            artifact={artifact}
            filePath={artifact.filePath}
            onClose={() => setOpenMenuOpen(false)}
          />
        )}
      </div>
    </div>
  );
};

export interface InlineVideoGalleryProps {
  videos: Artifact[];
  processVideos?: Artifact[];
  processImages?: Artifact[];
  editable?: boolean;
}

/**
 * Generated and produced videos shown inline in the conversation: a lone final deliverable
 * keeps its own aspect ratio and plays in place; intermediate clips and reference/keyframe
 * images fold cleanly beneath it; multiple equal deliverables form a 2-column grid.
 */
const InlineVideoGallery: React.FC<InlineVideoGalleryProps> = ({
  videos,
  processVideos = [],
  processImages = [],
  editable = true,
}) => {
  const artifactFileShare = useOptionalArtifactFileShare();
  const [gridExpanded, setGridExpanded] = useState(false);
  const [processAssetsExpanded, setProcessAssetsExpanded] = useState(false);
  const [previewImageIndex, setPreviewImageIndex] = useState<number | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const returnVideoTimeRef = useRef<((time: number) => void) | null>(null);

  const previewProcessImages = useMemo<ImagePreviewSource[]>(
    () => processImages.map((artifact) => {
      const name = getVideoDisplayName(artifact, t('artifactImageAlt'));
      return {
        src: getImageArtifactSrc(artifact),
        thumbSrc: getImageArtifactDisplaySrc(artifact, 88, LocalFileThumbnailFit.Cover),
        name,
        alt: name,
      };
    }),
    [processImages],
  );

  const handleOpenFullscreenVideo = useCallback(
    (source: VideoPreviewSource, onReturnTime: (time: number) => void) => {
      returnVideoTimeRef.current = onReturnTime;
      setPreviewVideo(source);
    },
    [],
  );

  const handleCloseFullscreenVideo = useCallback((lastTime?: number) => {
    if (typeof lastTime === 'number') {
      returnVideoTimeRef.current?.(lastTime);
    }
    returnVideoTimeRef.current = null;
    setPreviewVideo(null);
  }, []);

  const handleOpenProcessImage = useCallback((artifact: Artifact, index: number, operation?: ImageEditOperation) => {
    const inStudio = editable && isImageStudioAvailable();
    reportArtifactPreviewAction({
      actionType: 'card_open',
      source: ArtifactPreviewActionSource.ConversationArtifactCard,
      artifact,
      params: {
        openTarget: inStudio ? 'image_studio' : 'image_viewer',
      },
    });
    if (inStudio) {
      openImageInStudio(artifact, operation, undefined, processImages);
      return;
    }
    setPreviewImageIndex(index);
  }, [editable, processImages]);

  const handleShare = useCallback((artifact: Artifact) => {
    void artifactFileShare?.openShare(artifact, {
      source: ArtifactPreviewActionSource.ConversationArtifactCard,
      entryPoint: ArtifactPublishEntryPoint.PreviewCard,
    });
  }, [artifactFileShare]);

  if (videos.length === 0) return null;

  const isSingleHero = videos.length === 1;
  const visiblePrimaryVideos = isSingleHero || gridExpanded
    ? videos
    : videos.slice(0, MAX_COLLAPSED_VIDEO_TILES);
  const hiddenPrimaryCount = Math.max(0, videos.length - visiblePrimaryVideos.length);
  const processCount = processVideos.length + processImages.length;

  return (
    <div className="space-y-2.5">
      {isSingleHero ? (
        <InlineVideoCard
          artifact={videos[0]}
          variant={VideoCardVariant.Hero}
          showFinalBadge={processCount > 0}
          canShare={Boolean(artifactFileShare) && isArtifactFileShareable(videos[0])}
          onShare={() => handleShare(videos[0])}
          onOpenFullscreen={handleOpenFullscreenVideo}
        />
      ) : (
        <div className="space-y-2">
          <div
            className="grid grid-cols-2 gap-2.5"
            style={{ maxWidth: `${INLINE_VIDEO_MAX_WIDTH}px` }}
          >
            {visiblePrimaryVideos.map(artifact => (
              <InlineVideoCard
                key={artifact.id}
                artifact={artifact}
                variant={VideoCardVariant.Grid}
                canShare={Boolean(artifactFileShare) && isArtifactFileShareable(artifact)}
                onShare={() => handleShare(artifact)}
                onOpenFullscreen={handleOpenFullscreenVideo}
              />
            ))}
          </div>
          {(hiddenPrimaryCount > 0 || (gridExpanded && videos.length > MAX_COLLAPSED_VIDEO_TILES)) && (
            <div>
              {hiddenPrimaryCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setGridExpanded(true)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-secondary transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.035]"
                >
                  <span>{t('artifactPreviewCardShowMore').replace('{count}', String(hiddenPrimaryCount))}</span>
                  <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setGridExpanded(false)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-secondary transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.035]"
                >
                  <span>{t('artifactPreviewCardShowLess')}</span>
                  <ChevronUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {processCount > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setProcessAssetsExpanded(value => !value)}
            aria-expanded={processAssetsExpanded}
            className="inline-flex items-center gap-1.5 rounded-md py-0.5 text-xs font-medium text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ChevronRightIcon
              className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 ${processAssetsExpanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            />
            <span>{formatProcessAssetsLabel(processVideos.length, processImages.length)}</span>
          </button>
          {processAssetsExpanded && (
            <div
              className="grid grid-cols-2 gap-2.5"
              style={{ maxWidth: `${INLINE_VIDEO_MAX_WIDTH}px` }}
            >
              {processVideos.map(artifact => (
                <InlineVideoCard
                  key={artifact.id}
                  artifact={artifact}
                  variant={VideoCardVariant.Grid}
                  canShare={Boolean(artifactFileShare) && isArtifactFileShareable(artifact)}
                  onShare={() => handleShare(artifact)}
                  onOpenFullscreen={handleOpenFullscreenVideo}
                />
              ))}
              {processImages.map((artifact, index) => (
                <ProcessImageCard
                  key={artifact.id}
                  artifact={artifact}
                  editable={editable}
                  canShare={Boolean(artifactFileShare) && isArtifactFileShareable(artifact)}
                  onOpen={() => handleOpenProcessImage(artifact, index)}
                  onEdit={() => handleOpenProcessImage(artifact, index, ImageEditOperation.Comment)}
                  onShare={() => handleShare(artifact)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ImagePreviewModal
        images={previewProcessImages}
        currentIndex={previewImageIndex}
        onIndexChange={setPreviewImageIndex}
        onClose={() => setPreviewImageIndex(null)}
      />
      <VideoPreviewModal video={previewVideo} onClose={handleCloseFullscreenVideo} />
    </div>
  );
};

export default InlineVideoGallery;
