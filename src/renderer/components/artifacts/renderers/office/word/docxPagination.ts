interface DocxPaginationOptions {
  expectedPageCount?: number | null;
}

interface DocxPaginationResult {
  expectedPageCount: number | null;
  pageCount: number;
  lowFidelity: boolean;
}

interface SourceArticle {
  template: HTMLElement;
  children: HTMLElement[];
}

interface SourcePage {
  page: HTMLElement;
  pageHeight: number;
  articles: SourceArticle[];
  notes: HTMLElement[];
}

interface SourceFlow {
  anchor: HTMLElement;
  articles: SourceArticle[];
  fillRatio: number;
  notes: HTMLElement[];
  pageHeight: number;
  pageTemplates: HTMLElement[];
  sourcePages: HTMLElement[];
}

interface PaginationState {
  anchor: HTMLElement;
  currentArticle: HTMLElement | null;
  currentPage: HTMLElement | null;
  fillRatio: number;
  lowFidelity: boolean;
  pageHeight: number;
  pageTemplates: HTMLElement[];
  pages: HTMLElement[];
}

const DOCX_PAGE_CLASS_NAME = 'docx-preview';
const DOCX_WRAPPER_CLASS_NAME = 'docx-preview-wrapper';
const DEFAULT_PAGE_FILL_RATIO = 0.995;
const MIN_PAGE_FILL_RATIO = 0.94;
const MAX_PAGE_FILL_RATIO = 1;
const LAYOUT_WAIT_TIMEOUT_MS = 2000;
const OVERFLOW_TOLERANCE_PX = 1;

// docx-preview only splits on explicit Word break markers; this pass measures rendered blocks and adds client pages.
export function getDocxExpectedPageCount(wordDocument: unknown): number | null {
  const pages = (wordDocument as { extendedPropsPart?: { props?: { pages?: unknown } } } | null)
    ?.extendedPropsPart
    ?.props
    ?.pages;

  return typeof pages === 'number' && Number.isFinite(pages) && pages > 0 ? pages : null;
}

export async function waitForDocxLayout(container: HTMLElement): Promise<void> {
  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
  const imagePromises = images.map(waitForImage);
  const fontsReady = container.ownerDocument.fonts?.ready.catch(() => undefined) ?? Promise.resolve();

  await withTimeout(Promise.allSettled([...imagePromises, fontsReady]), LAYOUT_WAIT_TIMEOUT_MS);
  await nextAnimationFrame();
  await nextAnimationFrame();
}

export function repaginateDocx(container: HTMLElement, options: DocxPaginationOptions = {}): DocxPaginationResult {
  const wrapper = findDocxWrapper(container);
  const sourcePages = getDirectDocxPages(wrapper);
  const expectedPageCount = sanitizeExpectedPageCount(options.expectedPageCount);

  if (sourcePages.length === 0) {
    return { expectedPageCount, pageCount: 0, lowFidelity: false };
  }

  const fillRatio = resolvePageFillRatio(sourcePages.length, expectedPageCount);
  let lowFidelity = false;

  for (const sourcePagesGroup of groupCompatibleSourcePages(sourcePages)) {
    const source = createSourceFlow(sourcePagesGroup, fillRatio);
    if (!source) continue;

    const state = paginateSourceFlow(source);
    lowFidelity = lowFidelity || state.lowFidelity;
  }

  return {
    expectedPageCount,
    pageCount: getDirectDocxPages(wrapper).length,
    lowFidelity,
  };
}

function findDocxWrapper(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(`.${DOCX_WRAPPER_CLASS_NAME}`) ?? container;
}

function getDirectDocxPages(wrapper: HTMLElement): HTMLElement[] {
  return Array.from(wrapper.children).filter((child): child is HTMLElement => {
    return child instanceof HTMLElement
      && child.tagName === 'SECTION'
      && child.classList.contains(DOCX_PAGE_CLASS_NAME);
  });
}

function groupCompatibleSourcePages(sourcePages: HTMLElement[]): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  let currentGroup: HTMLElement[] = [];
  let currentSignature = '';

  for (const page of sourcePages) {
    const signature = getPageCompatibilitySignature(page);

    if (currentGroup.length === 0 || signature === currentSignature) {
      currentGroup.push(page);
    } else {
      groups.push(currentGroup);
      currentGroup = [page];
    }

    currentSignature = signature;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function getPageCompatibilitySignature(page: HTMLElement): string {
  const style = window.getComputedStyle(page);
  const firstArticle = getDirectChildrenByTag(page, 'ARTICLE')[0];
  const articleStyle = firstArticle ? window.getComputedStyle(firstArticle) : null;

  return [
    roundedStyleValue(style.width),
    roundedStyleValue(style.minHeight),
    roundedStyleValue(style.paddingTop),
    roundedStyleValue(style.paddingRight),
    roundedStyleValue(style.paddingBottom),
    roundedStyleValue(style.paddingLeft),
    articleStyle?.columnCount ?? '',
    roundedStyleValue(articleStyle?.columnGap ?? ''),
  ].join('|');
}

function createSourcePage(page: HTMLElement): SourcePage | null {
  const pageHeight = getPageHeight(page);
  const articles = getDirectChildrenByTag(page, 'ARTICLE').map(article => ({
    template: article.cloneNode(false) as HTMLElement,
    children: Array.from(article.children).filter((child): child is HTMLElement => child instanceof HTMLElement),
  }));

  if (pageHeight <= 0 || articles.length === 0) {
    return null;
  }

  return {
    page,
    pageHeight,
    articles,
    notes: getNoteElements(page),
  };
}

function createSourceFlow(sourcePages: HTMLElement[], fillRatio: number): SourceFlow | null {
  const pages = sourcePages.map(createSourcePage).filter((page): page is SourcePage => page !== null);
  if (pages.length === 0) return null;

  const articles = pages.flatMap(page => page.articles);

  if (articles.every(article => article.children.length === 0)) {
    return null;
  }

  return {
    anchor: sourcePages[0],
    articles,
    fillRatio,
    notes: pages.flatMap(page => page.notes),
    pageHeight: pages[0].pageHeight,
    pageTemplates: sourcePages,
    sourcePages,
  };
}

function paginateSourceFlow(source: SourceFlow): PaginationState {
  const state: PaginationState = {
    anchor: source.anchor,
    currentArticle: null,
    currentPage: null,
    fillRatio: source.fillRatio,
    lowFidelity: false,
    pageHeight: source.pageHeight,
    pageTemplates: source.pageTemplates,
    pages: [],
  };

  for (const article of source.articles) {
    if (article.children.length === 0) continue;

    ensureArticle(state, article.template);

    for (const child of article.children) {
      appendBlockElement(state, article.template, child);
    }
  }

  if (state.pages.length > 0) {
    appendNotesToLastPage(state, source.notes);
    source.sourcePages.forEach(page => page.remove());
  }

  return state;
}

function appendBlockElement(state: PaginationState, articleTemplate: HTMLElement, element: HTMLElement): void {
  ensureArticle(state, articleTemplate);

  if (!state.currentArticle) return;

  state.currentArticle.appendChild(element);
  if (!isPageOverflowing(state)) return;

  element.remove();

  if (element.tagName === 'TABLE' && appendTableRows(state, articleTemplate, element as HTMLTableElement)) {
    return;
  }

  if (element.tagName === 'P' && appendParagraphParts(state, articleTemplate, element)) {
    return;
  }

  appendOversizedElement(state, articleTemplate, element);
}

function appendOversizedElement(
  state: PaginationState,
  articleTemplate: HTMLElement,
  element: HTMLElement,
): void {
  if (currentPageHasMovingContent(state)) {
    startNewPage(state, articleTemplate);
  }

  ensureArticle(state, articleTemplate);
  state.currentArticle?.appendChild(element);

  if (isPageOverflowing(state)) {
    state.lowFidelity = true;
  }
}

function appendParagraphParts(
  state: PaginationState,
  articleTemplate: HTMLElement,
  paragraph: HTMLElement,
): boolean {
  const parts = Array.from(paragraph.childNodes);
  if (parts.length <= 1) return false;

  let currentParagraph = appendEmptyParagraph(state, articleTemplate, paragraph);

  for (const part of parts) {
    currentParagraph.appendChild(part);
    if (!isPageOverflowing(state)) continue;

    part.remove();

    if (currentParagraph.childNodes.length === 0) {
      const shouldMoveToNextPage = hasEarlierMovingContentOnPage(currentParagraph);
      currentParagraph.remove();

      if (shouldMoveToNextPage) {
        startNewPage(state, articleTemplate);
      }

      currentParagraph = appendEmptyParagraph(state, articleTemplate, paragraph);
      currentParagraph.appendChild(part);

      if (isPageOverflowing(state)) {
        state.lowFidelity = true;
      }
      continue;
    }

    startNewPage(state, articleTemplate);
    currentParagraph = appendEmptyParagraph(state, articleTemplate, paragraph);
    currentParagraph.appendChild(part);

    if (isPageOverflowing(state)) {
      state.lowFidelity = true;
    }
  }

  if (currentParagraph.childNodes.length === 0) {
    currentParagraph.remove();
  }

  return true;
}

function appendEmptyParagraph(
  state: PaginationState,
  articleTemplate: HTMLElement,
  paragraph: HTMLElement,
): HTMLElement {
  ensureArticle(state, articleTemplate);
  const clone = paragraph.cloneNode(false) as HTMLElement;
  state.currentArticle?.appendChild(clone);
  return clone;
}

function appendTableRows(
  state: PaginationState,
  articleTemplate: HTMLElement,
  table: HTMLTableElement,
): boolean {
  const rows = Array.from(table.rows);
  if (rows.length <= 1) return false;

  if (table.querySelector('[rowspan]')) {
    state.lowFidelity = true;
  }

  const headerRows = table.tHead ? Array.from(table.tHead.rows).map(row => row.cloneNode(true) as HTMLTableRowElement) : [];
  const headerRowSet = new Set(table.tHead ? Array.from(table.tHead.rows) : []);
  const bodyRows = rows.filter(row => !headerRowSet.has(row));

  if (bodyRows.length === 0) return false;

  let currentTable = appendEmptyTable(state, articleTemplate, table, headerRows);

  for (const row of bodyRows) {
    currentTable.body.appendChild(row);
    if (!isPageOverflowing(state)) continue;

    row.remove();

    if (currentTable.body.children.length === 0) {
      const shouldMoveToNextPage = hasEarlierMovingContentOnPage(currentTable.table);
      currentTable.table.remove();

      if (shouldMoveToNextPage) {
        startNewPage(state, articleTemplate);
      }

      currentTable = appendEmptyTable(state, articleTemplate, table, headerRows);
      currentTable.body.appendChild(row);

      if (isPageOverflowing(state)) {
        state.lowFidelity = true;
      }
      continue;
    }

    startNewPage(state, articleTemplate);
    currentTable = appendEmptyTable(state, articleTemplate, table, headerRows);
    currentTable.body.appendChild(row);

    if (isPageOverflowing(state)) {
      state.lowFidelity = true;
    }
  }

  if (currentTable.body.children.length === 0) {
    currentTable.table.remove();
  }

  return true;
}

function appendEmptyTable(
  state: PaginationState,
  articleTemplate: HTMLElement,
  table: HTMLTableElement,
  headerRows: HTMLTableRowElement[],
): { body: HTMLTableSectionElement; table: HTMLTableElement } {
  ensureArticle(state, articleTemplate);

  const clone = table.cloneNode(false) as HTMLTableElement;
  for (const colGroup of Array.from(table.children).filter(child => child.tagName === 'COLGROUP')) {
    clone.appendChild(colGroup.cloneNode(true));
  }

  if (headerRows.length > 0) {
    const thead = table.ownerDocument.createElement('thead');
    for (const row of headerRows) {
      thead.appendChild(row.cloneNode(true));
    }
    clone.appendChild(thead);
  }

  const body = table.ownerDocument.createElement('tbody');
  clone.appendChild(body);
  state.currentArticle?.appendChild(clone);

  return { body, table: clone };
}

function ensureArticle(state: PaginationState, articleTemplate: HTMLElement): void {
  if (!state.currentPage) {
    startNewPage(state, articleTemplate);
    return;
  }

  if (!state.currentArticle) {
    appendArticleToCurrentPage(state, articleTemplate);
  }
}

function startNewPage(state: PaginationState, articleTemplate: HTMLElement): void {
  const page = createPageShell(resolvePageTemplate(state));
  state.anchor.parentElement?.insertBefore(page, state.anchor);
  state.pageHeight = getPageHeight(page);
  state.currentPage = page;
  state.pages.push(page);
  appendArticleToCurrentPage(state, articleTemplate);
}

function appendArticleToCurrentPage(state: PaginationState, articleTemplate: HTMLElement): void {
  if (!state.currentPage) return;

  const article = articleTemplate.cloneNode(false) as HTMLElement;
  const footer = getFirstDirectChildByTag(state.currentPage, 'FOOTER');
  state.currentPage.insertBefore(article, footer);
  state.currentArticle = article;
}

function createPageShell(sourcePage: HTMLElement): HTMLElement {
  const page = sourcePage.cloneNode(false) as HTMLElement;
  const headers = getDirectChildrenByTag(sourcePage, 'HEADER');
  const footers = getDirectChildrenByTag(sourcePage, 'FOOTER');

  for (const header of headers) {
    page.appendChild(header.cloneNode(true));
  }

  for (const footer of footers) {
    page.appendChild(footer.cloneNode(true));
  }

  return page;
}

function resolvePageTemplate(state: PaginationState): HTMLElement {
  const templateIndex = Math.min(state.pages.length, state.pageTemplates.length - 1);
  return state.pageTemplates[templateIndex];
}

function appendNotesToLastPage(state: PaginationState, notes: HTMLElement[]): void {
  if (notes.length === 0 || state.pages.length === 0) return;

  const lastPage = state.pages[state.pages.length - 1];
  const footer = getFirstDirectChildByTag(lastPage, 'FOOTER');

  for (const note of notes) {
    lastPage.insertBefore(note.cloneNode(true), footer);
  }
}

function currentPageHasMovingContent(state: PaginationState): boolean {
  const page = state.currentPage;
  if (!page) return false;

  return getDirectChildrenByTag(page, 'ARTICLE').some(article => article.children.length > 0);
}

function hasEarlierMovingContentOnPage(element: HTMLElement): boolean {
  if (element.previousElementSibling) return true;

  const article = element.parentElement;
  if (!article || article.tagName !== 'ARTICLE') return false;

  let sibling = article.previousElementSibling;
  while (sibling) {
    if (sibling instanceof HTMLElement && sibling.tagName === 'ARTICLE' && sibling.children.length > 0) {
      return true;
    }
    sibling = sibling.previousElementSibling;
  }

  return false;
}

function isPageOverflowing(state: PaginationState): boolean {
  const page = state.currentPage;
  if (!page) return false;

  const movingBottom = getMovingContentBottom(page);
  if (movingBottom <= 0) return false;

  const pageRect = page.getBoundingClientRect();
  const pageStyle = window.getComputedStyle(page);
  const paddingBottom = parseCssPx(pageStyle.paddingBottom);
  const footerTop = getFirstDirectChildByTag(page, 'FOOTER')?.getBoundingClientRect().top;
  const bottomSafety = state.pageHeight * (1 - state.fillRatio);
  const contentBottom = footerTop ?? pageRect.top + state.pageHeight - paddingBottom;
  const bottomLimit = contentBottom - bottomSafety;

  return movingBottom > bottomLimit + OVERFLOW_TOLERANCE_PX;
}

function getMovingContentBottom(page: HTMLElement): number {
  return getDirectChildrenByTag(page, 'ARTICLE').reduce((bottom, article) => {
    if (article.children.length === 0) {
      return Math.max(bottom, article.getBoundingClientRect().top);
    }

    return Math.max(bottom, getElementChildrenBottom(article));
  }, 0);
}

function getElementChildrenBottom(element: HTMLElement): number {
  return Array.from(element.children).reduce((bottom, child) => {
    if (!(child instanceof HTMLElement)) return bottom;

    const rect = child.getBoundingClientRect();
    const style = window.getComputedStyle(child);
    return Math.max(bottom, rect.bottom + parseCssPx(style.marginBottom));
  }, element.getBoundingClientRect().top);
}

function getNoteElements(page: HTMLElement): HTMLElement[] {
  return Array.from(page.children).filter((child): child is HTMLElement => {
    return child instanceof HTMLElement
      && child.tagName !== 'ARTICLE'
      && child.tagName !== 'HEADER'
      && child.tagName !== 'FOOTER';
  });
}

function getFirstDirectChildByTag(parent: HTMLElement, tagName: string): HTMLElement | null {
  return getDirectChildrenByTag(parent, tagName)[0] ?? null;
}

function getDirectChildrenByTag(parent: HTMLElement, tagName: string): HTMLElement[] {
  return Array.from(parent.children).filter((child): child is HTMLElement => {
    return child instanceof HTMLElement && child.tagName === tagName;
  });
}

function getPageHeight(page: HTMLElement): number {
  const style = window.getComputedStyle(page);
  const minHeight = parseCssPx(style.minHeight);
  const height = parseCssPx(style.height);

  if (minHeight > 0) return minHeight;
  if (height > 0) return height;

  return page.getBoundingClientRect().height;
}

function parseCssPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundedStyleValue(value: string): string {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : value;
}

function resolvePageFillRatio(renderedPageCount: number, expectedPageCount: number | null): number {
  if (!expectedPageCount) {
    return DEFAULT_PAGE_FILL_RATIO;
  }

  if (expectedPageCount < renderedPageCount) {
    const surplusRatio = (renderedPageCount - expectedPageCount) / renderedPageCount;
    const adjustedRatio = DEFAULT_PAGE_FILL_RATIO + surplusRatio * 0.04;
    return clamp(adjustedRatio, MIN_PAGE_FILL_RATIO, MAX_PAGE_FILL_RATIO);
  }

  if (expectedPageCount === renderedPageCount) {
    return DEFAULT_PAGE_FILL_RATIO;
  }

  const deficitRatio = (expectedPageCount - renderedPageCount) / expectedPageCount;
  const adjustedRatio = DEFAULT_PAGE_FILL_RATIO - deficitRatio * 0.08;
  return clamp(adjustedRatio, MIN_PAGE_FILL_RATIO, MAX_PAGE_FILL_RATIO);
}

function sanitizeExpectedPageCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();

  if (image.decode) {
    return image.decode().catch(() => undefined);
  }

  return new Promise(resolve => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => resolve(), { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(undefined), timeoutMs);

    promise.then(
      result => {
        window.clearTimeout(timer);
        resolve(result);
      },
      () => {
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => resolve());
  });
}
