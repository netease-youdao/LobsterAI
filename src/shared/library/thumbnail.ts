import type { ArtifactFileAccess } from '../artifactPreview/types';
import {
  getLibraryArtifactTypeForExtension,
  type LibraryArtifactType,
} from './constants';

export const LibraryThumbnailDimensions = {
  Width: 480,
  Height: 270,
} as const;

export const LibraryThumbnailPresentationStamp = {
  Height: 2,
  ColorTolerance: 12,
} as const;

export interface LibraryThumbnailPresentationStampColor {
  red: number;
  green: number;
  blue: number;
}

export const getLibraryThumbnailPresentationStampColor = (
  renderGeneration: number,
): LibraryThumbnailPresentationStampColor => {
  const normalized = Math.max(0, Math.floor(renderGeneration));
  return {
    red: 32 + ((normalized * 73) % 192),
    green: 32 + ((normalized * 109) % 192),
    blue: 32 + ((normalized * 151) % 192),
  };
};

export const LibraryThumbnailLimits = {
  MaxSourceBytes: 64 * 1024 * 1024,
  RenderTimeoutMs: 12_000,
  CaptureTimeoutMs: 5_000,
  PresentationTimeoutMs: 3_000,
  MaxRenderAttempts: 2,
} as const;

export const LibraryThumbnailRequestPriority = {
  Visible: 0,
  NearViewport: 1,
  Background: 2,
} as const;

export type LibraryThumbnailRequestPriorityType = typeof LibraryThumbnailRequestPriority[
  keyof typeof LibraryThumbnailRequestPriority
];

export const LibraryThumbnailFailureStage = {
  Source: 'source',
  Renderer: 'renderer',
  PptxParse: 'pptx-parse',
  PptxFirstSlide: 'pptx-first-slide',
  PptxMedia: 'pptx-media',
  PptxLayout: 'pptx-layout',
  Presentation: 'presentation',
  Validation: 'validation',
  NativeFallback: 'native-fallback',
  Unknown: 'unknown',
} as const;

export type LibraryThumbnailFailureStageType = typeof LibraryThumbnailFailureStage[
  keyof typeof LibraryThumbnailFailureStage
];

export const LibraryThumbnailFailureCode = {
  SourceReadFailed: 'source_read_failed',
  SourceTooLarge: 'source_too_large',
  UnsupportedFormat: 'unsupported_format',
  RendererTimeout: 'renderer_timeout',
  RendererResponseInvalid: 'renderer_response_invalid',
  RenderGenerationMismatch: 'render_generation_mismatch',
  RendererFailed: 'renderer_failed',
  DirectPngInvalid: 'direct_png_invalid',
  PptxParseFailed: 'pptx_parse_failed',
  PptxNoSlides: 'pptx_no_slides',
  PptxFirstSlideDomMissing: 'pptx_first_slide_dom_missing',
  PptxFirstSlideDomEmpty: 'pptx_first_slide_dom_empty',
  PptxMediaLoadFailed: 'pptx_media_load_failed',
  PptxMediaTimeout: 'pptx_media_timeout',
  PptxLayoutUnstable: 'pptx_layout_unstable',
  PresentationFailed: 'presentation_failed',
  PresentationTimeout: 'presentation_timeout',
  CaptureTimeout: 'capture_timeout',
  CaptureEmpty: 'capture_empty',
  CaptureBlank: 'capture_blank',
  NativeThumbnailFailed: 'native_thumbnail_failed',
  NativeThumbnailEmpty: 'native_thumbnail_empty',
  NativeThumbnailBlank: 'native_thumbnail_blank',
  RequestCanceled: 'request_canceled',
  Unknown: 'unknown',
} as const;

export type LibraryThumbnailFailureCodeType = typeof LibraryThumbnailFailureCode[
  keyof typeof LibraryThumbnailFailureCode
];

const LIBRARY_THUMBNAIL_FAILURE_STAGE_BY_CODE: Record<
  LibraryThumbnailFailureCodeType,
  LibraryThumbnailFailureStageType
> = {
  [LibraryThumbnailFailureCode.SourceReadFailed]: LibraryThumbnailFailureStage.Source,
  [LibraryThumbnailFailureCode.SourceTooLarge]: LibraryThumbnailFailureStage.Source,
  [LibraryThumbnailFailureCode.UnsupportedFormat]: LibraryThumbnailFailureStage.Source,
  [LibraryThumbnailFailureCode.RendererTimeout]: LibraryThumbnailFailureStage.Renderer,
  [LibraryThumbnailFailureCode.RendererResponseInvalid]: LibraryThumbnailFailureStage.Renderer,
  [LibraryThumbnailFailureCode.RenderGenerationMismatch]: LibraryThumbnailFailureStage.Renderer,
  [LibraryThumbnailFailureCode.RendererFailed]: LibraryThumbnailFailureStage.Renderer,
  [LibraryThumbnailFailureCode.DirectPngInvalid]: LibraryThumbnailFailureStage.Validation,
  [LibraryThumbnailFailureCode.PptxParseFailed]: LibraryThumbnailFailureStage.PptxParse,
  [LibraryThumbnailFailureCode.PptxNoSlides]: LibraryThumbnailFailureStage.PptxParse,
  [LibraryThumbnailFailureCode.PptxFirstSlideDomMissing]: LibraryThumbnailFailureStage.PptxFirstSlide,
  [LibraryThumbnailFailureCode.PptxFirstSlideDomEmpty]: LibraryThumbnailFailureStage.PptxFirstSlide,
  [LibraryThumbnailFailureCode.PptxMediaLoadFailed]: LibraryThumbnailFailureStage.PptxMedia,
  [LibraryThumbnailFailureCode.PptxMediaTimeout]: LibraryThumbnailFailureStage.PptxMedia,
  [LibraryThumbnailFailureCode.PptxLayoutUnstable]: LibraryThumbnailFailureStage.PptxLayout,
  [LibraryThumbnailFailureCode.PresentationFailed]: LibraryThumbnailFailureStage.Presentation,
  [LibraryThumbnailFailureCode.PresentationTimeout]: LibraryThumbnailFailureStage.Presentation,
  [LibraryThumbnailFailureCode.CaptureTimeout]: LibraryThumbnailFailureStage.Presentation,
  [LibraryThumbnailFailureCode.CaptureEmpty]: LibraryThumbnailFailureStage.Validation,
  [LibraryThumbnailFailureCode.CaptureBlank]: LibraryThumbnailFailureStage.Validation,
  [LibraryThumbnailFailureCode.NativeThumbnailFailed]: LibraryThumbnailFailureStage.NativeFallback,
  [LibraryThumbnailFailureCode.NativeThumbnailEmpty]: LibraryThumbnailFailureStage.NativeFallback,
  [LibraryThumbnailFailureCode.NativeThumbnailBlank]: LibraryThumbnailFailureStage.NativeFallback,
  [LibraryThumbnailFailureCode.RequestCanceled]: LibraryThumbnailFailureStage.Renderer,
  [LibraryThumbnailFailureCode.Unknown]: LibraryThumbnailFailureStage.Unknown,
};

const LIBRARY_THUMBNAIL_RETRYABLE_FAILURE_CODES = new Set<
  LibraryThumbnailFailureCodeType
>([
  LibraryThumbnailFailureCode.SourceReadFailed,
  LibraryThumbnailFailureCode.RendererTimeout,
  LibraryThumbnailFailureCode.RendererResponseInvalid,
  LibraryThumbnailFailureCode.RenderGenerationMismatch,
  LibraryThumbnailFailureCode.RendererFailed,
  LibraryThumbnailFailureCode.DirectPngInvalid,
  LibraryThumbnailFailureCode.PptxMediaLoadFailed,
  LibraryThumbnailFailureCode.PptxMediaTimeout,
  LibraryThumbnailFailureCode.PptxLayoutUnstable,
  LibraryThumbnailFailureCode.PresentationFailed,
  LibraryThumbnailFailureCode.PresentationTimeout,
  LibraryThumbnailFailureCode.CaptureTimeout,
  LibraryThumbnailFailureCode.CaptureEmpty,
  LibraryThumbnailFailureCode.CaptureBlank,
  LibraryThumbnailFailureCode.NativeThumbnailFailed,
  LibraryThumbnailFailureCode.NativeThumbnailEmpty,
  LibraryThumbnailFailureCode.NativeThumbnailBlank,
]);

export const isLibraryThumbnailFailureRetryable = (
  code: LibraryThumbnailFailureCodeType,
): boolean => LIBRARY_THUMBNAIL_RETRYABLE_FAILURE_CODES.has(code);

export interface LibraryThumbnailGenerateRequest {
  access?: ArtifactFileAccess;
  filePath: string;
  requestId: string;
  priority: LibraryThumbnailRequestPriorityType;
}

export interface LibraryThumbnailGenerateResponse {
  success: boolean;
  dataUrl?: string;
  error?: string;
  failureCode?: LibraryThumbnailFailureCodeType;
  failureStage?: LibraryThumbnailFailureStageType;
  retryable?: boolean;
}

export const getLibraryThumbnailFailureStage = (
  code: LibraryThumbnailFailureCodeType,
): LibraryThumbnailFailureStageType => LIBRARY_THUMBNAIL_FAILURE_STAGE_BY_CODE[code];

export const LibraryRasterThumbnailExtensions = [
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
] as const;

const LIBRARY_RASTER_THUMBNAIL_EXTENSION_SET = new Set<string>(
  LibraryRasterThumbnailExtensions,
);

export const isLibraryRasterThumbnailExtension = (extension: string): boolean => (
  LIBRARY_RASTER_THUMBNAIL_EXTENSION_SET.has(extension.trim().toLowerCase())
);

const LIBRARY_PRESENTED_THUMBNAIL_EXTENSION_SET = new Set([
  '.docx',
  '.htm',
  '.html',
  '.pptx',
]);

export const isLibraryDirectPngThumbnailExtension = (extension: string): boolean => {
  const normalized = extension.trim().toLowerCase();
  return getLibraryArtifactTypeForExtension(normalized) !== null
    && !LIBRARY_PRESENTED_THUMBNAIL_EXTENSION_SET.has(normalized);
};

export interface LibraryThumbnailRenderRequest {
  fileName: string;
  extension: string;
  artifactType: LibraryArtifactType;
  contentBase64: string;
  width: number;
  height: number;
  renderGeneration: number;
}

export interface LibraryThumbnailRenderResult {
  success: boolean;
  renderGeneration: number;
  pngBase64?: string;
  error?: string;
  failureCode?: LibraryThumbnailFailureCodeType;
  failureStage?: LibraryThumbnailFailureStageType;
  metrics?: LibraryThumbnailRenderMetrics;
}

export interface LibraryThumbnailRenderMetrics {
  renderDurationMs: number;
  sourceSizeBytes?: number;
  slideCount?: number;
  renderedSlideIndex?: number;
  sourceVisualElementCount?: number;
  sourceHasVisualContent?: boolean;
  domHasVisualContent?: boolean;
  imageCount?: number;
  decodedImageCount?: number;
  hasVisualContent?: boolean;
}

export class LibraryThumbnailError extends Error {
  readonly code: LibraryThumbnailFailureCodeType;
  readonly metrics?: Partial<LibraryThumbnailRenderMetrics>;

  constructor(
    code: LibraryThumbnailFailureCodeType,
    message: string,
    metrics?: Partial<LibraryThumbnailRenderMetrics>,
  ) {
    super(message);
    this.name = 'LibraryThumbnailError';
    this.code = code;
    this.metrics = metrics;
  }
}

export interface LibraryThumbnailFailureDetails {
  code: LibraryThumbnailFailureCodeType;
  stage: LibraryThumbnailFailureStageType;
  message: string;
  metrics?: Partial<LibraryThumbnailRenderMetrics>;
}

export const getLibraryThumbnailFailureDetails = (
  error: unknown,
  fallbackCode: LibraryThumbnailFailureCodeType = LibraryThumbnailFailureCode.Unknown,
  fallbackMessage = 'Thumbnail rendering failed',
): LibraryThumbnailFailureDetails => {
  const code = error instanceof LibraryThumbnailError ? error.code : fallbackCode;
  return {
    code,
    stage: getLibraryThumbnailFailureStage(code),
    message: error instanceof Error ? error.message : fallbackMessage,
    metrics: error instanceof LibraryThumbnailError ? error.metrics : undefined,
  };
};

export const withLibraryThumbnailErrorMetrics = (
  error: unknown,
  fallbackCode: LibraryThumbnailFailureCodeType,
  metrics: Partial<LibraryThumbnailRenderMetrics>,
  fallbackMessage = 'Thumbnail rendering failed',
): LibraryThumbnailError => {
  const failure = getLibraryThumbnailFailureDetails(error, fallbackCode, fallbackMessage);
  return new LibraryThumbnailError(
    failure.code,
    failure.message,
    { ...failure.metrics, ...metrics },
  );
};

export const createLibraryThumbnailRenderRequest = (
  fileName: string,
  contentBase64: string,
  width: number = LibraryThumbnailDimensions.Width,
  height: number = LibraryThumbnailDimensions.Height,
  renderGeneration = 0,
): LibraryThumbnailRenderRequest | null => {
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
  const artifactType = getLibraryArtifactTypeForExtension(extension);
  if (!artifactType) return null;
  return {
    fileName,
    extension,
    artifactType,
    contentBase64,
    width,
    height,
    renderGeneration,
  };
};
