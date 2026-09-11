import React, { useMemo } from 'react';

import MarkdownContent from '@/components/MarkdownContent';
import type { Artifact } from '@/types/artifact';

import { CoworkSelectedTextSource } from '../../../../shared/cowork/selectedText';
import {
  type ArtifactSelectedTextContext,
  useArtifactSelectedTextAction,
} from '../artifactSelectedText';

interface MarkdownRendererProps {
  artifact: Artifact;
  selectedTextContext?: ArtifactSelectedTextContext;
}

const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const isWindowsAbsolutePath = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value);

const isAbsoluteLocalPath = (value: string): boolean => {
  return value.startsWith('/') || isWindowsAbsolutePath(value);
};

const normalizeLocalPath = (value: string): string | null => {
  const trimmed = stripHashAndQuery(value.trim());
  if (!trimmed) return null;
  if (/^(?:https?|data|blob|mailto|tel):/i.test(trimmed)) return null;

  const hasProtocol = /^([a-z][a-z0-9+.-]*):/i.test(trimmed);
  if (hasProtocol && !/^(?:file|localfile):/i.test(trimmed) && !isWindowsAbsolutePath(trimmed)) {
    return null;
  }

  let normalized = trimmed.replace(/^(?:file|localfile):\/\//i, '');
  if (normalized.startsWith('file:/')) {
    normalized = normalized.slice(5);
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  return safeDecodeURIComponent(normalized).replace(/\\/g, '/');
};

const getDirectoryPath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return index === 0 ? '/' : '';
  }
  return normalized.slice(0, index);
};

const normalizeDotSegments = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  let prefix = '';
  let rest = normalized;

  if (/^[A-Za-z]:\//.test(normalized)) {
    prefix = normalized.slice(0, 3);
    rest = normalized.slice(3);
  } else if (normalized.startsWith('/')) {
    prefix = '/';
    rest = normalized.slice(1);
  }

  const parts: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0) {
        parts.pop();
      } else if (!prefix) {
        parts.push(segment);
      }
      continue;
    }
    parts.push(segment);
  }

  return `${prefix}${parts.join('/')}`;
};

const joinLocalPath = (baseDir: string, relativePath: string): string => {
  if (isAbsoluteLocalPath(relativePath)) {
    return normalizeDotSegments(relativePath);
  }
  return normalizeDotSegments(`${baseDir.replace(/\/+$/, '')}/${relativePath}`);
};

const createMarkdownFileResolver = (
  filePath?: string
): ((href: string, text: string) => string | null) | undefined => {
  if (!filePath) return undefined;

  const markdownPath = normalizeLocalPath(filePath);
  if (!markdownPath) return undefined;

  const baseDir = getDirectoryPath(markdownPath);
  if (!baseDir) return undefined;

  return (href: string, _text: string): string | null => {
    const localPath = normalizeLocalPath(href);
    if (!localPath) return null;
    return joinLocalPath(baseDir, localPath);
  };
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ artifact, selectedTextContext }) => {
  const resolveLocalFilePath = useMemo(
    () => createMarkdownFileResolver(artifact.filePath),
    [artifact.filePath]
  );
  const { actionButton, containerRef, handleMouseUp } = useArtifactSelectedTextAction({
    artifact,
    sourceType: CoworkSelectedTextSource.ArtifactMarkdown,
    selectedTextContext,
  });

  if (!artifact.content) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No content
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onMouseUp={handleMouseUp}
      className="relative h-full overflow-auto p-6"
    >
      {actionButton}
      <MarkdownContent
        content={artifact.content}
        fileAccess={artifact.fileAccess}
        resolveLocalFilePath={resolveLocalFilePath}
        enableLargePreview={false}
      />
    </div>
  );
};

export default MarkdownRenderer;
