import React from 'react';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import { isWorkspaceDiffArtifact } from '../../../shared/artifactPreview/workspaceChanges';
import type { ArtifactSelectedTextContext } from './artifactSelectedText';
import CodeRenderer from './renderers/CodeRenderer';
import DocumentRenderer from './renderers/DocumentRenderer';
import HtmlRenderer from './renderers/HtmlRenderer';
import ImageRenderer from './renderers/ImageRenderer';
import MarkdownRenderer from './renderers/MarkdownRenderer';
import MermaidRenderer from './renderers/MermaidRenderer';
import SvgRenderer from './renderers/SvgRenderer';
import TextRenderer from './renderers/TextRenderer';
import VideoRenderer from './renderers/VideoRenderer';
import WorkspaceDiffRenderer from './renderers/WorkspaceDiffRenderer';

interface ArtifactRendererProps {
  artifact: Artifact;
  sessionArtifacts?: Artifact[];
  selectedTextContext?: ArtifactSelectedTextContext;
  sourceView?: boolean;
}

const ArtifactRenderer: React.FC<ArtifactRendererProps> = ({ artifact, selectedTextContext, sourceView = false }) => {
  if (isWorkspaceDiffArtifact(artifact) && !sourceView) {
    return <WorkspaceDiffRenderer artifact={artifact} selectedTextContext={selectedTextContext} />;
  }
  if (sourceView && !(artifact.type === ArtifactTypeValue.Markdown && artifact.filePath && window.electron?.artifact?.markdown)) {
    return <CodeRenderer artifact={artifact} />;
  }
  switch (artifact.type) {
    case 'html':
      return <HtmlRenderer artifact={artifact} />;
    case 'svg':
      return <SvgRenderer artifact={artifact} />;
    case 'image':
      return <ImageRenderer artifact={artifact} />;
    case 'video':
      return <VideoRenderer artifact={artifact} />;
    case 'mermaid':
      return <MermaidRenderer artifact={artifact} />;
    case ArtifactTypeValue.Markdown:
      return <MarkdownRenderer artifact={artifact} selectedTextContext={selectedTextContext} sourceView={sourceView} />;
    case 'text':
      return <TextRenderer artifact={artifact} selectedTextContext={selectedTextContext} />;
    case 'document':
      return <DocumentRenderer artifact={artifact} />;
    case 'code':
      return <CodeRenderer artifact={artifact} />;
    case 'local-service':
      return (
        <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted">
          {artifact.url || artifact.content}
        </div>
      );
    default:
      return (
        <div className="flex items-center justify-center h-full text-muted text-sm">
          Unsupported artifact type
        </div>
      );
  }
};

export default ArtifactRenderer;
