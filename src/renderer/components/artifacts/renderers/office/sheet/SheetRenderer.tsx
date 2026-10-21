import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import { getSheetFileName } from './excelPreprocess';
import { SheetFallbackRenderer } from './SheetFallbackRenderer';

const t = (key: string) => i18nService.t(key);

interface SheetRendererProps {
  artifact: Artifact;
}

export const SheetRenderer: React.FC<SheetRendererProps> = ({ artifact }) => {
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

  return <SheetFallbackRenderer data={data} fileName={fileName} error={error} />;
};

function useSheetFileContent(artifact: Artifact): { data: ArrayBuffer | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setData(null);

      if (artifact.content) {
        try {
          const buf = dataUrlToArrayBuffer(artifact.content);
          if (!cancelled) setData(buf);
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      if (artifact.filePath && window.electron?.dialog?.readFileAsDataUrl) {
        try {
          const result = await window.electron.dialog.readFileAsDataUrl(normalizeFilePath(artifact.filePath));
          if (cancelled) return;
          if (result?.success && result.dataUrl) {
            setData(dataUrlToArrayBuffer(result.dataUrl));
          } else {
            setError(result?.error || 'Failed to read file');
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      setError('No content available');
      setLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [artifact.content, artifact.filePath]);

  return { data, loading, error };
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
