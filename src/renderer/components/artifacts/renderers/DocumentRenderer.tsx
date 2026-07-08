import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';
import { openLocalPathWithToast } from '@/utils/localFileActions';

import { getDocxExpectedPageCount, repaginateDocx, waitForDocxLayout } from './docxPagination';
import {
  type OfficePreviewZoomControlsConfig,
  useRegisterOfficePreviewZoomControls,
} from './OfficePreviewActionsContext';
import { useOfficePreviewZoom } from './OfficeZoomControls';
import { SheetRenderer } from './sheet/SheetRenderer';

const t = (key: string) => i18nService.t(key);

function getExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot === -1 ? '' : name.slice(lastDot).toLowerCase();
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function normalizeLocalFilePath(filePath: string): string {
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

function useFileContent(artifact: Artifact): { data: ArrayBuffer | null; loading: boolean; error: string | null } {
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

// --- Docx Sub-Renderer (docx-preview, high-fidelity rendering) ---

const DOCX_BASE_WIDTH = 794; // A4 width in px at 96dpi

const DocxSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const { data, loading, error: loadError } = useFileContent(artifact);
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const { zoomFactor, zoomIn, zoomOut, resetZoom, handleWheelZoom } = useOfficePreviewZoom();
  const zoomControls = useMemo<OfficePreviewZoomControlsConfig | null>(() => {
    if (!rendered || pageCount <= 0) return null;
    return {
      zoomFactor,
      onZoomOut: zoomOut,
      onZoomIn: zoomIn,
      onResetZoom: resetZoom,
    };
  }, [pageCount, rendered, resetZoom, zoomFactor, zoomIn, zoomOut]);

  useRegisterOfficePreviewZoomControls(zoomControls);

  useEffect(() => {
    if (loadError) { setError(loadError); return; }
    if (!data || !containerRef.current) return;

    let cancelled = false;

    const render = async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (cancelled || !containerRef.current) return;

        setError(null);
        setRendered(false);
        setPageCount(0);
        containerRef.current.innerHTML = '';
        const wordDocument = await renderAsync(data, containerRef.current, undefined, {
          className: 'docx-preview',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });

        await waitForDocxLayout(containerRef.current);
        if (cancelled || !containerRef.current) return;

        const paginationResult = repaginateDocx(containerRef.current, {
          expectedPageCount: getDocxExpectedPageCount(wordDocument),
        });
        const renderedPageCount = supplementDocxPageNumbers(containerRef.current) || paginationResult.pageCount;
        if (!cancelled) {
          setPageCount(renderedPageCount);
          setRendered(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    render();
    return () => { cancelled = true; };
  }, [data, loadError]);

  // Adaptive zoom based on container width
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !rendered) return;

    const updateZoom = () => {
      const containerWidth = wrapper.clientWidth - 48; // account for document gutter
      const fitScale = containerWidth < DOCX_BASE_WIDTH ? containerWidth / DOCX_BASE_WIDTH : 1;
      if (containerRef.current) {
        containerRef.current.style.zoom = String(fitScale * zoomFactor);
      }
    };

    const ro = new ResizeObserver(updateZoom);
    ro.observe(wrapper);
    updateZoom();

    return () => ro.disconnect();
  }, [rendered, zoomFactor]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm p-4">
        {t('artifactDocumentError')}: {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {t('artifactDocumentLoading')}
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-[#f5f5f5]">
      {rendered && pageCount > 0 && (
        <div className="shrink-0 border-b border-[#e0e0e0] px-3 py-1.5 text-xs text-[#999]">
          <span>{pageCount} {t('artifactPdfPageCount')}</span>
        </div>
      )}
      <div ref={wrapperRef} className="flex-1 overflow-auto" onWheel={handleWheelZoom}>
        <div ref={containerRef} className="docx-container" />
      </div>
      <style>{`
        .docx-container {
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          align-items: center;
          min-width: 100%;
          padding: 24px;
        }
        .docx-container .docx-preview-wrapper {
          background: transparent !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          width: max-content !important;
          min-width: 100% !important;
          font-family: initial !important;
          font-size: initial !important;
          line-height: normal !important;
          letter-spacing: normal !important;
        }
        .docx-container section.docx-preview {
          background: white !important;
          color: #000;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          margin: 0 auto 16px !important;
          border-radius: 2px;
          box-sizing: border-box;
          font-family: initial !important;
          font-size: initial !important;
          line-height: normal !important;
          letter-spacing: normal !important;
        }
        .docx-container .docx-preview table {
          width: auto;
          margin: 0;
        }
        .docx-container .docx-preview th,
        .docx-container .docx-preview td {
          padding: 0;
          border-color: currentColor;
        }
        .docx-container .docx-preview th {
          background-color: transparent;
          opacity: 1;
        }
      `}</style>
    </div>
  );
};

function supplementDocxPageNumbers(container: HTMLElement): number {
  const pages = Array.from(container.querySelectorAll<HTMLElement>('section.docx-preview'));
  const totalPages = pages.length;

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const scopes = Array.from(page.querySelectorAll<HTMLElement>('header, footer'));

    scopes.forEach(scope => {
      const textBlocks = Array.from(scope.querySelectorAll<HTMLElement>('p'));
      const targets = textBlocks.length > 0 ? textBlocks : [scope];

      targets.forEach(target => {
        const originalText = target.textContent || '';
        const supplementedText = supplementDocxPageNumberText(originalText, pageNumber, totalPages);
        if (supplementedText !== originalText) {
          target.textContent = supplementedText;
        }
      });
    });
  });

  return totalPages;
}

function supplementDocxPageNumberText(text: string, pageNumber: number, totalPages: number): string {
  let result = text;
  result = result.replace(/第\s*页/g, `第 ${pageNumber} 页`);
  result = result.replace(/共\s*页/g, `共 ${totalPages} 页`);

  if (/^\s*Page\s*of\s*$/i.test(result)) {
    return result.replace(/Page\s*of/i, `Page ${pageNumber} of ${totalPages}`);
  }

  if (/^\s*Page\s*$/i.test(result)) {
    return result.replace(/Page/i, `Page ${pageNumber}`);
  }

  return result;
}

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

// --- Pptx Sub-Renderer ---

const PPTX_IMAGE_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const PPTX_MEDIA_DIR = 'ppt/media/';
const PPTX_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PPTX_PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const PPTX_IMAGE_CONTENT_TYPES: Record<string, string> = {
  bmp: 'image/bmp',
  emf: 'image/x-emf',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  wmf: 'image/x-wmf',
};

function getRelationshipSourceDir(relsPath: string): string {
  const sourcePath = relsPath.replace('/_rels/', '/').replace(/\.rels$/, '');
  const lastSlash = sourcePath.lastIndexOf('/');
  return lastSlash >= 0 ? sourcePath.slice(0, lastSlash) : '';
}

function normalizeZipPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function resolveRelationshipTarget(relsPath: string, target: string): string {
  const decodedTarget = decodeRelationshipTarget(target);
  if (decodedTarget.startsWith('/')) return normalizeZipPath(decodedTarget.slice(1));

  const sourceDir = getRelationshipSourceDir(relsPath);
  return normalizeZipPath(sourceDir ? `${sourceDir}/${decodedTarget}` : decodedTarget);
}

function getRelativeZipPath(fromDir: string, toPath: string): string {
  const fromParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const toParts = toPath.split('/').filter(Boolean);

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  return [...fromParts.map(() => '..'), ...toParts].join('/');
}

function getFileExtension(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : '';
}

function decodeRelationshipTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

function findZipPath(zip: { files: Record<string, { dir?: boolean }>; file(path: string): unknown }, path: string): string | null {
  if (zip.file(path)) return path;

  const lowerPath = path.toLowerCase();
  return Object.keys(zip.files).find(candidate => !zip.files[candidate].dir && candidate.toLowerCase() === lowerPath) || null;
}

function detectImageExtension(bytes: Uint8Array, fallbackExtension: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return '.png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return '.gif';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return '.bmp';
  }
  return fallbackExtension.toLowerCase();
}

function createPptxPreviewMediaPath(zip: { file(path: string): unknown }, index: number, extension: string): string {
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  let candidate = `${PPTX_MEDIA_DIR}image_lobster_${index}${normalizedExtension}`;
  let suffix = 1;

  while (zip.file(candidate)) {
    candidate = `${PPTX_MEDIA_DIR}image_lobster_${index}_${suffix}${normalizedExtension}`;
    suffix += 1;
  }

  return candidate;
}

function ensureContentTypeDefaults(contentTypesXml: string, extensions: Set<string>): string {
  const defaults = new Set<string>();
  contentTypesXml.replace(/<Default\b[^>]*\bExtension="([^"]+)"/g, (_entry, extension: string) => {
    defaults.add(extension.toLowerCase());
    return _entry;
  });

  const additions = Array.from(extensions)
    .map(extension => extension.replace(/^\./, '').toLowerCase())
    .filter(extension => PPTX_IMAGE_CONTENT_TYPES[extension] && !defaults.has(extension))
    .map(extension => (
      `<Default Extension="${extension}" ContentType="${PPTX_IMAGE_CONTENT_TYPES[extension]}"/>`
    ));

  if (additions.length === 0) return contentTypesXml;

  const insertion = additions.join('');
  if (contentTypesXml.includes('<Override')) {
    return contentTypesXml.replace('<Override', `${insertion}<Override`);
  }

  return contentTypesXml.replace('</Types>', `${insertion}</Types>`);
}

async function getPptxSlideSize(zip: { file(path: string): { async(type: 'string'): Promise<string> } | null }): Promise<{ cx: string; cy: string }> {
  const defaultSize = { cx: '9144000', cy: '5143500' };
  const presentationFile = zip.file('ppt/presentation.xml');
  if (!presentationFile) return defaultSize;

  const presentationXml = await presentationFile.async('string');
  const doc = new DOMParser().parseFromString(presentationXml, 'application/xml');
  const slideSize = doc.getElementsByTagName('p:sldSz')[0];
  if (!slideSize) return defaultSize;

  return {
    cx: slideSize.getAttribute('cx') || defaultSize.cx,
    cy: slideSize.getAttribute('cy') || defaultSize.cy,
  };
}

function getSlidePathFromRelsPath(relsPath: string): string | null {
  if (!relsPath.startsWith('ppt/slides/_rels/') || !relsPath.endsWith('.rels')) return null;
  return relsPath.replace('ppt/slides/_rels/', 'ppt/slides/').replace(/\.rels$/, '');
}

function getNextSlideShapeId(doc: Document): string {
  const ids = Array.from(doc.getElementsByTagName('p:cNvPr'))
    .map(node => Number(node.getAttribute('id') || '0'))
    .filter(Number.isFinite);
  return String(Math.max(0, ...ids) + 1);
}

function hasBackgroundFallback(doc: Document, relId: string): boolean {
  return Array.from(doc.getElementsByTagName('p:cNvPr')).some(node => (
    node.getAttribute('name') === `LobsterAI Background Fallback ${relId}`
  ));
}

function createElement(doc: Document, namespace: string, name: string, attrs: Record<string, string> = {}): Element {
  const element = doc.createElementNS(namespace, name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function createPictureBlipFill(doc: Document, backgroundBlipFill: Element): Element {
  const pictureBlipFill = createElement(doc, PPTX_PRESENTATION_NS, 'p:blipFill');
  Array.from(backgroundBlipFill.childNodes).forEach(child => {
    pictureBlipFill.appendChild(child.cloneNode(true));
  });

  return pictureBlipFill;
}

function createBackgroundFallbackPic(doc: Document, relId: string, blipFill: Element, size: { cx: string; cy: string }): Element {
  const pic = createElement(doc, PPTX_PRESENTATION_NS, 'p:pic');
  const nvPicPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:nvPicPr');
  const cNvPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:cNvPr', {
    id: getNextSlideShapeId(doc),
    name: `LobsterAI Background Fallback ${relId}`,
  });
  const cNvPicPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:cNvPicPr');
  const nvPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:nvPr');
  nvPicPr.append(cNvPr, cNvPicPr, nvPr);

  const fallbackBlipFill = createPictureBlipFill(doc, blipFill);
  const spPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:spPr');
  const xfrm = createElement(doc, PPTX_DRAWING_NS, 'a:xfrm');
  const off = createElement(doc, PPTX_DRAWING_NS, 'a:off', { x: '0', y: '0' });
  const ext = createElement(doc, PPTX_DRAWING_NS, 'a:ext', size);
  const prstGeom = createElement(doc, PPTX_DRAWING_NS, 'a:prstGeom', { prst: 'rect' });
  const avLst = createElement(doc, PPTX_DRAWING_NS, 'a:avLst');

  xfrm.append(off, ext);
  prstGeom.append(avLst);
  spPr.append(xfrm, prstGeom);
  pic.append(nvPicPr, fallbackBlipFill, spPr);

  return pic;
}

async function addBackgroundImageFallbacks(
  zip: { file(path: string, data?: string): { async(type: 'string'): Promise<string> } | null },
  relsToFallbackRelIds: Map<string, Set<string>>,
): Promise<void> {
  if (relsToFallbackRelIds.size === 0) return;

  const slideSize = await getPptxSlideSize(zip);

  for (const [relsPath, relIds] of relsToFallbackRelIds) {
    const slidePath = getSlidePathFromRelsPath(relsPath);
    if (!slidePath) continue;

    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;

    const slideXml = await slideFile.async('string');
    const doc = new DOMParser().parseFromString(slideXml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) continue;

    const spTree = doc.getElementsByTagName('p:spTree')[0];
    const grpSpPr = doc.getElementsByTagName('p:grpSpPr')[0];
    if (!spTree || !grpSpPr) continue;

    let changed = false;
    const backgroundBlipFills = Array.from(doc.getElementsByTagName('p:bgPr'))
      .map(bgPr => bgPr.getElementsByTagName('a:blipFill')[0])
      .filter((blipFill): blipFill is Element => Boolean(blipFill));

    for (const blipFill of backgroundBlipFills) {
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed');
      if (!relId || !relIds.has(relId) || hasBackgroundFallback(doc, relId)) continue;

      const fallbackPic = createBackgroundFallbackPic(doc, relId, blipFill, slideSize);
      spTree.insertBefore(fallbackPic, grpSpPr.nextSibling);
      changed = true;
    }

    if (changed) {
      zip.file(slidePath, new XMLSerializer().serializeToString(doc));
    }
  }
}

/**
 * Fix PPTX files before passing them to pptx-preview:
 * 1. Re-compress with Deflate (some are stored uncompressed)
 * 2. Remove Content_Types.xml entries that reference non-existent files
 * 3. Copy non-standard media names to ppt/media/image* because pptx-preview only preloads that prefix
 */
async function fixPptxData(data: ArrayBuffer): Promise<ArrayBuffer> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);

  // Fix Content_Types.xml: remove Override entries for missing files.
  const ctFile = zip.file('[Content_Types].xml');
  let contentTypesXml: string | null = null;
  if (ctFile) {
    let ct = await ctFile.async('string');
    const overrideRe = /<Override[^>]+PartName="([^"]+)"[^>]*\/>/g;
    const toRemove: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = overrideRe.exec(ct)) !== null) {
      const partName = match[1];
      const zipPath = partName.startsWith('/') ? partName.slice(1) : partName;
      if (!zip.file(zipPath)) {
        toRemove.push(match[0]);
      }
    }
    for (const entry of toRemove) {
      ct = ct.replace(entry, '');
    }
    contentTypesXml = ct;
  }

  const mediaPathMap = new Map<string, string>();
  const addedMediaExtensions = new Set<string>();
  const backgroundFallbackRelIds = new Map<string, Set<string>>();
  let normalizedMediaIndex = 1;

  for (const relsPath of Object.keys(zip.files).filter(path => path.endsWith('.rels'))) {
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;

    const relsXml = await relsFile.async('string');
    const doc = new DOMParser().parseFromString(relsXml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) continue;

    const sourceDir = getRelationshipSourceDir(relsPath);
    const relationships = Array.from(doc.getElementsByTagName('Relationship'));
    let changed = false;

    for (const relationship of relationships) {
      if (relationship.getAttribute('Type') !== PPTX_IMAGE_RELATIONSHIP_TYPE) continue;
      if (relationship.getAttribute('TargetMode') === 'External') continue;

      const target = relationship.getAttribute('Target');
      if (!target) continue;

      const resolvedTarget = resolveRelationshipTarget(relsPath, target);
      const mediaPath = findZipPath(zip, resolvedTarget);
      if (!mediaPath || !mediaPath.toLowerCase().startsWith(PPTX_MEDIA_DIR)) continue;

      const basename = mediaPath.slice(PPTX_MEDIA_DIR.length);
      if (mediaPath.startsWith(PPTX_MEDIA_DIR) && basename.startsWith('image')) {
        const normalizedTarget = getRelativeZipPath(sourceDir, mediaPath);
        if (normalizedTarget !== target) {
          relationship.setAttribute('Target', normalizedTarget);
          changed = true;
        }
        continue;
      }

      const mediaFile = zip.file(mediaPath);
      if (!mediaFile) continue;

      let normalizedTarget = mediaPathMap.get(mediaPath);
      if (!normalizedTarget) {
        const mediaData = await mediaFile.async('arraybuffer');
        const extension = detectImageExtension(new Uint8Array(mediaData), getFileExtension(mediaPath));
        normalizedTarget = createPptxPreviewMediaPath(zip, normalizedMediaIndex, extension || '.png');
        normalizedMediaIndex += 1;
        mediaPathMap.set(mediaPath, normalizedTarget);
        addedMediaExtensions.add(getFileExtension(normalizedTarget));
        zip.file(normalizedTarget, mediaData);
      }

      const relId = relationship.getAttribute('Id');
      if (relId) {
        if (!backgroundFallbackRelIds.has(relsPath)) {
          backgroundFallbackRelIds.set(relsPath, new Set());
        }
        backgroundFallbackRelIds.get(relsPath)?.add(relId);
      }

      relationship.setAttribute('Target', getRelativeZipPath(sourceDir, normalizedTarget));
      changed = true;
    }

    if (changed) {
      zip.file(relsPath, new XMLSerializer().serializeToString(doc));
    }
  }

  await addBackgroundImageFallbacks(zip, backgroundFallbackRelIds);

  if (contentTypesXml !== null) {
    zip.file('[Content_Types].xml', ensureContentTypeDefaults(contentTypesXml, addedMediaExtensions));
  }

  // Re-generate with Deflate compression
  return await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

const LegacyPptxSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const { data, loading, error: loadError } = useFileContent(artifact);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mainPreviewerRef = useRef<{ slideCount?: number; destroy?: () => void } | null>(null);
  const thumbnailPreviewerRef = useRef<{ slideCount?: number; destroy?: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [slideCount, setSlideCount] = useState(0);
  const [effectiveZoomFactor, setEffectiveZoomFactor] = useState(1);
  const { zoomFactor, zoomIn, zoomOut, resetZoom, handleWheelZoom, handleNativeWheelZoom } = useOfficePreviewZoom();
  const zoomControls = useMemo<OfficePreviewZoomControlsConfig | null>(() => {
    if (slideCount <= 0) return null;
    return {
      zoomFactor,
      displayZoomFactor: effectiveZoomFactor,
      onZoomOut: zoomOut,
      onZoomIn: zoomIn,
      onResetZoom: resetZoom,
    };
  }, [effectiveZoomFactor, resetZoom, slideCount, zoomFactor, zoomIn, zoomOut]);

  useRegisterOfficePreviewZoomControls(zoomControls);

  const PPTX_RENDER_WIDTH = 600;
  const PPTX_THUMBNAIL_WIDTH = 150;
  const PPTX_AUTO_FIT_USAGE = 0.86;
  const PPTX_MAX_AUTO_FIT_SCALE = 1.7;

  useEffect(() => {
    if (loadError) { setError(loadError); return; }
    if (!data) return;

    let cancelled = false;

    const render = async () => {
      try {
        const pptxPreview = await import('pptx-preview');
        const iframe = iframeRef.current;
        const iframeDoc = iframe?.contentDocument || iframe?.contentWindow?.document;
        if (cancelled || !iframeDoc) return;

        // Fix the PPTX data before passing to pptx-preview
        const fixedData = await fixPptxData(data);
        if (cancelled) return;

        mainPreviewerRef.current?.destroy?.();
        thumbnailPreviewerRef.current?.destroy?.();
        mainPreviewerRef.current = null;
        thumbnailPreviewerRef.current = null;
        setRendered(false);
        setEffectiveZoomFactor(1);

        iframeDoc.open();
        iframeDoc.write(`<!DOCTYPE html><html><head><style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { width: 100%; min-height: 100%; background: #f3f4f6; }
          body { padding: 16px; overflow-y: auto; }
          #pptx-layout { width: 100%; min-height: 100px; }
          #pptx-thumbnails { display: none; }
          #pptx-main {
            width: 100%;
            min-width: 0;
            overflow: auto;
            --pptx-main-scale: 1;
            --pptx-main-width: 600px;
            --pptx-main-padding-y: 0px;
          }
          .pptx-preview-wrapper { background: transparent !important; width: 100% !important; max-width: 100% !important; height: auto !important; overflow: visible !important; }
          #pptx-main .pptx-preview-wrapper {
            width: var(--pptx-main-width) !important;
            max-width: none !important;
            margin: 0 auto !important;
            zoom: var(--pptx-main-scale);
          }
          .pptx-preview-wrapper > div { margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); border-radius: 4px; overflow: hidden; }
          .pptx-preview-wrapper > div:last-child { margin-bottom: 0; }
          canvas { width: 100% !important; height: auto !important; display: block; }
          @media (min-width: 760px) {
            html, body { height: 100%; min-height: 100%; overflow: hidden; }
            body { padding: 16px; }
            #pptx-layout {
              display: grid;
              grid-template-columns: 168px minmax(0, 1fr);
              gap: 16px;
              height: 100%;
              min-height: 0;
            }
            #pptx-thumbnails {
              display: block;
              min-height: 0;
              overflow-y: auto;
              padding: 2px 4px 2px 0;
            }
            #pptx-main {
              min-height: 0;
              overflow: auto;
              display: block;
              padding: var(--pptx-main-padding-y) 12px;
            }
            #pptx-main .pptx-preview-wrapper {
              width: var(--pptx-main-width) !important;
              max-width: none !important;
              margin: 0 auto !important;
              zoom: var(--pptx-main-scale);
            }
            #pptx-main .pptx-preview-wrapper > div {
              display: none;
              width: 100% !important;
              margin: 0 !important;
              box-shadow: 0 4px 18px rgba(0,0,0,0.18);
            }
            #pptx-main .pptx-preview-wrapper > div.is-active-slide {
              display: block;
            }
            #pptx-thumbnails .pptx-preview-wrapper > div {
              position: relative;
              width: 100% !important;
              margin: 0 0 10px !important;
              border: 2px solid transparent;
              border-radius: 6px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.12);
              cursor: pointer;
              opacity: 0.82;
              transition: border-color 120ms ease, opacity 120ms ease;
            }
            #pptx-thumbnails .pptx-preview-wrapper > div::before {
              content: attr(data-slide-number);
              position: absolute;
              left: 6px;
              top: 5px;
              z-index: 2;
              min-width: 18px;
              height: 18px;
              border-radius: 9px;
              background: rgba(17,24,39,0.72);
              color: #fff;
              font: 11px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              text-align: center;
            }
            #pptx-thumbnails .pptx-preview-wrapper > div.is-active-thumbnail {
              border-color: #3b82f6;
              opacity: 1;
            }
          }
        </style></head><body><div id="pptx-layout"><aside id="pptx-thumbnails"></aside><main id="pptx-main"></main></div></body></html>`);
        iframeDoc.close();

        const mainRoot = iframeDoc.getElementById('pptx-main');
        const thumbnailRoot = iframeDoc.getElementById('pptx-thumbnails');
        if (!mainRoot || !thumbnailRoot) {
          setError('render_failed');
          return;
        }

        const mainPreviewer = pptxPreview.init(mainRoot, { width: PPTX_RENDER_WIDTH, mode: 'list' });
        const thumbnailPreviewer = pptxPreview.init(thumbnailRoot, { width: PPTX_THUMBNAIL_WIDTH, mode: 'list' });
        mainPreviewerRef.current = mainPreviewer;
        thumbnailPreviewerRef.current = thumbnailPreviewer;
        await mainPreviewer.preview(fixedData);
        await thumbnailPreviewer.preview(fixedData.slice(0));

        if (cancelled) return;

        const mainSlides = Array.from(mainRoot.querySelectorAll('.pptx-preview-wrapper > div'));
        const thumbnailSlides = Array.from(thumbnailRoot.querySelectorAll('.pptx-preview-wrapper > div'));
        const count = mainPreviewer.slideCount || mainSlides.length || thumbnailSlides.length || 0;
        setSlideCount(count);

        if (count > 0 && !cancelled) {
          let selectedIndex = 0;
          const slideLabelTemplate = t('artifactSlideLabel');
          const setActiveSlide = (index: number) => {
            selectedIndex = Math.max(0, Math.min(index, count - 1));
            mainSlides.forEach((slide, slideIndex) => {
              slide.classList.toggle('is-active-slide', slideIndex === selectedIndex);
            });
            thumbnailSlides.forEach((slide, slideIndex) => {
              const isActive = slideIndex === selectedIndex;
              slide.classList.toggle('is-active-thumbnail', isActive);
              if (isActive) {
                slide.scrollIntoView({ block: 'nearest' });
              }
            });
          };

          mainSlides.forEach((slide, index) => {
            slide.classList.toggle('is-active-slide', index === selectedIndex);
          });
          thumbnailSlides.forEach((slide, index) => {
            const slideNumber = String(index + 1);
            slide.setAttribute('data-slide-number', slideNumber);
            slide.setAttribute('role', 'button');
            slide.setAttribute('tabindex', '0');
            slide.setAttribute('aria-label', slideLabelTemplate.replace('{n}', slideNumber));
            slide.addEventListener('click', () => setActiveSlide(index));
            slide.addEventListener('keydown', event => {
              const key = (event as KeyboardEvent).key;
              if (key === 'Enter' || key === ' ') {
                event.preventDefault();
                setActiveSlide(index);
              }
            });
            slide.classList.toggle('is-active-thumbnail', index === selectedIndex);
          });
          setRendered(true);
        } else {
          setError('render_failed');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    render();
    return () => {
      cancelled = true;
      mainPreviewerRef.current?.destroy?.();
      thumbnailPreviewerRef.current?.destroy?.();
      mainPreviewerRef.current = null;
      thumbnailPreviewerRef.current = null;
    };
  }, [data, loadError]);

  // Adaptive zoom for the rendered PPTX slides inside the iframe.
  useEffect(() => {
    const container = containerRef.current;
    const iframe = iframeRef.current;
    if (!container || !iframe || !rendered) return;

    const updateZoom = () => {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      const mainRoot = iframeDoc?.getElementById('pptx-main');
      if (!mainRoot) return;

      const mainStyle = iframe.contentWindow?.getComputedStyle(mainRoot);
      const horizontalPadding = (parseFloat(mainStyle?.paddingLeft || '0') || 0) + (parseFloat(mainStyle?.paddingRight || '0') || 0);
      const isDesktopLayout = Boolean(iframe.contentWindow?.matchMedia('(min-width: 760px)').matches);
      const minVerticalPadding = isDesktopLayout ? 12 : 0;
      const availableWidth = Math.max(160, mainRoot.clientWidth - horizontalPadding);
      const activeSlide = mainRoot.querySelector<HTMLElement>('.pptx-preview-wrapper > div.is-active-slide')
        || mainRoot.querySelector<HTMLElement>('.pptx-preview-wrapper > div');
      const previousSlideScale = parseFloat(mainStyle?.getPropertyValue('--pptx-main-scale') || '1') || 1;
      const baseSlideHeight = parseFloat(activeSlide?.style.height || '')
        || ((activeSlide?.getBoundingClientRect().height || 0) / previousSlideScale)
        || Math.round(PPTX_RENDER_WIDTH * 9 / 16);
      const availableHeight = Math.max(120, mainRoot.clientHeight - minVerticalPadding * 2);
      const widthFitScale = (availableWidth * PPTX_AUTO_FIT_USAGE) / PPTX_RENDER_WIDTH;
      const heightFitScale = (availableHeight * PPTX_AUTO_FIT_USAGE) / baseSlideHeight;
      const autoFitScale = isDesktopLayout
        ? Math.max(1, Math.min(PPTX_MAX_AUTO_FIT_SCALE, widthFitScale, heightFitScale))
        : Math.min(1, availableWidth / PPTX_RENDER_WIDTH);
      const slideScale = Number((autoFitScale * zoomFactor).toFixed(3));
      mainRoot.style.setProperty('--pptx-main-scale', String(slideScale));
      mainRoot.style.setProperty('--pptx-main-width', `${PPTX_RENDER_WIDTH}px`);
      setEffectiveZoomFactor(current => (Math.abs(current - slideScale) > 0.005 ? slideScale : current));

      const scaledSlideHeight = baseSlideHeight * slideScale;
      const centeredVerticalPadding = scaledSlideHeight > 0
        ? Math.max(minVerticalPadding, Math.floor((mainRoot.clientHeight - scaledSlideHeight) / 2))
        : minVerticalPadding;
      mainRoot.style.setProperty('--pptx-main-padding-y', `${centeredVerticalPadding}px`);
    };

    const ro = new ResizeObserver(updateZoom);
    ro.observe(container);
    updateZoom();

    return () => ro.disconnect();
  }, [rendered, zoomFactor]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !rendered) return;

    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!iframeDoc) return;

    iframeDoc.addEventListener('wheel', handleNativeWheelZoom, { passive: false });
    return () => {
      iframeDoc.removeEventListener('wheel', handleNativeWheelZoom);
    };
  }, [handleNativeWheelZoom, rendered]);

  // Fallback: HTML slides or text extraction when pptx-preview fails
  if (error === 'render_failed') {
    return <PptxHtmlFallback artifact={artifact} data={data!} />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm p-4">
        {t('artifactDocumentError')}: {error}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {slideCount > 0 && (
        <div className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-muted">
          <span>{t('artifactSlideCount').replace('{count}', String(slideCount))}</span>
        </div>
      )}
      <div ref={containerRef} className="flex-1 relative min-h-0" onWheel={handleWheelZoom}>
        {(loading || !rendered) && (
          <div className="absolute inset-0 flex items-center justify-center text-muted text-sm z-10 bg-background">
            {t('artifactDocumentLoading')}
          </div>
        )}
        <iframe
          ref={iframeRef}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
          title={artifact.title || 'PPTX Preview'}
        />
      </div>
    </div>
  );
};

const PptxSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  return <LegacyPptxSubRenderer artifact={artifact} />;
};

// HTML slides fallback: load slideN.html files from the same directory
const PptxHtmlFallback: React.FC<{ artifact: Artifact; data: ArrayBuffer }> = ({ artifact, data }) => {
  const [slideHtmls, setSlideHtmls] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [useTextFallback, setUseTextFallback] = useState(false);

  useEffect(() => {
    if (!artifact.filePath) { setUseTextFallback(true); setLoading(false); return; }

    let cancelled = false;

    const loadSlideHtmls = async () => {
      let filePath = artifact.filePath!;
      if (filePath.startsWith('file:///')) filePath = filePath.slice(7);
      else if (filePath.startsWith('file://')) filePath = filePath.slice(7);
      else if (filePath.startsWith('file:/')) filePath = filePath.slice(5);
      // Strip leading / before Windows drive letter
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);

      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      const slidesDir = `${dir}/slides`;
      const htmls: string[] = [];

      for (let i = 1; i <= 20; i++) {
        const slidePath = `${slidesDir}/slide${i}.html`;
        try {
          const result = await window.electron?.dialog?.readFileAsDataUrl(slidePath);
          if (!result?.success || !result.dataUrl) break;
          const base64 = result.dataUrl.split(',')[1] || '';
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          const html = new TextDecoder('utf-8').decode(bytes);
          htmls.push(html);
        } catch {
          break;
        }
      }

      if (cancelled) return;

      if (htmls.length > 0) {
        setSlideHtmls(htmls);
      } else {
        setUseTextFallback(true);
      }
      setLoading(false);
    };

    loadSlideHtmls();
    return () => { cancelled = true; };
  }, [artifact.filePath]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted text-sm">{t('artifactDocumentLoading')}</div>;
  }

  if (useTextFallback) {
    return <PptxTextFallback data={data} />;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-border shrink-0">
        {t('artifactSlideCount').replace('{count}', String(slideHtmls.length))}
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4 bg-[#f3f4f6]">
        {slideHtmls.map((html, i) => (
          <div key={i} className="shadow-lg rounded overflow-hidden">
            <iframe
              srcDoc={html}
              className="w-full border-0 rounded"
              style={{ aspectRatio: '16/9' }}
              sandbox="allow-scripts allow-same-origin"
              title={`Slide ${i + 1}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

// Text extraction fallback for PPTX
interface SlideContent { index: number; texts: string[]; }

async function parsePptxSlides(data: ArrayBuffer): Promise<SlideContent[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return na - nb;
    });

  const slides: SlideContent[] = [];
  const textRe = /<a:t>([^<]*)<\/a:t>/g;

  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i])!.async('string');
    const texts: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = textRe.exec(xml)) !== null) {
      if (match[1].trim()) texts.push(match[1]);
    }
    textRe.lastIndex = 0;
    slides.push({ index: i + 1, texts });
  }
  return slides;
}

const PptxTextFallback: React.FC<{ data: ArrayBuffer }> = ({ data }) => {
  const [slides, setSlides] = useState<SlideContent[]>([]);
  const [parsed, setParsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    parsePptxSlides(data).then(result => {
      if (!cancelled) { setSlides(result); setParsed(true); }
    }).catch(() => { if (!cancelled) setParsed(true); });
    return () => { cancelled = true; };
  }, [data]);

  if (!parsed) {
    return <div className="flex items-center justify-center h-full text-muted text-sm">{t('artifactDocumentLoading')}</div>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-border shrink-0">
        {t('artifactSlideCount').replace('{count}', String(slides.length))}
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {slides.map(slide => (
          <div key={slide.index} className="border border-border rounded-lg p-4 bg-surface">
            <div className="text-xs text-muted mb-2 font-medium">
              {t('artifactSlideLabel').replace('{n}', String(slide.index))}
            </div>
            {slide.texts.length > 0 ? (
              <div className="space-y-1">
                {slide.texts.map((text, i) => (
                  <div key={i} className="text-sm text-foreground">{text}</div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted italic">{t('artifactSlideNoText')}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
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
}

const DocumentRenderer: React.FC<DocumentRendererProps> = ({ artifact }) => {
  const ext = getExtension(artifact.fileName || artifact.filePath || '');

  switch (ext) {
    case '.docx':
      return <DocxSubRenderer artifact={artifact} />;
    case '.xlsx':
    case '.xls':
    case '.csv':
    case '.tsv':
      return <SheetRenderer artifact={artifact} />;
    case '.pdf':
      return <PdfSubRenderer artifact={artifact} />;
    case '.pptx':
      return <PptxSubRenderer artifact={artifact} />;
    default:
      return <FileInfoFallback artifact={artifact} />;
  }
};

export default DocumentRenderer;
