import DOMPurify from 'dompurify';

import { LibraryArtifactType } from '../../shared/library/constants';
import { HtmlThumbnailLayout, isLibraryHtmlThumbnailExtension } from '../../shared/library/htmlThumbnail';
import {
  getLibraryThumbnailFailureDetails,
  getLibraryThumbnailPresentationStampColor,
  LibraryThumbnailError,
  LibraryThumbnailFailureCode,
  LibraryThumbnailPresentationStamp,
  type LibraryThumbnailRenderMetrics,
  type LibraryThumbnailRenderRequest,
  type LibraryThumbnailRenderResult,
  withLibraryThumbnailErrorMetrics,
} from '../../shared/library/thumbnail';
import { renderHtmlThumbnail } from './htmlThumbnailRenderer';
import {
  renderPptxFirstSlide,
  waitForPptxSlideLayout,
  waitForPptxSlideReady,
} from './pptxThumbnailRenderer';
import { calculateRasterThumbnailDrawRect } from './rasterThumbnailLayout';

declare global {
  interface Window {
    renderLibraryThumbnail: (
      request: LibraryThumbnailRenderRequest,
    ) => Promise<LibraryThumbnailRenderResult>;
  }
}

const root = document.getElementById('library-thumbnail-root');
if (!root) throw new Error('Missing thumbnail root');
const presentationStamp = document.createElement('div');
presentationStamp.id = 'library-thumbnail-presentation-stamp';
presentationStamp.setAttribute('aria-hidden', 'true');
document.body.appendChild(presentationStamp);

let activeCleanup: (() => void) | undefined;
const THUMBNAIL_SURFACE_COLOR = '#f5f6f8';
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => (
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
);

const nextFrame = (): Promise<void> => new Promise(resolve => {
  requestAnimationFrame(() => resolve());
});

const waitForStableLayout = async (): Promise<void> => {
  if (document.fonts?.ready) await document.fonts.ready;
  await nextFrame();
  await nextFrame();
};

const configureDocument = (request: LibraryThumbnailRenderRequest): void => {
  const contentHeight = request.height + (isLibraryHtmlThumbnailExtension(request.extension)
    ? HtmlThumbnailLayout.ChildStampHeight : 0);
  const documentHeight = contentHeight + LibraryThumbnailPresentationStamp.Height;
  document.documentElement.style.width = `${request.width}px`;
  document.documentElement.style.height = `${documentHeight}px`;
  document.body.style.width = `${request.width}px`;
  document.body.style.height = `${documentHeight}px`;
  root.style.width = `${request.width}px`;
  root.style.height = `${contentHeight}px`;
  const stampColor = getLibraryThumbnailPresentationStampColor(request.renderGeneration);
  presentationStamp.style.top = `${contentHeight}px`;
  presentationStamp.style.width = `${request.width}px`;
  presentationStamp.style.height = `${LibraryThumbnailPresentationStamp.Height}px`;
  presentationStamp.style.backgroundColor = `rgb(${stampColor.red}, ${stampColor.green}, ${stampColor.blue})`;
};

const resetRoot = (): void => {
  activeCleanup?.();
  activeCleanup = undefined;
  root.replaceChildren();
  root.removeAttribute('class');
  root.removeAttribute('style');
};

const encodeCanvasPng = (canvas: HTMLCanvasElement): string => {
  const dataUrl = canvas.toDataURL('image/png');
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('Thumbnail PNG encoding failed');
  }
  return dataUrl.slice(PNG_DATA_URL_PREFIX.length);
};

const loadElement = (element: HTMLImageElement | HTMLVideoElement): Promise<void> => new Promise(
  (resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener('load', handleLoad);
      element.removeEventListener('loadeddata', handleLoad);
      element.removeEventListener('error', handleError);
    };
    const handleLoad = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('Media could not be decoded'));
    };
    element.addEventListener('load', handleLoad, { once: true });
    element.addEventListener('loadeddata', handleLoad, { once: true });
    element.addEventListener('error', handleError, { once: true });
  },
);

const fitElement = (
  element: HTMLElement,
  width: number,
  height: number,
  padding = 12,
): void => {
  element.style.transform = 'none';
  element.style.transformOrigin = 'top left';
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const availableWidth = Math.max(1, width - (padding * 2));
  const availableHeight = Math.max(1, height - (padding * 2));
  const scale = Math.min(availableWidth / bounds.width, availableHeight / bounds.height, 1);
  element.style.position = 'absolute';
  element.style.left = `${Math.max(padding, (width - (bounds.width * scale)) / 2)}px`;
  element.style.top = `${Math.max(padding, (height - (bounds.height * scale)) / 2)}px`;
  element.style.margin = '0';
  element.style.transform = `scale(${scale})`;
};

const renderImageBytesToPng = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
  mimeType = IMAGE_MIME_TYPES[request.extension] || 'application/octet-stream',
): Promise<string> => {
  const blob = new Blob([toArrayBuffer(bytes)], {
    type: mimeType,
  });
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.alt = '';
  image.decoding = 'async';
  activeCleanup = () => URL.revokeObjectURL(objectUrl);
  const loaded = loadElement(image);
  image.src = objectUrl;
  await loaded;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Raster thumbnail canvas is unavailable');
  const drawRect = calculateRasterThumbnailDrawRect(
    image.naturalWidth,
    image.naturalHeight,
    request.width,
    request.height,
  );
  context.fillStyle = THUMBNAIL_SURFACE_COLOR;
  context.fillRect(0, 0, request.width, request.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
  root.appendChild(canvas);
  return encodeCanvasPng(canvas);
};

const renderVideo = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<string> => {
  const blob = new Blob([toArrayBuffer(bytes)], {
    type: VIDEO_MIME_TYPES[request.extension] || 'application/octet-stream',
  });
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  activeCleanup = () => URL.revokeObjectURL(objectUrl);
  const loaded = loadElement(video);
  video.src = objectUrl;
  await loaded;

  const targetTime = Number.isFinite(video.duration) && video.duration > 0
    ? Math.min(Math.max(video.duration * 0.1, 0.1), 1)
    : 0;
  if (targetTime > 0) {
    await new Promise<void>(resolve => {
      const timer = window.setTimeout(resolve, 1_500);
      video.addEventListener('seeked', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      video.currentTime = targetTime;
    });
  }

  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const context = canvas.getContext('2d');
  if (!context || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error('Video frame is unavailable');
  }
  context.fillStyle = '#111318';
  context.fillRect(0, 0, request.width, request.height);
  const scale = Math.min(request.width / video.videoWidth, request.height / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  context.drawImage(
    video,
    (request.width - drawWidth) / 2,
    (request.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  root.appendChild(canvas);
  return encodeCanvasPng(canvas);
};

const renderPdf = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<string> => {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).href;
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableFontFace: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  activeCleanup = () => {
    void pdf.destroy();
  };
  const page = await pdf.getPage(1);
  const initialViewport = page.getViewport({ scale: 1 });
  const padding = 10;
  const scale = Math.min(
    (request.width - (padding * 2)) / initialViewport.width,
    (request.height - (padding * 2)) / initialViewport.height,
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  canvas.style.width = `${request.width}px`;
  canvas.style.height = `${request.height}px`;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PDF canvas is unavailable');
  context.fillStyle = THUMBNAIL_SURFACE_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const left = (request.width - viewport.width) / 2;
  const top = (request.height - viewport.height) / 2;
  root.appendChild(canvas);
  await page.render({
    canvasContext: context,
    viewport,
    transform: [1, 0, 0, 1, left, top],
  }).promise;
  return encodeCanvasPng(canvas);
};

const renderDocx = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const { renderAsync } = await import('docx-preview');
  root.className = 'thumbnail-document-root';
  await renderAsync(toArrayBuffer(bytes), root, undefined, {
    className: 'thumbnail-docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
  });
  await waitForStableLayout();
  const pages = Array.from(root.querySelectorAll<HTMLElement>('section.thumbnail-docx'));
  pages.slice(1).forEach(page => { page.style.display = 'none'; });
  const page = pages[0] || root.firstElementChild as HTMLElement | null;
  if (!page) throw new Error('DOCX page is unavailable');
  fitElement(page, request.width, request.height, 8);
};

const renderSpreadsheet = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<string> => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(toArrayBuffer(bytes), { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
  if (!worksheet) throw new Error('Spreadsheet is empty');

  const range = worksheet['!ref']
    ? XLSX.utils.decode_range(worksheet['!ref'])
    : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Spreadsheet thumbnail canvas is unavailable');
  context.fillStyle = THUMBNAIL_SURFACE_COLOR;
  context.fillRect(0, 0, request.width, request.height);

  const padding = 8;
  const rowHeight = 25;
  const columnWidth = 112;
  const maxRow = Math.min(
    range.e.r,
    range.s.r + Math.floor((request.height - (padding * 2)) / rowHeight) - 1,
  );
  const maxColumn = Math.min(
    range.e.c,
    range.s.c + Math.floor((request.width - (padding * 2)) / columnWidth) - 1,
  );
  context.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
  context.textBaseline = 'middle';
  for (let rowIndex = range.s.r; rowIndex <= maxRow; rowIndex += 1) {
    for (let columnIndex = range.s.c; columnIndex <= maxColumn; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const value = worksheet[address];
      const text = value?.w ?? (value?.v === undefined ? '' : String(value.v));
      const x = padding + ((columnIndex - range.s.c) * columnWidth);
      const y = padding + ((rowIndex - range.s.r) * rowHeight);
      context.fillStyle = rowIndex === range.s.r ? '#e8eef9' : '#ffffff';
      context.fillRect(x, y, columnWidth, rowHeight);
      context.strokeStyle = '#dfe3e8';
      context.strokeRect(x + 0.5, y + 0.5, columnWidth, rowHeight);
      context.fillStyle = rowIndex === range.s.r ? '#28466f' : '#20242c';
      const clippedText = text.length > 16 ? `${text.slice(0, 15)}…` : text;
      context.fillText(clippedText, x + 6, y + (rowHeight / 2), columnWidth - 12);
    }
  }
  root.appendChild(canvas);
  return encodeCanvasPng(canvas);
};

const renderPptx = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<Partial<LibraryThumbnailRenderMetrics>> => {
  const pptxPreview = await import('pptx-preview');
  const {
    previewer,
    slide,
    slideCount,
    sourceHasVisualContent,
    sourceVisualElementCount,
  } = await renderPptxFirstSlide(
    pptxPreview,
    root,
    toArrayBuffer(bytes),
    640,
  );
  activeCleanup = () => previewer.destroy();
  const sourceMetrics = {
    slideCount,
    renderedSlideIndex: 0,
    sourceHasVisualContent,
    sourceVisualElementCount,
  };
  try {
    const readiness = await waitForPptxSlideReady(slide);
    const metrics = {
      ...sourceMetrics,
      ...readiness,
      hasVisualContent: sourceHasVisualContent || readiness.domHasVisualContent,
    };
    if (sourceHasVisualContent && !readiness.domHasVisualContent) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxFirstSlideDomEmpty,
        'PPTX first slide source has content but rendered DOM is empty',
        metrics,
      );
    }
    fitElement(slide, request.width, request.height, 4);
    await waitForPptxSlideLayout(slide);
    return metrics;
  } catch (error) {
    throw withLibraryThumbnailErrorMetrics(
      error,
      LibraryThumbnailFailureCode.RendererFailed,
      sourceMetrics,
    );
  }
};

const renderMermaid = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<string> => {
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    // The sanitizer below strips foreignObject, so labels must be plain SVG text.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });
  const source = new TextDecoder('utf-8').decode(bytes);
  const renderId = `library-thumbnail-${Date.now()}`;
  const { svg } = await mermaid.render(renderId, source);
  const sanitizedSvg = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  return renderImageBytesToPng(
    request,
    new TextEncoder().encode(sanitizedSvg),
    'image/svg+xml',
  );
};

const renderText = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<string> => {
  const previewBytes = bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES);
  const source = new TextDecoder('utf-8').decode(previewBytes);
  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Text thumbnail canvas is unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, request.width, request.height);
  const padding = 18;
  const lineHeight = 20;
  const maxWidth = request.width - (padding * 2);
  const maxLines = Math.floor((request.height - (padding * 2)) / lineHeight);
  context.textBaseline = 'top';
  context.font = request.artifactType === LibraryArtifactType.Markdown
    ? '14px "Segoe UI", "Microsoft YaHei", sans-serif'
    : '13px Consolas, "SFMono-Regular", monospace';
  context.fillStyle = '#303640';

  const getFittingPrefixLength = (value: string): number => {
    let lower = 1;
    let upper = value.length;
    let best = 1;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (context.measureText(value.slice(0, middle)).width <= maxWidth) {
        best = middle;
        lower = middle + 1;
      } else {
        upper = middle - 1;
      }
    }
    return best;
  };
  const wrappedLines: string[] = [];
  for (const sourceLine of source.replace(/\t/g, '  ').split(/\r?\n/)) {
    if (!sourceLine) {
      wrappedLines.push('');
      continue;
    }
    let remaining = sourceLine;
    while (remaining.length > 0) {
      const end = getFittingPrefixLength(remaining);
      wrappedLines.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
      if (wrappedLines.length >= maxLines) break;
    }
    if (wrappedLines.length >= maxLines) break;
  }
  wrappedLines.slice(0, maxLines).forEach((line, index) => {
    context.fillText(line, padding, padding + (index * lineHeight), maxWidth);
  });
  root.appendChild(canvas);
  return encodeCanvasPng(canvas);
};

const renderRequest = async (
  request: LibraryThumbnailRenderRequest,
): Promise<Partial<LibraryThumbnailRenderMetrics> & { pngBase64?: string }> => {
  const bytes = decodeBase64(request.contentBase64);
  if (request.artifactType === LibraryArtifactType.Image) {
    return { pngBase64: await renderImageBytesToPng(request, bytes) };
  }
  if (request.artifactType === LibraryArtifactType.Svg) {
    const source = new TextDecoder('utf-8').decode(bytes);
    const sanitizedSvg = DOMPurify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
    return {
      pngBase64: await renderImageBytesToPng(
        request,
        new TextEncoder().encode(sanitizedSvg),
        'image/svg+xml',
      ),
    };
  }
  if (request.artifactType === LibraryArtifactType.Video) {
    return { pngBase64: await renderVideo(request, bytes) };
  }
  if (request.artifactType === LibraryArtifactType.Html) {
    await renderHtmlThumbnail(root, request, bytes);
    return {};
  }
  if (request.artifactType === LibraryArtifactType.Mermaid) {
    return { pngBase64: await renderMermaid(request, bytes) };
  }
  if (request.artifactType === LibraryArtifactType.Markdown
    || request.artifactType === LibraryArtifactType.Text
    || request.artifactType === LibraryArtifactType.Code) {
    return { pngBase64: await renderText(request, bytes) };
  }
  if (request.extension === '.pdf') {
    return { pngBase64: await renderPdf(request, bytes) };
  }
  if (request.extension === '.docx') {
    await renderDocx(request, bytes);
    return {};
  }
  if (request.extension === '.pptx') {
    return renderPptx(request, bytes);
  }
  if (['.xls', '.xlsx', '.csv', '.tsv'].includes(request.extension)) {
    return { pngBase64: await renderSpreadsheet(request, bytes) };
  }
  throw new Error('Unsupported document thumbnail format');
};

window.renderLibraryThumbnail = async request => {
  resetRoot();
  configureDocument(request);
  const startedAt = performance.now();
  try {
    const output = await renderRequest(request);
    await waitForStableLayout();
    const { pngBase64, ...metrics } = output;
    return {
      success: true,
      renderGeneration: request.renderGeneration,
      pngBase64,
      metrics: {
        renderDurationMs: Math.round(performance.now() - startedAt),
        ...metrics,
      },
    };
  } catch (error) {
    const failure = getLibraryThumbnailFailureDetails(
      error,
      LibraryThumbnailFailureCode.RendererFailed,
    );
    resetRoot();
    return {
      success: false,
      renderGeneration: request.renderGeneration,
      error: failure.message,
      failureCode: failure.code,
      failureStage: failure.stage,
      metrics: {
        renderDurationMs: Math.round(performance.now() - startedAt),
        ...failure.metrics,
      },
    };
  }
};

document.documentElement.className = 'library-thumbnail-page';
document.body.className = 'library-thumbnail-page';
const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; }
  html.library-thumbnail-page,
  body.library-thumbnail-page {
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #f5f6f8;
    color: #20242c;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  #library-thumbnail-root {
    position: relative;
    overflow: hidden;
    background: #f5f6f8;
  }
  #library-thumbnail-presentation-stamp {
    position: absolute;
    left: 0;
    z-index: 2147483647;
    pointer-events: none;
  }
  .thumbnail-media {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center;
  }
  #library-thumbnail-root > canvas {
    display: block;
  }
  .thumbnail-document-root {
    background: #eceff3 !important;
  }
  .thumbnail-document-root .docx-wrapper {
    padding: 0 !important;
    background: transparent !important;
  }
  .thumbnail-document-root section.thumbnail-docx {
    box-shadow: 0 2px 10px rgba(24, 31, 43, 0.18);
  }
  .thumbnail-sheet {
    border-collapse: collapse;
    table-layout: fixed;
    min-width: 620px;
    background: #fff;
    color: #20242c;
    font-size: 14px;
    line-height: 1.3;
    box-shadow: 0 2px 10px rgba(24, 31, 43, 0.14);
  }
  .thumbnail-sheet th,
  .thumbnail-sheet td {
    width: 110px;
    max-width: 110px;
    height: 28px;
    padding: 4px 7px;
    overflow: hidden;
    border: 1px solid #dfe3e8;
    text-align: left;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .thumbnail-sheet th {
    background: #e8eef9;
    color: #28466f;
    font-weight: 600;
  }
  .thumbnail-html-frame {
    position: absolute;
    inset: 0 auto auto 0;
    border: 0;
    background: #fff;
    transform-origin: top left;
  }
  .thumbnail-vector {
    display: inline-block;
    min-width: 160px;
    min-height: 100px;
  }
  .thumbnail-vector svg {
    display: block;
    max-width: none !important;
    height: auto;
  }
  .thumbnail-text {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 22px 26px;
    overflow: hidden;
    background: #fff;
    color: #303641;
    font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .thumbnail-markdown {
    color: #252a32;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.65;
  }
`;
document.head.appendChild(style);
