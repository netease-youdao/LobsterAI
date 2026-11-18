import React, { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import { useFileContent } from '../../documentFileContent';
import { type OfficePreviewZoomControlsConfig, useRegisterOfficePreviewZoomControls } from '../common/OfficePreviewActionsContext';
import { useOfficePreviewZoom } from '../common/OfficeZoomControls';
import { getDocxExpectedPageCount, repaginateDocx, waitForDocxLayout } from './docxPagination';

const t = (key: string) => i18nService.t(key);

const DOCX_BASE_WIDTH = 794; // A4 width in px at 96dpi

/** Read-only .docx preview (docx-preview, high-fidelity rendering with true pagination). */
export const DocxPreview: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
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
