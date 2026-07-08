import type { ShareDeploymentProjectCandidate } from '../../shared/shareDeployment/constants';

export const ArtifactTypeValue = {
  Html: 'html',
  Svg: 'svg',
  Image: 'image',
  Video: 'video',
  Mermaid: 'mermaid',
  Code: 'code',
  Markdown: 'markdown',
  Text: 'text',
  Document: 'document',
  LocalService: 'local-service',
} as const;

export type ArtifactSource = 'inline' | 'tool' | 'file';
export type ArtifactType = typeof ArtifactTypeValue[keyof typeof ArtifactTypeValue];

export interface LocalServiceArtifactMetadata {
  url: string;
  origin: string;
  projectDirectory?: string;
  projectCandidates?: ShareDeploymentProjectCandidate[];
}

export const PREVIEWABLE_ARTIFACT_TYPES = new Set<ArtifactType>([
  ArtifactTypeValue.Html,
  ArtifactTypeValue.Svg,
  ArtifactTypeValue.Mermaid,
  ArtifactTypeValue.Image,
  ArtifactTypeValue.Video,
  ArtifactTypeValue.Markdown,
  ArtifactTypeValue.Text,
  ArtifactTypeValue.Document,
  ArtifactTypeValue.LocalService,
]);

export interface Artifact {
  id: string;
  messageId: string;
  sessionId: string;
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  fileName?: string;
  filePath?: string;
  url?: string;
  localService?: LocalServiceArtifactMetadata;
  contentVersion?: number;
  remoteUrl?: string;
  source?: ArtifactSource;
  createdAt: number;
}

export interface ArtifactMarker {
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  fullMatch: string;
}
