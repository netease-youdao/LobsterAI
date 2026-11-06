import { ArrowUpTrayIcon, FolderIcon, PhotoIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ImageEditOperation } from '../../../../shared/imageEditing/types';
import { i18nService } from '../../../services/i18n';
import { openImageInStudio } from '../../../services/imageEditing';
import { type Artifact, ArtifactTypeValue } from '../../../types/artifact';
import { getCachedImageSize, type ImageSize, measureImageSizes, rememberImageSize } from '../../../utils/imageDisplaySize';
import { revealLocalPathWithToast } from '../../../utils/localFileActions';
import ImagePreviewModal, { type ImagePreviewSource } from '../../cowork/ImagePreviewModal';
import MessageCopiedIcon from '../../icons/MessageCopiedIcon';
import MessageCopyIcon from '../../icons/MessageCopyIcon';
import { ArtifactPreviewActionSource, ArtifactPublishEntryPoint, reportArtifactPreviewAction } from '../artifactAnalytics';
import { useOptionalArtifactFileShare } from '../ArtifactFileShareController';
import { isArtifactFileShareable } from '../artifactFileSharePolicy';
import { getImageArtifactSrc } from '../renderers/imageArtifactSource';
import { PaletteBrushIcon } from './ImageEditingIcons';
import { isImageStudioAvailable } from './imageStudioAvailability';

const t = (key: string) => i18nService.t(key);
const MAX_COLLAPSED_TILES = 4;
const COPIED_FEEDBACK_MS = 2000;
const LoadState = { Loading: 'loading', Loaded: 'loaded', Failed: 'failed' } as const;
type LoadState = typeof LoadState[keyof typeof LoadState];

const SINGLE_IMAGE_MAX_HEIGHT = 420;
const SINGLE_IMAGE_PLACEHOLDER_SIZE = { width: 320, height: 240 };

const imageSrc = getImageArtifactSrc;
const imageName = (artifact: Artifact): string => artifact.fileName || artifact.title || t('artifactImageAlt');
const toast = (message: string) => window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));

// A known natural size reserves the exact final box (capped by the max height, then the column width);
// otherwise a fixed placeholder holds space until the image loads and reports its size.
const singleImageStyle = (size: ImageSize | null, loaded: boolean): React.CSSProperties | undefined => {
  if (size) {
    return {
      width: Math.min(size.width, (SINGLE_IMAGE_MAX_HEIGHT * size.width) / size.height),
      aspectRatio: `${size.width} / ${size.height}`,
    };
  }
  return loaded ? undefined : SINGLE_IMAGE_PLACEHOLDER_SIZE;
};

/** Decodes image artifacts before they reach the conversation, so they render at their final size at once. */
export const preloadInlineImages = (artifacts: Artifact[]): Promise<void> => measureImageSizes(
  artifacts.filter(artifact => artifact.type === ArtifactTypeValue.Image).map(imageSrc),
);

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} onClick={event => { event.stopPropagation(); onClick(); }}
    className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
    {children}
  </button>;
}

function ImageTile({ artifact, single, hiddenCount, editable, canShare, onOpen, onEdit, onShare }: {
  artifact: Artifact; single: boolean; hiddenCount: number; editable: boolean; canShare: boolean;
  onOpen: () => void; onEdit: () => void; onShare: () => void;
}) {
  const [state, setState] = useState<LoadState>(LoadState.Loading);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => () => { if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current); }, []);
  const name = imageName(artifact);
  const src = imageSrc(artifact);
  const markLoaded = (image: HTMLImageElement) => {
    rememberImageSize(src, image.naturalWidth, image.naturalHeight);
    setState(LoadState.Loaded);
  };
  // An image that is already decoded (preloaded, or shown before) skips the fade-in, so reopening a task does not flash.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) markLoaded(image);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first layout of each src can skip the fade
  }, [src]);
  // Same feedback as the conversation's copy button: a check for a moment on success, a toast only on failure.
  const copy = async () => {
    const result = artifact.filePath ? await window.electron?.clipboard?.writeImageFromFile(artifact.filePath)
      : await window.electron?.clipboard?.writeImageFromDataUrl(artifact.content);
    if (!result?.success) { toast(result?.error || t('copyFailed')); return; }
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };
  const loaded = state === LoadState.Loaded;
  return <div className={`group relative overflow-hidden rounded-2xl border border-border bg-surface-raised ${single ? 'inline-block max-w-full align-top' : 'aspect-square'}`}>
    <button type="button" onClick={onOpen} title={name} aria-label={hiddenCount ? `+${hiddenCount}` : name}
      className={`relative block cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${single ? '' : 'h-full w-full'}`}>
      {state === LoadState.Failed
        ? <span className="flex h-40 w-64 max-w-full flex-col items-center justify-center gap-2 text-xs text-muted"><PhotoIcon className="h-6 w-6" />{t('imageStudioLoadFailed')}</span>
        : <img ref={imageRef} src={src} alt={name} draggable={false} onLoad={event => markLoaded(event.currentTarget)} onError={() => setState(LoadState.Failed)}
          className={`${single ? 'block max-h-[420px] w-auto max-w-full' : 'h-full w-full object-cover'} transition-[opacity,transform] duration-300 ease-out group-hover:scale-[1.015] ${loaded ? 'opacity-100' : 'opacity-0'}`}
          style={single ? singleImageStyle(getCachedImageSize(src), loaded) : undefined} />}
      {state === LoadState.Loading && <span aria-hidden="true" className="absolute inset-0 animate-pulse bg-black/[0.04] dark:bg-white/[0.05]" />}
      {hiddenCount > 0 && <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-xl font-medium text-white">+{hiddenCount}</span>}
    </button>
    {loaded && hiddenCount === 0 && <>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/25 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100" />
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100">
        <TileAction label={t('imageEditCopy')} onClick={() => void copy()}>
          {copied ? <MessageCopiedIcon className="h-4 w-4 text-success" /> : <MessageCopyIcon className="h-4 w-4" />}
        </TileAction>
        {artifact.filePath && <TileAction label={t('showInFolder')} onClick={() => void revealLocalPathWithToast(artifact.filePath!)}><FolderIcon className="h-4 w-4" /></TileAction>}
        {canShare && <TileAction label={t('htmlShare')} onClick={onShare}><ArrowUpTrayIcon className="h-4 w-4" /></TileAction>}
      </div>
      {editable && <button type="button" onClick={onEdit}
        className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-neutral-900 opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-200 hover:bg-white focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
        <PaletteBrushIcon className="h-4 w-4" />{t('imageStudioEdit')}
      </button>}
    </>}
  </div>;
}

/**
 * Generated and referenced images shown in the conversation itself: one image keeps its own aspect ratio,
 * several form a grid. Clicking opens the full-screen studio, or a plain viewer where editing is unavailable.
 */
export default function InlineImageGallery({ artifacts, editable = true }: { artifacts: Artifact[]; editable?: boolean }) {
  const share = useOptionalArtifactFileShare();
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  if (!artifacts.length) return null;
  const single = artifacts.length === 1;
  const tiles = expanded ? artifacts : artifacts.slice(0, MAX_COLLAPSED_TILES);
  const hidden = artifacts.length - tiles.length;
  const open = (artifact: Artifact, operation?: ImageEditOperation) => {
    const inStudio = editable && isImageStudioAvailable();
    reportArtifactPreviewAction({ actionType: 'card_open', source: ArtifactPreviewActionSource.ConversationArtifactCard, artifact,
      params: { openTarget: inStudio ? 'image_studio' : 'image_viewer' } });
    if (inStudio) openImageInStudio(artifact, operation);
    else setPreview({ src: imageSrc(artifact), name: imageName(artifact) });
  };
  return <>
    <div className={single ? 'max-w-full' : 'grid max-w-[480px] grid-cols-2 gap-2'}>
      {tiles.map((artifact, index) => {
        const hiddenCount = index === tiles.length - 1 ? hidden : 0;
        return <ImageTile key={artifact.id} artifact={artifact} single={single} hiddenCount={hiddenCount} editable={editable}
          canShare={Boolean(share) && isArtifactFileShareable(artifact)}
          onOpen={() => hiddenCount ? setExpanded(true) : open(artifact)}
          onEdit={() => open(artifact, ImageEditOperation.Comment)}
          onShare={() => void share?.openShare(artifact, {
            source: ArtifactPreviewActionSource.ConversationArtifactCard, entryPoint: ArtifactPublishEntryPoint.PreviewCard,
          })} />;
      })}
    </div>
    <ImagePreviewModal image={preview} onClose={() => setPreview(null)} />
  </>;
}
