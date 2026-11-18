import { LocalFileThumbnailFit, snapLocalFileThumbnailEdge } from '@shared/artifactPreview/localFileThumbnail';

import type { Artifact } from '@/types/artifact';

import { buildLocalFileSrc } from './VideoRenderer';

/**
 * Where an image artifact is displayed from. Images on disk load from the file (their content is
 * left empty, see loadDetectedFileArtifact), versioned by `contentVersion` so a refreshed or changed
 * file is fetched again; inline images carry a data or remote URL in `content`.
 */
export const getImageArtifactSrc = (artifact: Artifact): string => (
  artifact.filePath
    ? buildLocalFileSrc(artifact.filePath, artifact.contentVersion ?? artifact.createdAt)
    : artifact.content
);

/**
 * Source for showing an image in a box `displayEdge` CSS pixels on its long side (`contain`) or on its
 * short side when cropped to fill (`cover`). Images on disk ask the protocol for a copy sized to the
 * screen: generated images are several times larger than the conversation shows them, and decoding
 * the originals is what makes image-heavy tasks slow to open.
 */
export const getImageArtifactDisplaySrc = (
  artifact: Artifact,
  displayEdge: number,
  fit: LocalFileThumbnailFit = LocalFileThumbnailFit.Contain,
  pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
): string => {
  if (!artifact.filePath) return artifact.content;
  const edge = snapLocalFileThumbnailEdge(displayEdge * pixelRatio);
  return buildLocalFileSrc(artifact.filePath, artifact.contentVersion ?? artifact.createdAt, edge ? { edge, fit } : undefined);
};
