import DOMPurify from 'dompurify';
import React, { useMemo } from 'react';

import type { Artifact } from '@/types/artifact';

import { getZoomedSize } from './zoomPan';
import { useInjectedSvgSize, useZoomPan, ZoomPanViewport, ZoomResetBadge } from './ZoomPanViewport';

interface SvgRendererProps {
  artifact: Artifact;
}

const SvgRenderer: React.FC<SvgRendererProps> = ({ artifact }) => {
  const zoomPan = useZoomPan();

  const sanitizedSvg = useMemo(() => {
    if (!artifact.content) return '';
    return DOMPurify.sanitize(artifact.content, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['use'],
    });
  }, [artifact.content]);

  const svgSize = useInjectedSvgSize(zoomPan.contentElement, sanitizedSvg);
  const displaySize = svgSize
    ? getZoomedSize({
      intrinsicWidth: svgSize.width,
      aspectRatio: svgSize.aspectRatio,
      availableWidth: zoomPan.availableWidth,
      scale: zoomPan.scale,
    })
    : null;

  return (
    <ZoomPanViewport
      zoomPan={zoomPan}
      isContentSized={displaySize !== null}
      overlay={<ZoomResetBadge zoomPan={zoomPan} />}
    >
      <div
        ref={zoomPan.setContentElement}
        className={`m-auto shrink-0 ${displaySize
          ? '[&>svg]:block [&>svg]:!h-full [&>svg]:!w-full [&>svg]:!max-w-none'
          : '[&>svg]:max-w-full [&>svg]:h-auto'}`}
        style={displaySize ?? undefined}
        dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
      />
    </ZoomPanViewport>
  );
};

export default SvgRenderer;
