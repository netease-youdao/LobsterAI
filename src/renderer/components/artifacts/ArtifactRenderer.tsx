import React from 'react';

import type { Artifact } from '@/types/artifact';

import CodeRenderer from './renderers/CodeRenderer';
import HtmlRenderer from './renderers/HtmlRenderer';
import ImageRenderer from './renderers/ImageRenderer';
import MermaidRenderer from './renderers/MermaidRenderer';
import ReactRenderer from './renderers/ReactRenderer';
import SvgRenderer from './renderers/SvgRenderer';

interface ArtifactRendererProps {
  artifact: Artifact;
  sessionArtifacts?: Artifact[];
}

const ArtifactRenderer: React.FC<ArtifactRendererProps> = ({ artifact, sessionArtifacts }) => {
  switch (artifact.type) {
    case 'html':
      return <HtmlRenderer artifact={artifact} />;
    case 'svg':
      return <SvgRenderer artifact={artifact} />;
    case 'image':
      return <ImageRenderer artifact={artifact} />;
    case 'mermaid':
      return <MermaidRenderer artifact={artifact} />;
    case 'react':
      return <ReactRenderer artifact={artifact} sessionArtifacts={sessionArtifacts} />;
    case 'code':
      return <CodeRenderer artifact={artifact} />;
    default:
      return (
        <div className="flex items-center justify-center h-full text-muted text-sm">
          Unsupported artifact type
        </div>
      );
  }
};

export default ArtifactRenderer;
