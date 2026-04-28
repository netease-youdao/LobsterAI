export type ArtifactType = 'html' | 'svg' | 'image' | 'mermaid' | 'react' | 'code';

export const PREVIEWABLE_ARTIFACT_TYPES = new Set<ArtifactType>(['html', 'svg', 'react', 'mermaid', 'image']);

export type ArtifactSource = 'codeblock' | 'tool';

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
  source: ArtifactSource;
  createdAt: number;
}

export interface ArtifactMarker {
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  fullMatch: string;
}
