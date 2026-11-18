/**
 * IME composition support for the Word editing surface. The engine lets Chrome compose text
 * natively inside its painted lines and reads the result back when the composition ends, so a
 * few layout details of the painted pages decide whether that text is visible and kept.
 */

/** Set on the editor host while an IME composes; see wordEditor.css. */
const COMPOSING_CLASS = 'lobster-word-composing';
const PREEDIT_SIZE_PROPERTY = '--lobster-word-preedit-size';
const PAGES_LAYER_CLASS = 'docx-pages';
const PAGE_CLASS = 'docx-page';
const PAGE_SELECTOR = `.${PAGE_CLASS}`;
const PAGE_CONTENT_SELECTOR = '.docx-page-content';
const LINE_SELECTOR = '.docx-line';
/** Header and footer boxes, painted inside each page after its editable content. */
const PAGE_FURNITURE_SELECTOR = ':scope > .docx-hf';
/** Text colour pages give runs without their own colour. */
const PAGE_TEXT_COLOR = 'var(--doc-page-text, #000)';
/** Chrome's key code for a key the IME consumed: Enter committing Latin letters, Backspace, arrows. */
const IME_PROCESS_KEY_CODE = 229;

/**
 * Chrome drops an IME composition that starts on the first line of a page when the page before
 * it has a header or footer: those non-editable boxes sit between the two pages' text in the DOM
 * and Chrome anchors the composition to them, keeping only the first keystroke. While the caret
 * is on such a line, hide them from editing and show a static copy outside the editable layer.
 * This has to happen before a composition starts: restyling them during one makes Chrome scroll
 * the composition to the top of the view.
 * Returns the function that restores them, or undefined when nothing needed covering.
 */
function coverPreviousPageFurniture(host: HTMLElement): (() => void) | undefined {
  const anchor = host.ownerDocument.getSelection()?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  const line = element?.closest(LINE_SELECTOR);
  const content = line?.closest(PAGE_CONTENT_SELECTOR);
  const page = content?.closest<HTMLElement>(PAGE_SELECTOR);
  if (!line || !content || !page || !host.contains(page) || content.querySelector(LINE_SELECTOR) !== line) return undefined;
  const previous = page.parentElement?.querySelector<HTMLElement>(
    `:scope > ${PAGE_SELECTOR}[data-page-index="${Number(page.dataset.pageIndex) - 1}"]`,
  );
  const furniture = previous ? [...previous.querySelectorAll<HTMLElement>(PAGE_FURNITURE_SELECTOR)] : [];
  if (!previous || !furniture.length) return undefined;

  // Placed like the page it copies; the host is positioned and the pages layer sits at its origin.
  const cover = host.ownerDocument.createElement('div');
  cover.style.cssText = previous.style.cssText;
  cover.style.color = PAGE_TEXT_COLOR;
  cover.style.pointerEvents = 'none';
  cover.setAttribute('aria-hidden', 'true');
  for (const original of furniture) {
    const copy = original.cloneNode(true) as HTMLElement;
    // Keep engine lookups by paragraph, page or header id from ever finding the copy.
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      for (const { name } of [...node.attributes]) {
        if (name === 'id' || name.startsWith('data-')) node.removeAttribute(name);
      }
    }
    copy.removeAttribute('contenteditable');
    cover.appendChild(copy);
    original.style.visibility = 'hidden';
  }
  host.appendChild(cover);
  return () => {
    cover.remove();
    for (const original of furniture) original.style.removeProperty('visibility');
  };
}

export class WordCompositionTracker {
  private active = false;
  private waiters: (() => void)[] = [];
  private uncover?: () => void;
  /** Pages are rematerialized after paints, replacing the headers and footers that were hidden. */
  private readonly pages = new MutationObserver(records => {
    if (records.some(({ target }) => target instanceof Element
      && (target.classList.contains(PAGE_CLASS) || target.classList.contains(PAGES_LAYER_CLASS)))) this.caretMoved();
  });

  /** `preeditSize` gives the CSS pixel size of the text about to be typed at the caret. */
  constructor(private readonly host: HTMLElement, private readonly preeditSize: () => number) {
    // Bubble phase: the engine's own handlers on the pages layer run first, including any
    // repaint they flush, and all of this still happens before Chrome inserts the text.
    host.addEventListener('keydown', this.holdImeKeys, true);
    host.addEventListener('compositionstart', this.start);
    host.addEventListener('compositionend', this.end);
    host.addEventListener('focusin', this.caretMoved);
    host.addEventListener('focusout', this.focusOut);
    this.pages.observe(host, { childList: true, subtree: true });
  }

  get composing(): boolean { return this.active; }

  /**
   * The engine handles keydown without checking for a composition, so the Enter that commits
   * letters typed through a Chinese IME split the paragraph and lost them, and Backspace while
   * editing pinyin deleted document text. The IME and its composition events own these keys.
   */
  private holdImeKeys = (event: KeyboardEvent): void => {
    if (this.active || event.isComposing || event.keyCode === IME_PROCESS_KEY_CODE) event.stopPropagation();
  };

  /** Call after the engine paints or moves the caret (its `selectionChange` event). */
  caretMoved = (): void => {
    if (this.active) return;
    // Rebuilt every time: a repaint may have replaced the originals or moved their page.
    this.uncover?.();
    this.uncover = coverPreviousPageFurniture(this.host);
  };

  private focusOut = (event: FocusEvent): void => {
    if (this.active || this.host.contains(event.relatedTarget as Node | null)) return;
    this.uncover?.();
    this.uncover = undefined;
  };

  private start = (): void => {
    this.active = true;
    // An empty line paints at font size 0, which would hide the pending text entirely.
    this.host.style.setProperty(PREEDIT_SIZE_PROPERTY, `${this.preeditSize()}px`);
    this.host.classList.add(COMPOSING_CLASS);
    // Normally covered when the caret arrived; covering now still keeps the text.
    this.uncover ??= coverPreviousPageFurniture(this.host);
  };

  /** Runs after the engine has committed and repainted the composed text. */
  private end = (): void => {
    this.finish();
    // Updates were held back while composing; the repaint may have replaced what was covered.
    this.caretMoved();
  };

  private finish(): void {
    this.active = false;
    this.host.classList.remove(COMPOSING_CLASS);
    this.waiters.splice(0).forEach(resolve => resolve());
  }

  /** Resolves once no composition is active, or after `timeoutMs` if one never ends. */
  settled(timeoutMs: number): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  dispose(): void {
    this.pages.disconnect();
    this.finish();
    this.uncover?.();
    this.uncover = undefined;
    this.host.removeEventListener('keydown', this.holdImeKeys, true);
    this.host.removeEventListener('compositionstart', this.start);
    this.host.removeEventListener('compositionend', this.end);
    this.host.removeEventListener('focusin', this.caretMoved);
    this.host.removeEventListener('focusout', this.focusOut);
  }
}
