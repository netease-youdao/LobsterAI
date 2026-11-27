/**
 * Clean rich-text copy for rendered Markdown content.
 *
 * When a user drags to select text in a LobsterAI reply and presses Cmd/Ctrl+C,
 * Chromium serializes every computed style onto inline `<span>` elements —
 * including theme `background-color` / `color` and CSS Color 4 `color(srgb ...)`
 * from `color-mix()` utilities (such as blockquotes or inline code). Rich-text
 * editors that do not understand `color(srgb 0..1)` (e.g. POPO Docs) misparse
 * those values as 0–255 RGB (producing `#010101` black bars with `#000000`
 * text), and dark-mode copies also leak dark backgrounds into light documents.
 *
 * This module intercepts `copy` events that come from rendered Markdown
 * containers (while stepping aside for editors, inputs, and custom copy
 * handlers) and writes exact `text/plain` alongside clean semantic `text/html`
 * stripped of theme colors, background fills, and UI chrome.
 */

const MARKDOWN_COPY_CONTAINER_SELECTOR = '.markdown-content, .sel-markdown';
const EDITABLE_CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
const CODE_MIRROR_SELECTOR = '.cm-editor';

const EXCLUDED_SUBTREE_SELECTOR = [
  '[data-copy-exclude="true"]',
  '.cowork-message-meta',
  '.sr-only',
  'button',
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  '[aria-hidden="true"]',
].join(', ');

const INLINE_SEMANTIC_TAGS = new Set([
  'a',
  'b',
  'code',
  'del',
  'em',
  'i',
  'kbd',
  'mark',
  's',
  'samp',
  'strong',
  'sub',
  'sup',
  'u',
]);

const BLOCK_SEMANTIC_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
]);

const ALLOWED_TEXT_ALIGN_VALUES = new Set(['left', 'center', 'right', 'justify', 'start', 'end']);
const PORTABLE_LINK_PROTOCOL_RE = /^(?:https?|mailto|tel):/i;
const PORTABLE_IMAGE_SRC_RE = /^(?:https?|data):/i;

const COLOR_SRGB_RE = /color\(\s*srgb\s+([^\s/)]+)\s+([^\s/)]+)\s+([^\s/)]+)(?:\s*\/\s*([^\s)]+))?\s*\)/gi;

const parseSrgbComponent = (raw: string): number | null => {
  const token = raw.trim().toLowerCase();
  if (token === 'none') return 0;
  if (token.endsWith('%')) {
    const pct = Number.parseFloat(token.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return Math.min(1, Math.max(0, pct / 100));
  }
  const num = Number.parseFloat(token);
  if (!Number.isFinite(num)) return null;
  return Math.min(1, Math.max(0, num));
};

const formatAlpha = (alpha: number): string => {
  const rounded = Number(alpha.toFixed(4));
  return String(rounded);
};

/**
 * Converts CSS Color 4 `color(srgb r g b [/ a])` expressions into standard
 * CSS Color 3 `rgb(R, G, B)` / `rgba(R, G, B, a)` strings so legacy HTML
 * paste parsers do not misinterpret 0–1 floats as 0–255 integers.
 */
export const normalizeCssColorValue = (value: string): string => {
  if (!value || !/color\(\s*srgb\b/i.test(value)) {
    return value;
  }

  return value.replace(
    COLOR_SRGB_RE,
    (match, rawR: string, rawG: string, rawB: string, rawA?: string) => {
      const r = parseSrgbComponent(rawR);
      const g = parseSrgbComponent(rawG);
      const b = parseSrgbComponent(rawB);
      if (r === null || g === null || b === null) {
        return match;
      }

      const red = Math.round(r * 255);
      const green = Math.round(g * 255);
      const blue = Math.round(b * 255);

      if (rawA === undefined) {
        return `rgb(${red}, ${green}, ${blue})`;
      }

      const alpha = parseSrgbComponent(rawA);
      if (alpha === null) {
        return match;
      }
      if (alpha >= 1) {
        return `rgb(${red}, ${green}, ${blue})`;
      }
      return `rgba(${red}, ${green}, ${blue}, ${formatAlpha(alpha)})`;
    },
  );
};

const toElement = (node: Node | null): Element | null => {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
};

const isInsideEditableControl = (node: Node | null): boolean => {
  const el = toElement(node);
  if (!el) return false;
  if (el.closest(EDITABLE_CONTROL_SELECTOR)) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
};

const isNodeInsideMarkdown = (node: Node | null): boolean => {
  const el = toElement(node);
  return Boolean(el?.closest(MARKDOWN_COPY_CONTAINER_SELECTOR));
};

const rangeIntersectsMarkdown = (range: Range): boolean => {
  if (
    isNodeInsideMarkdown(range.startContainer)
    || isNodeInsideMarkdown(range.endContainer)
    || isNodeInsideMarkdown(range.commonAncestorContainer)
  ) {
    return true;
  }

  const commonEl = toElement(range.commonAncestorContainer);
  if (!commonEl) return false;
  const containers = commonEl.querySelectorAll(MARKDOWN_COPY_CONTAINER_SELECTOR);
  for (const container of containers) {
    if (typeof range.intersectsNode === 'function' && range.intersectsNode(container)) {
      return true;
    }
  }
  return false;
};

const isEligibleSelection = (selection: Selection, target: EventTarget | null): boolean => {
  if (selection.isCollapsed || selection.rangeCount === 0) return false;

  if (target instanceof Node && isInsideEditableControl(target)) {
    return false;
  }

  let intersectsMarkdown = false;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (
      isInsideEditableControl(range.startContainer)
      || isInsideEditableControl(range.endContainer)
    ) {
      return false;
    }

    // Selections strictly inside CodeMirror are handled by CodeMirror's own
    // copy handler (which copies plain source text).
    const commonEl = toElement(range.commonAncestorContainer);
    if (commonEl?.closest(CODE_MIRROR_SELECTOR)) {
      return false;
    }

    if (rangeIntersectsMarkdown(range)) {
      intersectsMarkdown = true;
    }
  }

  return intersectsMarkdown;
};

const unwrapElement = (el: Element): void => {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
};

const hasOnlyBlockElementChildren = (el: Element): boolean => {
  let sawElement = false;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      if ((child.textContent ?? '').trim() !== '') return false;
      continue;
    }
    if (child.nodeType !== 1) continue;
    sawElement = true;
    const tag = (child as Element).tagName.toLowerCase();
    if (!BLOCK_SEMANTIC_TAGS.has(tag)) return false;
  }
  return sawElement;
};

const replaceCodeMirrorWithPreCode = (editorEl: Element, doc: Document): void => {
  const lines = Array.from(editorEl.querySelectorAll('.cm-content .cm-line'))
    .map((line) => line.textContent ?? '');
  const codeText = lines.length > 0
    ? lines.join('\n')
    : (editorEl.querySelector('.cm-content')?.textContent ?? '');

  if (!codeText) {
    editorEl.remove();
    return;
  }

  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  code.textContent = codeText;
  pre.appendChild(code);
  editorEl.replaceWith(pre);
};

const copyAllowedAttributes = (source: Element, target: Element): void => {
  const tag = source.tagName.toLowerCase();
  if (tag === 'a') {
    const href = source.getAttribute('href')?.trim() ?? '';
    if (PORTABLE_LINK_PROTOCOL_RE.test(href)) {
      target.setAttribute('href', href);
    }
    return;
  }

  if (tag === 'img') {
    const src = source.getAttribute('src')?.trim() ?? '';
    if (PORTABLE_IMAGE_SRC_RE.test(src)) {
      target.setAttribute('src', src);
    }
    const alt = source.getAttribute('alt');
    if (alt !== null) target.setAttribute('alt', alt);
    return;
  }

  if (tag === 'th' || tag === 'td') {
    const colspan = source.getAttribute('colspan');
    const rowspan = source.getAttribute('rowspan');
    if (colspan) target.setAttribute('colspan', colspan);
    if (rowspan) target.setAttribute('rowspan', rowspan);
    const align = (source instanceof HTMLElement ? source.style.textAlign : '')
      || source.getAttribute('align')
      || '';
    const normalizedAlign = align.trim().toLowerCase();
    if (ALLOWED_TEXT_ALIGN_VALUES.has(normalizedAlign)) {
      target.setAttribute('style', `text-align: ${normalizedAlign}`);
    }
    return;
  }

  if (tag === 'ol') {
    const start = source.getAttribute('start');
    const type = source.getAttribute('type');
    if (start) target.setAttribute('start', start);
    if (type) target.setAttribute('type', type);
    return;
  }

  if (tag === 'input' && source.getAttribute('type')?.toLowerCase() === 'checkbox') {
    target.setAttribute('type', 'checkbox');
    if (source.hasAttribute('checked') || (source as HTMLInputElement).checked) {
      target.setAttribute('checked', '');
    }
  }
};

const sanitizeElementAttributes = (el: Element): void => {
  const tag = el.tagName.toLowerCase();
  const preserved: Array<[string, string]> = [];

  if (tag === 'a') {
    const href = el.getAttribute('href')?.trim() ?? '';
    if (PORTABLE_LINK_PROTOCOL_RE.test(href)) {
      preserved.push(['href', href]);
    }
  } else if (tag === 'img') {
    const src = el.getAttribute('src')?.trim() ?? '';
    if (PORTABLE_IMAGE_SRC_RE.test(src)) {
      preserved.push(['src', src]);
    }
    const alt = el.getAttribute('alt');
    if (alt !== null) preserved.push(['alt', alt]);
  } else if (tag === 'th' || tag === 'td') {
    const colspan = el.getAttribute('colspan');
    const rowspan = el.getAttribute('rowspan');
    if (colspan) preserved.push(['colspan', colspan]);
    if (rowspan) preserved.push(['rowspan', rowspan]);
    const align = (el instanceof HTMLElement ? el.style.textAlign : '')
      || el.getAttribute('align')
      || '';
    const normalizedAlign = align.trim().toLowerCase();
    if (ALLOWED_TEXT_ALIGN_VALUES.has(normalizedAlign)) {
      preserved.push(['style', `text-align: ${normalizedAlign}`]);
    }
  } else if (tag === 'ol') {
    const start = el.getAttribute('start');
    const type = el.getAttribute('type');
    if (start) preserved.push(['start', start]);
    if (type) preserved.push(['type', type]);
  } else if (tag === 'input') {
    if (el.getAttribute('type')?.toLowerCase() === 'checkbox') {
      preserved.push(['type', 'checkbox']);
      if (el.hasAttribute('checked') || (el as HTMLInputElement).checked) {
        preserved.push(['checked', '']);
      }
    }
  }

  for (const attr of Array.from(el.attributes)) {
    el.removeAttribute(attr.name);
  }
  for (const [name, value] of preserved) {
    el.setAttribute(name, value);
  }
};

const sanitizeFragment = (container: HTMLElement, doc: Document): void => {
  // Convert embedded CodeMirror blocks included in cross-block selections into
  // plain semantic <pre><code> blocks before stripping UI chrome.
  for (const editorEl of Array.from(container.querySelectorAll(CODE_MIRROR_SELECTOR))) {
    replaceCodeMirrorWithPreCode(editorEl, doc);
  }

  // Remove non-content UI elements (code toolbars, buttons, icons, meta rows,
  // screen-reader projections, visual-only KaTeX duplicates).
  for (const excluded of Array.from(container.querySelectorAll(EXCLUDED_SUBTREE_SELECTOR))) {
    excluded.remove();
  }

  // Wrap non-CodeMirror fenced code blocks (<code data-code-block="true">) in
  // <pre> so paste targets recognize them as block code rather than inline code.
  for (const blockCode of Array.from(container.querySelectorAll('code[data-code-block="true"]'))) {
    if (blockCode.parentElement?.tagName.toLowerCase() !== 'pre') {
      const pre = doc.createElement('pre');
      blockCode.replaceWith(pre);
      pre.appendChild(blockCode);
    }
  }

  // Walk bottom-up so unwrapping inner elements informs outer container checks.
  const elements = Array.from(container.querySelectorAll('*')).reverse();
  for (const el of elements) {
    if (!container.contains(el)) continue;
    const tag = el.tagName.toLowerCase();

    if (tag === 'input' && el.getAttribute('type')?.toLowerCase() !== 'checkbox') {
      el.remove();
      continue;
    }

    if (tag === 'img') {
      const src = el.getAttribute('src')?.trim() ?? '';
      if (!PORTABLE_IMAGE_SRC_RE.test(src)) {
        el.remove();
        continue;
      }
    }

    sanitizeElementAttributes(el);

    // Non-portable links (file://, localfile://, kit://) keep their readable
    // label without a broken anchor wrapper.
    if (tag === 'a' && !el.hasAttribute('href')) {
      unwrapElement(el);
      continue;
    }

    if (tag === 'span' && el.attributes.length === 0) {
      unwrapElement(el);
      continue;
    }

    if (tag === 'div' && el.attributes.length === 0 && hasOnlyBlockElementChildren(el)) {
      unwrapElement(el);
      continue;
    }

    if (tag === 'div' && el.attributes.length === 0 && (el.textContent ?? '').trim() === '' && !el.querySelector('img, hr, br')) {
      el.remove();
    }
  }
};

const getDirectChildTags = (container: HTMLElement): Set<string> => {
  const tags = new Set<string>();
  for (const child of Array.from(container.children)) {
    tags.add(child.tagName.toLowerCase());
  }
  return tags;
};

const hasBlockChild = (container: HTMLElement): boolean => {
  for (const child of Array.from(container.children)) {
    if (BLOCK_SEMANTIC_TAGS.has(child.tagName.toLowerCase())) {
      return true;
    }
  }
  return false;
};

const wrapContainerChildren = (container: HTMLElement, wrapper: Element): void => {
  while (container.firstChild) {
    wrapper.appendChild(container.firstChild);
  }
  container.appendChild(wrapper);
};

/**
 * When a selection starts and ends inside an enclosing semantic element (for
 * example, a substring of `<strong>`, `<a>`, `<code>`, `<ul>`, `<table>`, or
 * `<blockquote>`), `Range.cloneContents()` omits that outer tag. Re-wrap the
 * cleaned fragment in the minimal enclosing semantic ancestors up to the
 * Markdown container boundary.
 */
const wrapWithEnclosingAncestors = (
  container: HTMLElement,
  range: Range,
  plainText: string,
  doc: Document,
): void => {
  const boundary = toElement(range.commonAncestorContainer)?.closest(MARKDOWN_COPY_CONTAINER_SELECTOR)
    ?? doc.body;

  let current = toElement(range.commonAncestorContainer);
  while (current && current !== boundary && boundary.contains(current)) {
    const tag = current.tagName.toLowerCase();

    if (tag === 'code' && current.getAttribute('data-code-block') === 'true') {
      const code = doc.createElement('code');
      wrapContainerChildren(container, code);
      if (plainText.includes('\n')) {
        const pre = doc.createElement('pre');
        wrapContainerChildren(container, pre);
      }
    } else if (INLINE_SEMANTIC_TAGS.has(tag)) {
      if (tag === 'a') {
        const href = current.getAttribute('href')?.trim() ?? '';
        if (PORTABLE_LINK_PROTOCOL_RE.test(href)) {
          const anchor = doc.createElement('a');
          copyAllowedAttributes(current, anchor);
          wrapContainerChildren(container, anchor);
        }
      } else {
        const inlineWrapper = doc.createElement(tag);
        wrapContainerChildren(container, inlineWrapper);
      }
    } else if (tag === 'pre' && !getDirectChildTags(container).has('pre')) {
      const pre = doc.createElement('pre');
      wrapContainerChildren(container, pre);
    } else if ((tag === 'ul' || tag === 'ol') && getDirectChildTags(container).has('li')) {
      const list = doc.createElement(tag);
      copyAllowedAttributes(current, list);
      wrapContainerChildren(container, list);
    } else if (tag === 'tr') {
      const direct = getDirectChildTags(container);
      if (direct.has('td') || direct.has('th')) {
        const tr = doc.createElement('tr');
        wrapContainerChildren(container, tr);
      }
    } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      const direct = getDirectChildTags(container);
      if (direct.has('tr')) {
        const section = doc.createElement(tag);
        wrapContainerChildren(container, section);
      }
    } else if (tag === 'table') {
      const direct = getDirectChildTags(container);
      if (direct.has('thead') || direct.has('tbody') || direct.has('tfoot') || direct.has('tr')) {
        const table = doc.createElement('table');
        wrapContainerChildren(container, table);
      }
    } else if (tag === 'blockquote' && hasBlockChild(container) && !getDirectChildTags(container).has('blockquote')) {
      const quote = doc.createElement('blockquote');
      wrapContainerChildren(container, quote);
    }

    current = current.parentElement;
  }
};

export interface CleanCopiedSelection {
  text: string;
  /** Clean semantic HTML, or `null` when the selection is unformatted plain text. */
  html: string | null;
}

/**
 * Serializes a non-collapsed Markdown selection into exact plain text plus
 * clean semantic HTML without theme colors, canvas backgrounds, or CSS Color 4
 * `color(srgb ...)` inline styles. Returns `null` when the selection is outside
 * Markdown content or inside an editable/code-editor control.
 */
export const serializeSelectionAsCleanHtml = (
  selection: Selection | null,
  target: EventTarget | null = null,
): CleanCopiedSelection | null => {
  if (!selection || !isEligibleSelection(selection, target)) {
    return null;
  }

  const firstRange = selection.getRangeAt(0);
  const doc = firstRange.startContainer.ownerDocument ?? document;
  const container = doc.createElement('div');

  for (let i = 0; i < selection.rangeCount; i += 1) {
    container.appendChild(selection.getRangeAt(i).cloneContents());
  }

  const text = selection.toString();
  sanitizeFragment(container, doc);

  if (selection.rangeCount === 1) {
    wrapWithEnclosingAncestors(container, firstRange, text, doc);
  }

  const hasElements = container.children.length > 0;
  if (!text && !hasElements) {
    return null;
  }

  // Unformatted inline text (e.g. selecting a phrase inside a single <p>) is
  // copied as plain text only so paste targets inherit their own typography and
  // never receive stray background/color styles or unwanted paragraph breaks.
  if (!hasElements) {
    return { text, html: null };
  }

  return {
    text,
    html: normalizeCssColorValue(container.innerHTML),
  };
};

export const handleRichTextCopyEvent = (event: ClipboardEvent): boolean => {
  if (event.defaultPrevented || !event.clipboardData) {
    return false;
  }

  const doc = event.target instanceof Node
    ? event.target.ownerDocument ?? document
    : document;
  const selection = doc.getSelection?.() ?? window.getSelection();
  const payload = serializeSelectionAsCleanHtml(selection, event.target);
  if (!payload) {
    return false;
  }

  event.preventDefault();
  event.clipboardData.setData('text/plain', payload.text);
  if (payload.html !== null) {
    event.clipboardData.setData('text/html', payload.html);
  }
  return true;
};

/**
 * Installs the bubble-phase document `copy` listener that produces clean
 * rich-text clipboard HTML for rendered Markdown selections.
 */
export const installCleanRichTextCopy = (targetDocument: Document = document): (() => void) => {
  const listener = (event: ClipboardEvent): void => {
    handleRichTextCopyEvent(event);
  };
  targetDocument.addEventListener('copy', listener);
  return () => {
    targetDocument.removeEventListener('copy', listener);
  };
};
