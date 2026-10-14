import '@docx-editor.dev/core/styles/editor.css';

import type { AutomationHost } from '@docx-editor.dev/core/automation';
import type { EditorSnapshot } from '@docx-editor.dev/core/contracts/editor';
import { commandForSlot, createBrowserAutomationHost, createDocxEditor, type DocxEditorInstance } from '@docx-editor.dev/core/editor';
import { createT, deepMerge, en, type LocaleStrings, type TranslationKey, zhCN } from '@docx-editor.dev/i18n';

import type { OfficeOpenResult } from '../../../../shared/office/core/officeFile';
import { WORD_PACKAGE_LIMITS, type WordPackageInfo } from '../../../../shared/office/word/wordFile';
import { i18nService } from '../../i18n';
import { createOfficeEditorRegistry } from '../core/officeEditorRegistry';
import { OfficeEditorSession, type OfficeSessionContext } from '../core/officeEditorSession';
import { WordCompositionTracker } from './wordComposition';
import { createWordFontResolver, prepareWordLayout, type WordFontReportEntry } from './wordFonts';
import { prepareWordImage, WordImageError } from './wordImages';
import { insertPictureAtCaret, insertTableAtCaret, type MissedPicture, missedPicture, selectMissedPicture } from './wordInsertion';

const EDITOR_MODE = { Edit: 'edit', View: 'view' } as const;
/** How `getEditingMode()` names the viewing mode set through `EDITOR_MODE.View`. */
const ENGINE_VIEWING_MODE = 'viewing';
const ZOOM_MODE = { Fit: 'fit', Fixed: 'fixed' } as const;
const SHAPED_MEASURER = 'shaped';
const CARET_SELECTOR = '.docx-editor-one-surface__caret';
const SCROLL_CONTAINER_SELECTOR = '.docx-editor__scroll-container';
const CSS_PX_PER_POINT = 96 / 72;
/** Word's default body size (11 pt) when the selection reports none. */
const DEFAULT_FONT_HALF_POINTS = 22;
/** An autosave waits this long at most for an IME composition to finish. */
const COMPOSITION_SAVE_WAIT_MS = 10_000;
/** Caret moves this soon after a key press or input event count as typing, not clicking. */
const TYPING_WINDOW_MS = 1_000;
/** Room kept below the caret while typing: a fifth of the viewport, within these bounds. */
const CARET_ROOM = { ratio: 0.2, min: 48, max: 160 } as const;
const AUTOSAVE_DELAY_MS = 700;
/** The Word bridge, with the installed-font calls next to the shared file channels. */
const wordBridge = () => window.electron.artifact.office.word;
const HistorySlot = { Undo: 'history.undo', Redo: 'history.redo' } as const;

/** One edit made of several engine undo steps (an agent call, a table at the caret), undone and redone together. */
interface EditStepGroup {
  steps: number;
  /** Document revision while this group is at the top of its stack. */
  revision: number;
}

/**
 * One open document. Its host element moves between the visible view and the parking area:
 * core attach/detach remounts from bytes and loses undo, so it is NOT used on React unmount.
 */
export class WordEditorSession extends OfficeEditorSession<WordPackageInfo> {
  editor?: DocxEditorInstance;
  /** Which document fonts are installed, substituted or missing on this machine. */
  private fontReport: WordFontReportEntry[] = [];
  private groupedUndo: EditStepGroup[] = [];
  private groupedRedo: EditStepGroup[] = [];
  private readOnly = false;
  /** Package size as last opened or saved, plus pictures inserted since. */
  private packageBytes = 0;
  private insertingImage = false;
  /** A picture a click landed on without the engine selecting it; selected once the click is over. */
  private missedPicture?: MissedPicture;
  private readonly composition: WordCompositionTracker;
  private lastInputAt = -Infinity;
  private stopLocale?: () => void;
  private stopChange?: () => void;
  private stopSnapshot?: () => void;
  private stopError?: () => void;
  private listeners = new Set<() => void>();

  constructor(file: OfficeOpenResult<WordPackageInfo>, context: OfficeSessionContext<WordPackageInfo>) {
    super(file, context, { hostClassName: 'docx-editor lobster-word-surface', autosaveDelayMs: AUTOSAVE_DELAY_MS, logTag: '[WordDocument]' });
    this.host.addEventListener('keydown', this.noteInput, true);
    this.host.addEventListener('beforeinput', this.noteInput, true);
    this.host.addEventListener('pointerup', this.afterPointerUp, true);
    this.composition = new WordCompositionTracker(this.host, () => {
      const halfPoints = this.editor?.getSelectionFormatting()?.fontSizeHalfPoints ?? DEFAULT_FONT_HALF_POINTS;
      return (halfPoints / 2) * CSS_PX_PER_POINT * (this.editor?.getZoom() ?? 1);
    });
  }

  private noteInput = (): void => { this.lastInputAt = performance.now(); };

  /**
   * The engine scrolls only until the caret is 24px inside the viewport, so typing at the bottom
   * edge shows nothing of what follows. Keep some room below a caret that is on screen.
   */
  private keepCaretRoom(): void {
    if (!this.mounted || performance.now() - this.lastInputAt > TYPING_WINDOW_MS) return;
    const caret = this.host.querySelector(CARET_SELECTOR);
    const scroller = this.host.closest<HTMLElement>(SCROLL_CONTAINER_SELECTOR);
    if (!caret || !scroller) return;
    const view = scroller.getBoundingClientRect();
    const rect = caret.getBoundingClientRect();
    if (rect.top < view.top || rect.bottom > view.bottom) return;
    const room = Math.min(CARET_ROOM.max, Math.max(CARET_ROOM.min, view.height * CARET_ROOM.ratio));
    const shortfall = rect.bottom + room - view.bottom;
    if (shortfall > 0) scroller.scrollTop += shortfall;
  }

  /** The engine reads the caret back from the browser's selection until a click is over. */
  private afterPointerUp = (): void => {
    if (this.missedPicture) setTimeout(this.selectMissedPicture, 0);
  };

  private selectMissedPicture = (): void => {
    const picture = this.missedPicture;
    this.missedPicture = undefined;
    if (picture && this.editor) selectMissedPicture(this.editor, picture);
  };

  getEditorSnapshot = (): EditorSnapshot | undefined => this.editor?.snapshot();
  getFontReport = (): WordFontReportEntry[] => this.fontReport;
  subscribeEditor = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify = (): void => { this.listeners.forEach(listener => listener()); };

  async load(bytes: Uint8Array): Promise<void> {
    await prepareWordLayout();
    if (!this.editor) {
      this.editor = createDocxEditor({
        container: this.host, mode: EDITOR_MODE.View, zoomMode: 'auto',
        // Resolved per load from the families the parsed document names; see wordFonts.ts.
        fonts: createWordFontResolver({
          api: wordBridge(),
          declarations: () => this.document.packageInfo.fonts,
          onReport: report => { this.fontReport = report; this.notify(); },
        }),
        onFontError: error => { console.warn('[WordEditor] Font rejected:', error.code, error.request?.family); },
      });
      const syncLocale = () => {
        const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en';
        this.editor?.setLocale(locale);
        const translate = createT(locale === 'zh-CN' ? deepMerge(en, zhCN) as LocaleStrings : en, locale);
        this.editor?.setTranslate((key, params) => translate(key as TranslationKey, params));
      };
      syncLocale();
      this.stopLocale = i18nService.subscribe(syncLocale);
      this.stopChange = this.editor.on('change', () => { this.document.changed(); this.notify(); });
      // Emitted after the engine has painted and scrolled to the caret; 'change' fires before that.
      this.stopSnapshot = this.editor.on('selectionChange', () => {
        this.notify();
        this.keepCaretRoom();
        this.composition.caretMoved();
        this.missedPicture = this.editor && missedPicture(this.editor);
      });
      this.stopError = this.editor.on('error', error => { console.warn('[WordEditor] Editor rejected an operation:', error); });
    }
    this.editor.setMode(EDITOR_MODE.View);
    this.editor.load(bytes);
    this.packageBytes = bytes.byteLength;
    // Opening and font admission both run asynchronously, including for embedded fonts.
    const deadline = Date.now() + 30000;
    while (true) {
      const state = this.editor.snapshot();
      if (state.parseError) throw new Error(state.parseError);
      if (!state.isLoading && !state.isOpening && !this.editor.fontMeasurement().resolving) {
        // Review or protected content is shown as it is, without an editing check.
        if (this.document.locked) break;
        // snapshot.editable includes the current viewing mode, not just file capability.
        this.editor.setMode(EDITOR_MODE.Edit);
        if (!this.editor.snapshot().editable || this.editor.fontMeasurement().measurer !== SHAPED_MEASURER) {
          this.editor.setMode(EDITOR_MODE.View);
          throw new Error('Document cannot be edited with shaped fonts');
        }
        break;
      }
      if (Date.now() > deadline) throw new Error('Word editor opening timed out');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    this.editor.setMode(this.readOnly || this.document.locked ? EDITOR_MODE.View : EDITOR_MODE.Edit);
    this.notify();
  }

  async save(): Promise<Uint8Array> {
    // Exporting flushes the engine's pending input and paint; like the engine's own refresh
    // capture, wait for an IME composition to finish first.
    await this.composition.settled(COMPOSITION_SAVE_WAIT_MS);
    if (!this.editor) throw new Error('Word editor is not ready');
    const bytes = new Uint8Array(await this.editor.save());
    this.packageBytes = bytes.byteLength;
    return bytes;
  }

  /** Word's table grid: a table of this size at the caret, undone in one step. */
  insertTable(rows: number, cols: number): boolean {
    if (!this.editor) return false;
    const steps = insertTableAtCaret(this.editor, rows, cols);
    if (steps) this.recordEditSteps(steps);
    this.editor.focus();
    return steps > 0;
  }

  /** Inserts a picture at the caret at its natural size; the engine scales it down to fit. */
  async insertImage(bytes: Uint8Array): Promise<WordImageError | null> {
    if (this.insertingImage) return null;
    this.insertingImage = true;
    try {
      const prepared = await prepareWordImage(bytes);
      if (!prepared.ok) return prepared.error;
      const { image } = prepared;
      // Saving refuses a package the editor could not open again.
      if (this.packageBytes + image.bytes.byteLength > WORD_PACKAGE_LIMITS.maxFileBytes) return WordImageError.TooLarge;
      const editor = this.editor;
      if (!editor) return WordImageError.Rejected;
      // Focusing reads the caret back from the browser's selection, so it goes before the caret moves.
      editor.focus();
      const result = await insertPictureAtCaret(editor, image);
      if (!result.ok) {
        console.warn('[WordEditor] Picture insertion refused:', result.reason);
        return WordImageError.Rejected;
      }
      this.packageBytes += image.bytes.byteLength;
      return null;
    } finally {
      this.insertingImage = false;
    }
  }

  /** Run one agent call against the live document through the engine's automation protocol. */
  withAutomation<T>(operation: (host: AutomationHost) => T): T {
    if (!this.editor) throw new Error('Word editor is not ready');
    const host = createBrowserAutomationHost(this.editor);
    try {
      return operation(host);
    } finally {
      host.dispose();
    }
  }

  private revision(): number {
    return this.editor?.getDocumentHandle().revision ?? -1;
  }

  /** Remember that the last edit took several engine steps, so one undo reverts it. */
  recordEditSteps(steps: number): void {
    this.groupedRedo = [];
    if (steps > 1) this.groupedUndo.push({ steps, revision: this.revision() });
  }

  private replay(slot: typeof HistorySlot[keyof typeof HistorySlot], steps: number): void {
    const command = commandForSlot(slot);
    for (let step = 0; command && step < steps; step++) {
      if (!this.editor?.can(command).ok || !this.editor.exec(command).ok) break;
    }
  }

  /**
   * Undo, treating a multi-step edit as one step while nothing else was edited after it.
   * Returns false when the caller should run the engine's own single-step undo.
   */
  undo(): boolean {
    const group = this.groupedUndo[this.groupedUndo.length - 1];
    if (!group || group.revision !== this.revision()) {
      this.groupedUndo = [];
      this.groupedRedo = [];
      return false;
    }
    this.groupedUndo.pop();
    this.replay(HistorySlot.Undo, group.steps);
    this.groupedRedo.push({ steps: group.steps, revision: this.revision() });
    return true;
  }

  redo(): boolean {
    const group = this.groupedRedo[this.groupedRedo.length - 1];
    if (!group || group.revision !== this.revision()) {
      this.groupedRedo = [];
      return false;
    }
    this.groupedRedo.pop();
    this.replay(HistorySlot.Redo, group.steps);
    this.groupedUndo.push({ steps: group.steps, revision: this.revision() });
    return true;
  }

  /** The reader's current selection, so an agent can act on "this paragraph". */
  selectionSummary(): { text: string; paragraphs: string[] } | undefined {
    const editor = this.editor;
    if (!editor) return undefined;
    const text = editor.query({ type: 'selectedText' });
    const range = editor.query({ type: 'selection' });
    const paragraphs = range ? [range.from, range.to].flatMap(end => ('paraId' in end ? [end.paraId.toUpperCase()] : [])) : [];
    if (!text && !paragraphs.length) return undefined;
    return { text, paragraphs: [...new Set(paragraphs)] };
  }

  /** Bring a paragraph the agent changed into view. */
  reveal(paragraphId: string): void {
    try {
      this.editor?.scrollToAnchor({ paraId: paragraphId });
    } catch (error) {
      console.debug('[WordEditor] Could not scroll to the edited paragraph:', error);
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    // Re-applying the current mode is not free: the engine rebuilds its editing state and emits a
    // selection change each time, and callers reach here after every autosave.
    if (!this.editor || (this.editor.getEditingMode() === ENGINE_VIEWING_MODE) === readOnly) return;
    this.editor.setMode(readOnly ? EDITOR_MODE.View : EDITOR_MODE.Edit);
  }

  protected override shown(): () => void {
    const frame = requestAnimationFrame(() => {
      const mode = this.editor?.getZoomMode();
      // Moving the live plane changes its scroll viewport. Rebind core's fit
      // observer without reopening bytes or replacing the undo history.
      if (mode?.type === ZOOM_MODE.Fit) {
        this.editor?.setZoomMode({ type: ZOOM_MODE.Fixed });
        this.editor?.setZoomMode(mode);
      }
      this.editor?.relayout();
      this.composition.caretMoved();
    });
    return () => { cancelAnimationFrame(frame); };
  }

  protected disposeEditor(): void {
    this.composition.dispose();
    this.stopChange?.();
    this.stopSnapshot?.();
    this.stopLocale?.();
    this.stopError?.();
    this.editor?.destroy();
  }
}

const registry = createOfficeEditorRegistry<WordPackageInfo, WordEditorSession>({
  bridge: wordBridge,
  create: (file, context) => new WordEditorSession(file, context),
  maxCachedSessions: 4,
  logTag: '[WordEditor]',
  hot: import.meta.hot,
  hotKey: 'wordEditorRegistry',
});

export const acquireWordEditor = registry.acquire;
/** Route refreshes through the live session instead of replacing its Redux artifact bytes. */
export const refreshOpenWordEditor = registry.refresh;
