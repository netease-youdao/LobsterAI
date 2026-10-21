import React, { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import { useFileContent } from '../../documentFileContent';
import { type OfficePreviewZoomControlsConfig, useRegisterOfficePreviewZoomControls } from '../common/OfficePreviewActionsContext';
import { useOfficePreviewZoom } from '../common/OfficeZoomControls';

const t = (key: string) => i18nService.t(key);

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

/** Read-only .pptx preview (pptx-preview), with an HTML and a text fallback. */
export const PptxPreview: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
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
