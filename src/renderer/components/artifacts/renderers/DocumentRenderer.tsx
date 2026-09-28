import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';
import { openLocalPathWithToast } from '@/utils/localFileActions';

import type { ArtifactSelectedTextContext } from '../artifactSelectedText';
import { getExtension, normalizeLocalFilePath, useFileContent } from './documentFileContent';
import { type OfficePreviewZoomControlsConfig, useRegisterOfficePreviewZoomControls } from './office/common/OfficePreviewActionsContext';
import { useOfficePreviewZoom } from './office/common/OfficeZoomControls';
import { officeDocumentView } from './office/officeEditors';
import { SheetRenderer } from './office/sheet/SheetRenderer';

const t = (key: string) => i18nService.t(key);

// --- Pdf Sub-Renderer (pdfjs-dist, lazy page rendering) ---

const PDF_PAGE_GAP = 16;

function getPdfJsAssetUrl(assetPath: string): string {
  if (import.meta.env.DEV) {
    return new URL(`/pdfjs/${assetPath}`, window.location.origin).href;
  }

  return new URL(`../pdfjs/${assetPath}`, import.meta.url).href;
}

const PdfCanvasSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const { data, loading, error: loadError } = useFileContent(artifact);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [renderWidth, setRenderWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const { zoomFactor, zoomIn, zoomOut, resetZoom, handleWheelZoom } = useOfficePreviewZoom();
  const zoomControls = useMemo<OfficePreviewZoomControlsConfig | null>(() => {
    if (!pdfDoc || pageCount <= 0) return null;
    return {
      zoomFactor,
      onZoomOut: zoomOut,
      onZoomIn: zoomIn,
      onResetZoom: resetZoom,
    };
  }, [pageCount, pdfDoc, resetZoom, zoomFactor, zoomIn, zoomOut]);

  useRegisterOfficePreviewZoomControls(zoomControls);

  // Measure container width once it's laid out (debounced)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const measure = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const w = container.clientWidth - 48;
        if (w > 0 && Math.abs(w - renderWidth) > 5) setRenderWidth(w);
      }, 200);
    };

    // Initial measure without debounce
    const w = container.clientWidth - 48;
    if (w > 0) setRenderWidth(w);

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [renderWidth, pdfDoc]);

  // Load PDF document
  useEffect(() => {
    if (loadError) { setError(loadError); return; }
    if (!data) return;

    let cancelled = false;

    const loadPdf = async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

        const pdf = await pdfjsLib.getDocument({
          data: new Uint8Array(data),
          cMapUrl: getPdfJsAssetUrl('cmaps/'),
          cMapPacked: true,
          standardFontDataUrl: getPdfJsAssetUrl('standard_fonts/'),
          disableFontFace: false,
          useSystemFonts: true,
        }).promise;
        if (cancelled) return;

        setPdfDoc(pdf);
        setPageCount(pdf.numPages);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    loadPdf();
    return () => { cancelled = true; };
  }, [data, loadError]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm p-4">
        {t('artifactDocumentError')}: {error}
      </div>
    );
  }

  if (loading || !pdfDoc) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {t('artifactDocumentLoading')}
      </div>
    );
  }

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const zoomedRenderWidth = Math.max(120, Math.floor(renderWidth * zoomFactor));

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-[#f5f5f5]">
      <div className="shrink-0 border-b border-[#e0e0e0] px-3 py-1.5 text-xs text-[#999]">
        <span>{pageCount} {t('artifactPdfPageCount')}</span>
      </div>
      <div ref={containerRef} className="flex-1 overflow-auto p-6" onWheel={handleWheelZoom}>
        {renderWidth > 0 && pages.map(pageNum => (
          <div key={pageNum} style={{ marginBottom: PDF_PAGE_GAP }}>
            <PdfPageCanvas pdfDoc={pdfDoc} pageNumber={pageNum} width={zoomedRenderWidth} />
          </div>
        ))}
      </div>
    </div>
  );
};

const PdfPageCanvas: React.FC<{
  pdfDoc: unknown;
  pageNumber: number;
  width: number;
}> = ({ pdfDoc, pageNumber, width }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfDoc || width <= 0) return;

    // Cancel any in-progress render on this canvas
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    let cancelled = false;

    const renderPage = async () => {
      try {
        const page = await (pdfDoc as any).getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: 1 });
        const scale = width / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(scaledViewport.width * dpr);
        canvas.height = Math.floor(scaledViewport.height * dpr);
        canvas.style.width = `${Math.floor(scaledViewport.width)}px`;
        canvas.style.height = `${Math.floor(scaledViewport.height)}px`;
        setHeight(Math.floor(scaledViewport.height));

        const ctx = canvas.getContext('2d');
        if (!ctx || cancelled) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderTask = page.render({ canvasContext: ctx, viewport: scaledViewport });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        renderTaskRef.current = null;
      } catch (e) {
        // Ignore cancellation errors
        if (e instanceof Error && e.message.includes('Rendering cancelled')) return;
      }
    };

    renderPage();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pdfDoc, pageNumber, width]);

  return (
    <canvas
      ref={canvasRef}
      className="mx-auto block bg-white shadow-md rounded-sm"
      style={{ minHeight: height || 200 }}
    />
  );
};

const NativePdfSubRenderer: React.FC<{ artifact: Artifact; onFallback: () => void }> = ({ artifact, onFallback }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useRegisterOfficePreviewZoomControls(null);

  useEffect(() => {
    if (!artifact.filePath || !window.electron?.artifact?.createPreviewSession) {
      onFallback();
      return;
    }

    let cancelled = false;
    let sessionId: string | null = null;

    const createSession = async () => {
      try {
        setLoading(true);
        const filePath = normalizeLocalFilePath(artifact.filePath!);
        const result = await window.electron?.artifact?.createPreviewSession(filePath);
        if (cancelled) {
          if (result?.success && result.sessionId) {
            void window.electron?.artifact?.destroyPreviewSession(result.sessionId);
          }
          return;
        }

        if (!result?.success || !result.url || !result.sessionId) {
          throw new Error(result?.error || t('artifactDocumentError'));
        }

        sessionId = result.sessionId;
        setPreviewUrl(`${result.url}#toolbar=0&navpanes=0`);
        setLoading(false);
      } catch {
        if (!cancelled) {
          onFallback();
        }
      }
    };

    createSession();

    return () => {
      cancelled = true;
      if (sessionId) {
        void window.electron?.artifact?.destroyPreviewSession(sessionId);
      }
    };
  }, [artifact.contentVersion, artifact.filePath, onFallback]);

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-[#f5f5f5]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
          {t('artifactDocumentLoading')}
        </div>
      )}
      {previewUrl && (
        <iframe
          src={previewUrl}
          className="w-full h-full border-0"
          title={artifact.title || artifact.fileName || t('artifactDocumentPreviewTitle')}
          onError={onFallback}
        />
      )}
    </div>
  );
};

const PdfSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const [useCanvasFallback, setUseCanvasFallback] = useState(false);

  useEffect(() => {
    setUseCanvasFallback(false);
  }, [artifact.contentVersion, artifact.filePath]);

  const handleFallback = useCallback(() => {
    setUseCanvasFallback(true);
  }, []);

  if (!artifact.filePath || artifact.content || useCanvasFallback) {
    return <PdfCanvasSubRenderer artifact={artifact} />;
  }

  return <NativePdfSubRenderer artifact={artifact} onFallback={handleFallback} />;
};

// --- Fallback Sub-Renderer ---

const FileInfoFallback: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const ext = getExtension(artifact.fileName || artifact.filePath || '');

  const handleOpenWithApp = useCallback(() => {
    if (artifact.filePath) {
      void openLocalPathWithToast(artifact.filePath);
    }
  }, [artifact.filePath]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
      <div className="text-5xl">
        {ext === '.pptx' ? '📊' : ext === '.xlsx' ? '📑' : '📄'}
      </div>
      <div className="text-center">
        <div className="text-sm font-medium">{artifact.fileName || artifact.title}</div>
        <div className="text-xs text-muted mt-1">{ext.toUpperCase().slice(1)}</div>
      </div>
      {artifact.filePath && (
        <button
          onClick={handleOpenWithApp}
          className="px-3 py-1.5 text-xs rounded bg-primary text-white hover:bg-primary/90 transition-colors mt-2"
        >
          {t('artifactOpenWithApp')}
        </button>
      )}
    </div>
  );
};

// --- Main Document Renderer ---

interface DocumentRendererProps {
  artifact: Artifact;
  /** Takes excerpts for the task chat ("Add to chat"). */
  selectedTextContext?: ArtifactSelectedTextContext;
}

const DocumentRenderer: React.FC<DocumentRendererProps> = ({ artifact, selectedTextContext }) => {
  const office = officeDocumentView(artifact, selectedTextContext);
  if (office) return office;
  switch (getExtension(artifact.fileName || artifact.filePath || '')) {
    case '.xls':
    case '.csv':
    case '.tsv':
      return <SheetRenderer artifact={artifact} />;
    case '.pdf':
      return <PdfSubRenderer artifact={artifact} />;
    default:
      return <FileInfoFallback artifact={artifact} />;
  }
};

export default DocumentRenderer;
