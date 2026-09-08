import { getLibraryThumbnailPresentationStampColor } from './thumbnail';

export const HtmlThumbnailLayout = {
  ChildStampHeight: 2,
  FrameScale: 2,
} as const;

export const HtmlThumbnailLimits = {
  LoadTimeoutMs: 3_000,
  AnimationTimeoutMs: 3_000,
  AnimationSettleMs: 50,
  CaptureIntervalMs: 50,
} as const;

export const isLibraryHtmlThumbnailExtension = (extension: string): boolean => (
  ['.html', '.htm'].includes(extension.trim().toLowerCase())
);

// Keep the child marker distinct from the parent marker for the same request.
export const getLibraryHtmlThumbnailStampColor = (renderGeneration: number) => (
  getLibraryThumbnailPresentationStampColor(renderGeneration + 97)
);
