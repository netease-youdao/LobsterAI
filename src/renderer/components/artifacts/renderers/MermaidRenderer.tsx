import mermaid from 'mermaid';
import React, { useEffect, useState } from 'react';

import type { Artifact } from '@/types/artifact';

import { i18nService } from '../../../services/i18n';
import { startMermaidRender } from './mermaidRenderLifecycle';
import { getZoomedSize, MAX_ZOOM_SCALE, MIN_ZOOM_SCALE, stepZoomScale } from './zoomPan';
import { useInjectedSvgSize, useZoomPan, ZoomPanViewport } from './ZoomPanViewport';

let mermaidInitialized = false;

function initMermaid(isDark: boolean) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
  });
  mermaidInitialized = true;
}

function createMermaidRenderContainer(): HTMLDivElement {
  const container = document.createElement('div');
  container.setAttribute('data-lobster-mermaid-render-container', 'true');
  container.style.position = 'absolute';
  container.style.left = '0';
  container.style.top = '0';
  container.style.width = '100%';
  container.style.visibility = 'hidden';
  container.style.overflow = 'hidden';
  container.style.pointerEvents = 'none';
  document.body.appendChild(container);
  return container;
}

interface MermaidRendererProps {
  artifact: Artifact;
}

const MermaidRenderer: React.FC<MermaidRendererProps> = ({ artifact }) => {
  const zoomPan = useZoomPan();
  const { scale } = zoomPan;
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string>('');

  const svgSize = useInjectedSvgSize(zoomPan.contentElement, svg);
  const displaySize = svgSize
    ? getZoomedSize({
      intrinsicWidth: svgSize.width,
      aspectRatio: svgSize.aspectRatio,
      availableWidth: zoomPan.availableWidth,
      scale,
    })
    : null;

  useEffect(() => {
    const isDark = document.documentElement.classList.contains('dark');
    if (!mermaidInitialized) {
      initMermaid(isDark);
    }

    const task = startMermaidRender({
      source: artifact.content,
      api: mermaid,
      createContainer: createMermaidRenderContainer,
      onSuccess: rendered => {
        setSvg(rendered);
        setError(null);
      },
      onError: error => {
        setSvg('');
        setError(error instanceof Error && error.message
          ? error.message
          : i18nService.t('artifactMermaidRenderFailed'));
      },
    });
    return task.cancel;
  }, [artifact.content, artifact.id]);

  if (error) {
    return (
      <div className="w-full h-full overflow-auto">
        <div role="alert" className="p-4 text-sm text-red-500">
          <p className="font-medium">{i18nService.t('artifactMermaidRenderError')}</p>
          <pre className="mt-2 text-xs whitespace-pre-wrap">{error}</pre>
        </div>
      </div>
    );
  }

  return (
    <ZoomPanViewport
      zoomPan={zoomPan}
      isContentSized={displaySize !== null}
      overlay={(
        <div className="absolute bottom-3 right-3 flex items-center gap-1">
          <button
            onClick={() => zoomPan.zoomTo(prev => stepZoomScale(prev, -1))}
            disabled={scale <= MIN_ZOOM_SCALE}
            className="w-6 h-6 flex items-center justify-center text-xs rounded bg-surface text-secondary hover:bg-surface-hover disabled:opacity-30"
          >
            −
          </button>
          <button
            onClick={zoomPan.resetZoom}
            className="px-1.5 py-0.5 text-xs rounded bg-surface text-secondary hover:bg-surface-hover tabular-nums"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            onClick={() => zoomPan.zoomTo(prev => stepZoomScale(prev, 1))}
            disabled={scale >= MAX_ZOOM_SCALE}
            className="w-6 h-6 flex items-center justify-center text-xs rounded bg-surface text-secondary hover:bg-surface-hover disabled:opacity-30"
          >
            +
          </button>
        </div>
      )}
    >
      <div
        ref={zoomPan.setContentElement}
        className={`m-auto shrink-0 ${displaySize
          ? '[&>svg]:block [&>svg]:!h-full [&>svg]:!w-full [&>svg]:!max-w-none'
          : '[&>svg]:max-w-full [&>svg]:h-auto'}`}
        style={displaySize ?? undefined}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ZoomPanViewport>
  );
};

export default MermaidRenderer;
