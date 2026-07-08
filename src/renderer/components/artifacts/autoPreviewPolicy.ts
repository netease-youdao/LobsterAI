import { dedupeArtifactsForDisplay } from '@/services/artifactParser';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

export const ArtifactAutoPreviewCategory = {
  LocalService: 'local-service',
  Html: 'html',
  Video: 'video',
  Image: 'image',
  Document: 'document',
} as const;

export type ArtifactAutoPreviewCategory =
  typeof ArtifactAutoPreviewCategory[keyof typeof ArtifactAutoPreviewCategory];

export const ArtifactAutoPreviewOpenTarget = {
  LocalServiceBrowser: 'local-service-browser',
  HtmlBrowser: 'html-browser',
  PreviewTab: 'preview-tab',
} as const;

export type ArtifactAutoPreviewOpenTarget =
  typeof ArtifactAutoPreviewOpenTarget[keyof typeof ArtifactAutoPreviewOpenTarget];

const AUTO_PREVIEW_PRIORITY: readonly ArtifactAutoPreviewCategory[] = [
  ArtifactAutoPreviewCategory.LocalService,
  ArtifactAutoPreviewCategory.Document,
  ArtifactAutoPreviewCategory.Html,
  ArtifactAutoPreviewCategory.Video,
  ArtifactAutoPreviewCategory.Image,
];

interface AutoPreviewCandidate {
  artifact: Artifact;
  displayIndex: number;
  priority: number;
}

interface SelectAutoPreviewArtifactOptions {
  defaultProjectDirectory?: string;
}

export function getAutoPreviewCategory(artifact: Artifact): ArtifactAutoPreviewCategory | null {
  switch (artifact.type) {
    case ArtifactTypeValue.LocalService:
      return ArtifactAutoPreviewCategory.LocalService;
    case ArtifactTypeValue.Html:
      return ArtifactAutoPreviewCategory.Html;
    case ArtifactTypeValue.Video:
      return ArtifactAutoPreviewCategory.Video;
    case ArtifactTypeValue.Image:
    case ArtifactTypeValue.Svg:
      return ArtifactAutoPreviewCategory.Image;
    case ArtifactTypeValue.Document:
    case ArtifactTypeValue.Markdown:
      return ArtifactAutoPreviewCategory.Document;
    default:
      return null;
  }
}

export function getAutoPreviewOpenTarget(artifact: Artifact): ArtifactAutoPreviewOpenTarget | null {
  const category = getAutoPreviewCategory(artifact);
  if (!category) return null;

  if (category === ArtifactAutoPreviewCategory.LocalService) {
    return ArtifactAutoPreviewOpenTarget.LocalServiceBrowser;
  }
  if (category === ArtifactAutoPreviewCategory.Html && artifact.filePath) {
    return ArtifactAutoPreviewOpenTarget.HtmlBrowser;
  }
  return ArtifactAutoPreviewOpenTarget.PreviewTab;
}

function getAutoPreviewPriority(artifact: Artifact): number | null {
  const category = getAutoPreviewCategory(artifact);
  if (!category) return null;
  const priority = AUTO_PREVIEW_PRIORITY.indexOf(category);
  return priority >= 0 ? priority : null;
}

export function selectAutoPreviewArtifact(
  artifacts: Artifact[],
  options: SelectAutoPreviewArtifactOptions = {},
): Artifact | null {
  const candidates = dedupeArtifactsForDisplay(artifacts, options)
    .map((artifact, displayIndex) => ({
      artifact,
      displayIndex,
      priority: getAutoPreviewPriority(artifact),
    }))
    .filter((item): item is AutoPreviewCandidate => item.priority !== null);

  candidates.sort((left, right) =>
    left.priority - right.priority || left.displayIndex - right.displayIndex
  );

  return candidates[0]?.artifact ?? null;
}
