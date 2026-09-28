import { useEffect, useState } from 'react';

import type { Artifact } from '@/types/artifact';

export function getExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot === -1 ? '' : name.slice(lastDot).toLowerCase();
}

export function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function normalizeLocalFilePath(filePath: string): string {
  let normalized = filePath;
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file:/')) {
    normalized = normalized.slice(5);
  }

  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

/** The bytes of a document artifact, from its inline content or its local file. */
export function useFileContent(artifact: Artifact): { data: ArrayBuffer | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (artifact.content) {
        try {
          const buf = dataUrlToArrayBuffer(artifact.content);
          if (!cancelled) { setData(buf); setLoading(false); }
        } catch (e) {
          if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
        }
        return;
      }

      if (artifact.filePath && window.electron?.dialog?.readFileAsDataUrl) {
        const filePath = normalizeLocalFilePath(artifact.filePath);
        try {
          const result = await window.electron.dialog.readFileAsDataUrl(filePath);
          if (cancelled) return;
          if (result?.success && result.dataUrl) {
            const buf = dataUrlToArrayBuffer(result.dataUrl);
            setData(buf);
          } else {
            setError(result?.error || 'Failed to read file');
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
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
