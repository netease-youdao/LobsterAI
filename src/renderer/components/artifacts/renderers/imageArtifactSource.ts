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
