import React, { useCallback, useState } from 'react';

import type { Artifact } from '@/types/artifact';

import { getZoomedSize } from './zoomPan';
import { useZoomPan, ZoomPanViewport, ZoomResetBadge } from './ZoomPanViewport';

interface ImageRendererProps {
  artifact: Artifact;
}

interface NaturalSize {
  src: string;
  width: number;
  height: number;
}

const ImageRenderer: React.FC<ImageRendererProps> = ({ artifact }) => {
  const zoomPan = useZoomPan();
  const [error, setError] = useState(false);
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null);

  const handleLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    setNaturalSize({ src: image.getAttribute('src') ?? '', width: image.naturalWidth, height: image.naturalHeight });
  }, []);

  // Only trust the size measured for the image currently shown, so a refreshed
  // image is never stretched to the previous version's aspect ratio.
  const displaySize = naturalSize && naturalSize.src === artifact.content && naturalSize.width > 0 && naturalSize.height > 0
    ? getZoomedSize({
      intrinsicWidth: naturalSize.width,
      aspectRatio: naturalSize.width / naturalSize.height,
      availableWidth: zoomPan.availableWidth,
      scale: zoomPan.scale,
    })
    : null;

  if (!artifact.content) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading image...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Failed to load image
      </div>
    );
  }

  return (
    <ZoomPanViewport
      zoomPan={zoomPan}
      isContentSized={displaySize !== null}
      overlay={<ZoomResetBadge zoomPan={zoomPan} />}
    >
      <img
        ref={zoomPan.setContentElement}
        src={artifact.content}
        alt={artifact.title}
        draggable={false}
        className={`m-auto shrink-0 ${displaySize ? 'max-w-none' : 'max-w-full'}`}
        style={displaySize ?? undefined}
        onLoad={handleLoad}
        onError={() => setError(true)}
      />
    </ZoomPanViewport>
  );
};

export default ImageRenderer;
