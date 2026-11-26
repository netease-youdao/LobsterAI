import React, { useEffect, useMemo, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { getSheetPreviewKey, isDelimitedTextFile } from '@/services/office/sheet/sheetPreview';
import type { Artifact } from '@/types/artifact';

import { DelimitedTextPreview } from './DelimitedTextPreview';
import { getSheetFileName } from './excelPreprocess';
import { SheetFallbackRenderer } from './SheetFallbackRenderer';

const t = (key: string) => i18nService.t(key);

interface SheetRendererProps {
  artifact: Artifact;
}

export const SheetRenderer: React.FC<SheetRendererProps> = ({ artifact }) => {
  const fileKey = getSheetPreviewKey(artifact.sessionId, artifact.filePath ? normalizeFilePath(artifact.filePath) : undefined, artifact.id);
  // A new file gets fresh loading/parse state immediately, while its encoding choice is remembered.
  return <SheetFilePreview key={fileKey} artifact={artifact} fileKey={fileKey} />;
};

const SheetFilePreview: React.FC<SheetRendererProps & { fileKey: string }> = ({ artifact, fileKey }) => {
  const { data, loading, error } = useSheetFileContent(artifact);
  const fileName = getSheetFileName(artifact.fileName, artifact.filePath);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {t('artifactDocumentLoading')}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-red-500">
        {t('artifactDocumentError')}: {error || t('artifactNoPreview')}
      </div>
    );
  }

  return isDelimitedTextFile(fileName)
    ? <DelimitedTextPreview key={fileKey} data={data} fileName={fileName} fileKey={fileKey} />
    : <SheetFallbackRenderer data={data} fileName={fileName} />;
};

interface SheetFileContent {
  data: ArrayBuffer | null;
  loading: boolean;
  error: string | null;
}

function useSheetFileContent(artifact: Artifact): SheetFileContent {
  const request = useMemo(() => ({ content: artifact.content, filePath: artifact.filePath, version: artifact.contentVersion }),
    [artifact.content, artifact.filePath, artifact.contentVersion]);
  const [loaded, setLoaded] = useState<{ request: typeof request; result: SheetFileContent } | null>(null);
  // Inline bytes belong to the current render, not to a later effect. This also keeps the grid
  // mounted (and its zoom intact) when a refresh replaces one inline snapshot with another.
  const inline = useMemo<SheetFileContent | null>(() => {
    if (!request.content) return null;
    try {
      return { data: dataUrlToArrayBuffer(request.content), loading: false, error: null };
    } catch (e) {
      return { data: null, loading: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [request]);

  useEffect(() => {
    if (request.content) return;
    let cancelled = false;
    const finish = (data: ArrayBuffer | null, error: string | null) => {
      if (!cancelled) setLoaded({ request, result: { data, error, loading: false } });
    };

    const load = async () => {
      if (request.filePath && window.electron?.dialog?.readFileAsDataUrl) {
        try {
          const result = await window.electron.dialog.readFileAsDataUrl(normalizeFilePath(request.filePath));
          if (cancelled) return;
          if (result?.success && result.dataUrl) {
            finish(dataUrlToArrayBuffer(result.dataUrl), null);
          } else {
            finish(null, result?.error || t('artifactSourceLoadFailed'));
          }
        } catch (e) {
          finish(null, e instanceof Error ? e.message : String(e));
        }
        return;
      }

      finish(null, t('artifactNoPreview'));
    };

    load();
    return () => { cancelled = true; };
  }, [request]);

  if (inline) return inline;
  // Invalidate during render, before passive effects start the next read. A finished request
  // cannot display cells or errors under a different snapshot/version, even for the same file.
  return loaded?.request === request ? loaded.result : { data: null, loading: true, error: null };
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function normalizeFilePath(filePath: string): string {
  let normalized = filePath;
  if (normalized.startsWith('file:///')) normalized = normalized.slice(7);
  else if (normalized.startsWith('file://')) normalized = normalized.slice(7);
  else if (normalized.startsWith('file:/')) normalized = normalized.slice(5);
  if (/^\/[A-Za-z]:/.test(normalized)) normalized = normalized.slice(1);
  return normalized;
}
