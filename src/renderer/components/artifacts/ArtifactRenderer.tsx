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

function isReactProjectEntry(artifact: Artifact): boolean {
  if (artifact.type !== 'html' || !artifact.content) return false;
  return /\<script[^>]+src=["'][^"']*\.(jsx|tsx)["']/i.test(artifact.content);
}

function findAppArtifact(artifact: Artifact, sessionArtifacts: Artifact[]): Artifact | null {
  const entryMatch = artifact.content.match(/src=["']([^"']*\.(jsx|tsx))["']/i);
  if (!entryMatch) return null;

  const entryPath = entryMatch[1];
  const entryName = entryPath.split('/').pop() || '';

  // Find the entry file (e.g., main.jsx) in session artifacts
  const entryArtifact = sessionArtifacts.find(
    a => a.type === 'react' && a.content && (a.fileName === entryName || a.filePath?.endsWith(entryPath.replace(/^\//, ''))),
  );

  if (entryArtifact) {
    // Look for the App component import in the entry file
    const appImportMatch = entryArtifact.content.match(/import\s+\w+\s+from\s+['"]([^'"]*App[^'"]*)['"]/i);
    if (appImportMatch) {
      const appPath = appImportMatch[1];
      const appName = appPath.split('/').pop() || '';
      const candidates = [appName + '.jsx', appName + '.tsx', appName + '.js', appName + '.ts', appName];

      for (const candidate of candidates) {
        const found = sessionArtifacts.find(
          a => a.type === 'react' && a.content && a.fileName === candidate,
        );
        if (found) return found;
      }
    }
    // If entry file itself has a default export, use it
    if (/export\s+default/.test(entryArtifact.content)) {
      return entryArtifact;
    }
  }

  // Fallback: look for any App.jsx/App.tsx in session
  return sessionArtifacts.find(
    a => a.type === 'react' && a.content && /^App\.(jsx|tsx|js|ts)$/.test(a.fileName || ''),
  ) || null;
}

const ArtifactRenderer: React.FC<ArtifactRendererProps> = ({ artifact, sessionArtifacts }) => {
  // Detect React project entry HTML and redirect to ReactRenderer
  if (isReactProjectEntry(artifact) && sessionArtifacts) {
    const appArtifact = findAppArtifact(artifact, sessionArtifacts);
    if (appArtifact) {
      return <ReactRenderer artifact={appArtifact} sessionArtifacts={sessionArtifacts} />;
    }
  }

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
