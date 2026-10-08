import DOMPurify from 'dompurify';

import {
  getLibraryHtmlThumbnailStampColor,
  HtmlThumbnailLayout,
  HtmlThumbnailLimits,
} from '../../shared/library/htmlThumbnail';
import type { LibraryThumbnailRenderRequest } from '../../shared/library/thumbnail';
import {
  getHtmlThumbnailAnimationWaitMs,
  type HtmlThumbnailAnimationTiming,
} from './htmlThumbnailAnimation';

const collectAnimationTimings = (document: Document): HtmlThumbnailAnimationTiming[] => {
  const timings: HtmlThumbnailAnimationTiming[] = [];
  const collectStyle = (style: CSSStyleDeclaration): void => {
    if (!style.animationName) return;
    timings.push({
      names: style.animationName,
      durations: style.animationDuration,
      delays: style.animationDelay,
      iterations: style.animationIterationCount,
    });
  };
  const hasMatchingElement = (selector: string): boolean => {
    try {
      // Pseudo-elements have no DOM node; match their originating element instead.
      return document.querySelector(selector.replace(/::(?:before|after)\b/g, '')) !== null;
    } catch {
      return false;
    }
  };
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && hasMatchingElement(rule.selectorText)) collectStyle(rule.style);
      else if (rule instanceof CSSGroupingRule) visit(rule.cssRules);
    }
  };
  for (const style of Array.from(document.querySelectorAll('style'))) {
    // Parse without attaching source styles to the trusted parent document.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(style.textContent || '');
    visit(sheet.cssRules);
  }
  document.querySelectorAll<HTMLElement>('[style]').forEach(element => collectStyle(element.style));
  return timings;
};

export const renderHtmlThumbnail = async (
  root: HTMLElement,
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const sanitized = DOMPurify.sanitize(new TextDecoder('utf-8').decode(bytes), {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  });
  const document = new DOMParser().parseFromString(sanitized, 'text/html');
  const animationWaitMs = getHtmlThumbnailAnimationWaitMs(collectAnimationTimings(document));
  const scale = HtmlThumbnailLayout.FrameScale;
  const color = getLibraryHtmlThumbnailStampColor(request.renderGeneration);
  // A body child would inherit body opacity/filter and its fixed-position containing
  // block could change with body transforms. Keep the marker on the document root.
  const markerStyle = document.createElement('style');
  document.documentElement.setAttribute('data-library-thumbnail-stamp', String(request.renderGeneration));
  markerStyle.textContent = `html[data-library-thumbnail-stamp]::after {
    all: initial !important; content: '' !important; display: block !important;
    position: fixed !important; left: 0 !important; top: ${request.height * scale}px !important;
    width: ${request.width * scale}px !important; height: ${HtmlThumbnailLayout.ChildStampHeight * scale}px !important;
    background: rgb(${color.red}, ${color.green}, ${color.blue}) !important;
    opacity: 1 !important; visibility: visible !important; z-index: 2147483647 !important;
    transform: none !important; animation: none !important; transition: none !important;
    pointer-events: none !important;
  }`;
  document.head.appendChild(markerStyle);
  const iframe = window.document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.className = 'thumbnail-html-frame';
  iframe.style.width = `${request.width * scale}px`;
  iframe.style.height = `${(request.height + HtmlThumbnailLayout.ChildStampHeight) * scale}px`;
  iframe.style.transform = `scale(${1 / scale})`;
  await new Promise<void>((resolve, reject) => {
    let animationTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(loadTimer);
      if (animationTimer) clearTimeout(animationTimer);
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
    };
    const onLoad = (): void => {
      clearTimeout(loadTimer);
      iframe.removeEventListener('load', onLoad);
      animationTimer = setTimeout(() => { cleanup(); resolve(); }, animationWaitMs);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('HTML preview could not be loaded'));
    };
    const loadTimer = setTimeout(() => {
      cleanup();
      reject(new Error('HTML preview timed out'));
    }, HtmlThumbnailLimits.LoadTimeoutMs);
    // Register before setting srcdoc/inserting the frame so a fast load cannot be missed.
    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', onError);
    iframe.srcdoc = '<!doctype html>' + document.documentElement.outerHTML;
    root.appendChild(iframe);
  });
};
