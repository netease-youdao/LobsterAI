import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  HtmlShareSourceType,
} from '@shared/htmlShare/constants';

import {
  type Artifact,
  ArtifactMediaOriginType,
  type ArtifactType,
  ArtifactTypeValue,
} from '@/types/artifact';

export const ArtifactFileShareRequestSource = {
  HtmlFile: 'htmlFile',
  ArtifactFile: 'artifactFile',
  GeneratedVideo: 'generatedVideo',
} as const;

export type ArtifactFileShareRequestSource =
  (typeof ArtifactFileShareRequestSource)[keyof typeof ArtifactFileShareRequestSource];

export type ArtifactFileShareSourceType =
  | typeof HtmlShareSourceType.HtmlFile
  | typeof HtmlShareSourceType.ImageFile
  | typeof HtmlShareSourceType.SvgFile
  | typeof HtmlShareSourceType.DocumentFile
  | typeof HtmlShareSourceType.MarkdownFile
  | typeof HtmlShareSourceType.MermaidFile
  | typeof HtmlShareSourceType.GeneratedVideoFile;

export interface ArtifactFileShareRequest {
  source: ArtifactFileShareRequestSource;
  sourceType: ArtifactFileShareSourceType;
  sessionId: string;
  artifactId: string;
  lookupKey: string;
  title: string;
  accessMode: HtmlShareAccessModeValue;
  fileName?: string;
  filePath?: string;
  content?: string;
  remoteUrl?: string;
  taskId?: string;
  outputIndex?: number;
  legacyResultUrl?: string;
}

const ARTIFACT_FILE_SHARE_SOURCE_TYPES: Partial<Record<ArtifactType, ArtifactFileShareSourceType>> =
  {
    [ArtifactTypeValue.Html]: HtmlShareSourceType.HtmlFile,
    [ArtifactTypeValue.Image]: HtmlShareSourceType.ImageFile,
    [ArtifactTypeValue.Svg]: HtmlShareSourceType.SvgFile,
    [ArtifactTypeValue.Document]: HtmlShareSourceType.DocumentFile,
    [ArtifactTypeValue.Markdown]: HtmlShareSourceType.MarkdownFile,
    [ArtifactTypeValue.Mermaid]: HtmlShareSourceType.MermaidFile,
  };

export function getArtifactFileShareSourceType(
  artifact: Artifact,
): ArtifactFileShareSourceType | null {
  if (
    artifact.type === ArtifactTypeValue.Video
    && (
      artifact.mediaOrigin?.type === ArtifactMediaOriginType.GeneratedVideo
      || (
        artifact.legacyGeneratedVideoCandidate
        && /^https:\/\//i.test(artifact.remoteUrl?.trim() || '')
      )
    )
  ) {
    return HtmlShareSourceType.GeneratedVideoFile;
  }
  return ARTIFACT_FILE_SHARE_SOURCE_TYPES[artifact.type] ?? null;
}

function hasShareableSource(artifact: Artifact, sourceType: ArtifactFileShareSourceType): boolean {
  if (sourceType === HtmlShareSourceType.GeneratedVideoFile) {
    return artifact.mediaOrigin?.type === ArtifactMediaOriginType.GeneratedVideo
      || Boolean(
        artifact.legacyGeneratedVideoCandidate
        && /^https:\/\//i.test(artifact.remoteUrl?.trim() || ''),
      );
  }
  if (sourceType === HtmlShareSourceType.HtmlFile) {
    return Boolean(artifact.filePath);
  }
  if (
    sourceType === HtmlShareSourceType.DocumentFile ||
    sourceType === HtmlShareSourceType.MarkdownFile ||
    sourceType === HtmlShareSourceType.MermaidFile
  ) {
    return Boolean(artifact.filePath || artifact.content.trim());
  }
  return Boolean(artifact.filePath || artifact.content.trim() || artifact.remoteUrl?.trim());
}

export function isArtifactFileShareable(artifact: Artifact): boolean {
  const sourceType = getArtifactFileShareSourceType(artifact);
  return sourceType ? hasShareableSource(artifact, sourceType) : false;
}

function normalizeArtifactFileShareLookupPath(filePath: string): string {
  let normalized = filePath.trim();
  if (/^file:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^file:\/\//i, '');
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // Keep malformed percent sequences unchanged, matching the main-process fallback.
    }
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\\/g, '/').toLowerCase();
}

export function buildArtifactFileShareLookupKey(
  artifact: Artifact,
  sourceType: ArtifactFileShareSourceType,
  fallbackSessionId = '',
): string {
  if (sourceType === HtmlShareSourceType.GeneratedVideoFile) {
    if (artifact.mediaOrigin?.type === ArtifactMediaOriginType.GeneratedVideo) {
      return `${sourceType}:task:${artifact.mediaOrigin.taskId}:${artifact.mediaOrigin.outputIndex}`;
    }
    return `${sourceType}:legacy:${artifact.sessionId || fallbackSessionId}:${artifact.id}`;
  }
  if (artifact.filePath) {
    return `${sourceType}:file:${normalizeArtifactFileShareLookupPath(artifact.filePath)}`;
  }
  return `${sourceType}:artifact:${artifact.sessionId || fallbackSessionId}:${artifact.id}`;
}

export function buildArtifactFileShareRequest(
  artifact: Artifact,
  fallbackSessionId: string,
  fallbackTitle = '',
): ArtifactFileShareRequest | null {
  const sourceType = getArtifactFileShareSourceType(artifact);
  if (!sourceType || !hasShareableSource(artifact, sourceType)) return null;

  const sessionId = artifact.sessionId || fallbackSessionId;
  const title = artifact.title || artifact.fileName || fallbackTitle;
  const lookupKey = buildArtifactFileShareLookupKey(artifact, sourceType, fallbackSessionId);

  if (sourceType === HtmlShareSourceType.GeneratedVideoFile) {
    return {
      source: ArtifactFileShareRequestSource.GeneratedVideo,
      sourceType,
      sessionId,
      artifactId: artifact.id,
      lookupKey,
      title,
      accessMode: HtmlShareAccessMode.Code,
      ...(artifact.mediaOrigin?.type === ArtifactMediaOriginType.GeneratedVideo
        ? {
            taskId: artifact.mediaOrigin.taskId,
            outputIndex: artifact.mediaOrigin.outputIndex,
          }
        : { legacyResultUrl: artifact.remoteUrl?.trim() }),
    };
  }

  if (sourceType === HtmlShareSourceType.HtmlFile) {
    if (!artifact.filePath) return null;
    return {
      source: ArtifactFileShareRequestSource.HtmlFile,
      sourceType,
      sessionId,
      artifactId: artifact.id,
      lookupKey,
      filePath: artifact.filePath,
      title,
      accessMode: HtmlShareAccessMode.Code,
    };
  }

  return {
    source: ArtifactFileShareRequestSource.ArtifactFile,
    sourceType,
    sessionId,
    artifactId: artifact.id,
    lookupKey,
    title,
    accessMode: HtmlShareAccessMode.Code,
    fileName: artifact.fileName || artifact.title,
    filePath: artifact.filePath,
    content: artifact.content,
    remoteUrl:
      sourceType === HtmlShareSourceType.DocumentFile ||
      sourceType === HtmlShareSourceType.MarkdownFile ||
      sourceType === HtmlShareSourceType.MermaidFile
        ? undefined
        : artifact.remoteUrl,
  };
}
