import React, { useEffect, useState } from 'react';

import type { Artifact } from '@/types/artifact';

interface HtmlRendererProps {
  artifact: Artifact;
}

function hasRelativeResources(html: string): boolean {
  const srcRe = /(?:src|href)=["'](?!https?:|data:|blob:|#|javascript:)([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = srcRe.exec(html)) !== null) {
    const value = match[1];
    // Relative paths: ./file, ../file, file (no protocol)
    if (value.startsWith('./') || value.startsWith('../') || (!value.startsWith('/') && !value.includes(':'))) {
      return true;
    }
    // Absolute paths to local source files (e.g., /src/main.jsx)
    if (value.startsWith('/') && !value.startsWith('//')) {
      return true;
    }
  }
  return false;
}

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
  const encoded = normalized.split('/').map(s => encodeURIComponent(s)).join('/');
  return `file://${encoded}`;
}

const HtmlRenderer: React.FC<HtmlRendererProps> = ({ artifact }) => {
  const [processedHtml, setProcessedHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!artifact.content && !artifact.filePath) {
      setProcessedHtml(null);
      return;
    }

    if (!artifact.content) {
      setProcessedHtml(null);
      return;
    }

    let cancelled = false;

    const process = async () => {
      try {
        let html = artifact.content;
        if (artifact.filePath && !hasRelativeResources(html)) {
          html = await inlineLocalResources(html, artifact.filePath);
        }
        if (!cancelled) setProcessedHtml(html);
      } catch {
        if (!cancelled) setProcessedHtml(artifact.content);
      }
    };

    process();
    return () => { cancelled = true; };
  }, [artifact.content, artifact.filePath]);

  if (!artifact.content && !artifact.filePath) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading...
      </div>
    );
  }

  // Build output with relative resources: use file:// src so browser resolves paths
  if (artifact.filePath && artifact.content && hasRelativeResources(artifact.content)) {
    return (
      <iframe
        src={pathToFileUrl(artifact.filePath)}
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin"
        title={artifact.title}
      />
    );
  }

  // Self-contained HTML (no relative resources): use srcDoc
  return (
    <iframe
      srcDoc={processedHtml || artifact.content}
      className="w-full h-full border-0"
      sandbox="allow-scripts"
      title={artifact.title}
    />
  );
};

async function readLocalFileAsDataUrl(absPath: string): Promise<string | null> {
  if (typeof window.electron?.dialog?.readFileAsDataUrl !== 'function') return null;
  try {
    const res = await window.electron.dialog.readFileAsDataUrl(absPath);
    return res?.success && res.dataUrl ? res.dataUrl : null;
  } catch {
    return null;
  }
}

function resolveRelativePath(src: string, htmlDir: string): string | null {
  if (!src || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('blob:')) {
    return null;
  }
  return src.startsWith('/') ? src : htmlDir + src;
}

async function inlineLocalResources(html: string, filePath: string): Promise<string> {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastSlash <= 0) return html;
  const dir = filePath.slice(0, lastSlash + 1);

  const srcAttrs = /(?:src|data)=["']([^"']+)["']/gi;
  const matches = [...html.matchAll(srcAttrs)];
  const replacements: Array<[string, string]> = [];

  for (const match of matches) {
    const originalSrc = match[1];
    const absPath = resolveRelativePath(originalSrc, dir);
    if (!absPath) continue;

    const dataUrl = await readLocalFileAsDataUrl(absPath);
    if (dataUrl) {
      replacements.push([originalSrc, dataUrl]);
    }
  }

  let result = html;
  for (const [original, replacement] of replacements) {
    result = result.split(original).join(replacement);
  }

  return result;
}

export default HtmlRenderer;
