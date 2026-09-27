import '@docx-editor.dev/core/styles/editor.css';

import type { AutomationHost } from '@docx-editor.dev/core/automation';
import type { EditorSnapshot } from '@docx-editor.dev/core/contracts/editor';
import { commandForSlot, createBrowserAutomationHost, createDocxEditor, type DocxEditorInstance } from '@docx-editor.dev/core/editor';
import { createT, deepMerge, en, type LocaleStrings, type TranslationKey, zhCN } from '@docx-editor.dev/i18n';

import { WordFileError, type WordOpenResult, type WordResult } from '../../shared/artifactPreview/wordEditing';
import { i18nService } from './i18n';
import { installMarkdownDocumentLifecycle } from './markdownDocumentLifecycle';
import { normalizeShellFilePath } from './shellAppsCache';
import { WordCompositionTracker } from './wordComposition';
import { WordDocument, type WordEditorPort } from './wordDocument';
import { createWordFontResolver, prepareWordLayout, type WordFontReportEntry } from './wordFonts';

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
interface WordEditorRegistry {
  sessions: Map<string, WordEditorSession>;
  paths: Map<string, Promise<WordResult<WordEditorSession>>>;
  parking?: HTMLDivElement;
  disposeLifecycle?: () => void;
  disposeChanges?: () => void;
  reportedUnsafe: boolean;
}
const registry: WordEditorRegistry = import.meta.hot?.data.wordEditorRegistry ?? {
  sessions: new Map(), paths: new Map(), reportedUnsafe: false,
};
const { sessions, paths } = registry;
const MAX_CACHED_SESSIONS = 4;
const HistorySlot = { Undo: 'history.undo', Redo: 'history.redo' } as const;

/** One agent call recorded as several engine undo steps, undone and redone together. */
interface AgentHistoryGroup {
  steps: number;
  /** Document revision while this group is at the top of its stack. */
  revision: number;
}

function getParking(): HTMLDivElement {
  if (!registry.parking) {
    const parking = document.createElement('div');
    parking.style.cssText = 'position:fixed;left:-100000px;top:0;width:1000px;height:800px;visibility:hidden;pointer-events:none;';
    parking.setAttribute('aria-hidden', 'true');
    parking.inert = true;
    document.body.appendChild(parking);
    registry.parking = parking;
  }
  return registry.parking;
}

const hasUnsafeEdits = (): boolean => [...sessions.values()].some(session => session.document.unsafe);
const reportState = (): void => {
  const unsafe = hasUnsafeEdits();
  if (unsafe !== registry.reportedUnsafe) {
    try {
      window.electron.artifact.word.setHasUnsafeEdits(unsafe);
      registry.reportedUnsafe = unsafe;
    } catch (error) {
      console.warn('[WordEditor] Could not report unsaved edits:', error);
    }
  }
};

function evictCleanSessions(): void {
  if (sessions.size <= MAX_CACHED_SESSIONS) return;
  for (const [id, session] of sessions) {
    if (sessions.size <= MAX_CACHED_SESSIONS) break;
    if (session.mounted || session.document.dirty || session.document.busy) continue;
    session.dispose();
    sessions.delete(id);
    for (const alias of session.aliases) paths.delete(alias);
  }
}

/** The host element itself moves between the visible view and an offscreen parking area.
 * Core attach/detach remounts from bytes and loses undo, so it is NOT used on React unmount.
 */
export class WordEditorSession implements WordEditorPort {
  readonly host = document.createElement('div');
  readonly document: WordDocument;
  readonly aliases = new Set<string>();
  editor?: DocxEditorInstance;
  mounted = false;
  /** Which document fonts are installed, substituted or missing on this machine. */
  private fontReport: WordFontReportEntry[] = [];
  private agentUndo: AgentHistoryGroup[] = [];
  private agentRedo: AgentHistoryGroup[] = [];
  private readOnly = false;
  private readonly composition: WordCompositionTracker;
  private lastInputAt = -Infinity;
  private stopLocale?: () => void;
  private stopChange?: () => void;
  private stopSnapshot?: () => void;
  private stopError?: () => void;
  private initialization?: Promise<void>;
  private listeners = new Set<() => void>();

  constructor(file: WordOpenResult) {
    this.host.className = 'docx-editor lobster-word-surface';
    getParking().appendChild(this.host);
    this.host.addEventListener('keydown', this.noteInput, true);
    this.host.addEventListener('beforeinput', this.noteInput, true);
    this.composition = new WordCompositionTracker(this.host, () => {
      const halfPoints = this.editor?.getSelectionFormatting()?.fontSizeHalfPoints ?? DEFAULT_FONT_HALF_POINTS;
      return (halfPoints / 2) * CSS_PX_PER_POINT * (this.editor?.getZoom() ?? 1);
    });
    this.document = new WordDocument(file, window.electron.artifact.word, this, reportState);
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

  initialize(): Promise<void> {
    this.initialization ??= this.document.initialize();
    return this.initialization;
  }

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
          api: window.electron.artifact.word,
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
      });
      this.stopError = this.editor.on('error', error => { console.warn('[WordEditor] Editor rejected an operation:', error); });
    }
    this.editor.setMode(EDITOR_MODE.View);
    this.editor.load(bytes);
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
    return new Uint8Array(await this.editor.save());
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

  /** Remember that the last agent call took several engine steps, so one undo reverts it. */
  recordAgentEdit(steps: number): void {
    this.agentRedo = [];
    if (steps > 1) this.agentUndo.push({ steps, revision: this.revision() });
  }

  private replay(slot: typeof HistorySlot[keyof typeof HistorySlot], steps: number): void {
    const command = commandForSlot(slot);
    for (let step = 0; command && step < steps; step++) {
      if (!this.editor?.can(command).ok || !this.editor.exec(command).ok) break;
    }
  }

  /**
   * Undo, treating an agent call as one step while nothing else was edited after it.
   * Returns false when the caller should run the engine's own single-step undo.
   */
  undo(): boolean {
    const group = this.agentUndo[this.agentUndo.length - 1];
    if (!group || group.revision !== this.revision()) {
      this.agentUndo = [];
      this.agentRedo = [];
      return false;
    }
    this.agentUndo.pop();
    this.replay(HistorySlot.Undo, group.steps);
    this.agentRedo.push({ steps: group.steps, revision: this.revision() });
    return true;
  }

  redo(): boolean {
    const group = this.agentRedo[this.agentRedo.length - 1];
    if (!group || group.revision !== this.revision()) {
      this.agentRedo = [];
      return false;
    }
    this.agentRedo.pop();
    this.replay(HistorySlot.Redo, group.steps);
    this.agentUndo.push({ steps: group.steps, revision: this.revision() });
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

  mount(container: HTMLElement): () => void {
    this.mounted = true;
    container.appendChild(this.host);
    evictCleanSessions();
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
    return () => {
      cancelAnimationFrame(frame);
      this.mounted = false;
      getParking().appendChild(this.host);
      void this.document.flush();
      evictCleanSessions();
    };
  }

  dispose(): void {
    this.composition.dispose();
    this.document.dispose();
    this.stopChange?.();
    this.stopSnapshot?.();
    this.stopLocale?.();
    this.stopError?.();
    this.editor?.destroy();
    this.host.remove();
    void window.electron.artifact.word.release(this.document.file.sessionId);
  }
}

export function acquireWordEditor(filePath: string): Promise<WordResult<WordEditorSession>> {
  registry.disposeChanges ??= window.electron.artifact.word.onChanged(sessionId => {
    void sessions.get(sessionId)?.document.refresh();
  });
  registry.disposeLifecycle ??= installMarkdownDocumentLifecycle(window, {
    hasUnsafeEdits,
    flush: async () => { await Promise.all([...sessions.values()].map(session => session.document.flush())); },
  });
  const normalized = normalizeShellFilePath(filePath);
  let pending = paths.get(normalized);
  if (!pending) {
    pending = (async (): Promise<WordResult<WordEditorSession>> => {
      const opened = await window.electron.artifact.word.open(normalized);
      if (!opened.success) return opened;
      let session = sessions.get(opened.value.sessionId);
      if (!session) {
        session = new WordEditorSession(opened.value);
        sessions.set(opened.value.sessionId, session);
      }
      await session.initialize();
      session.aliases.add(normalized);
      const state = session.document.getSnapshot();
      if (!state.ready) {
        session.dispose();
        sessions.delete(opened.value.sessionId);
        return { success: false, code: state.errorCode ?? WordFileError.Unsupported };
      }
      return { success: true, value: session };
    })().catch(error => {
      console.error('[WordEditor] Could not open document:', error);
      return { success: false, code: WordFileError.Io } as const;
    });
    paths.set(normalized, pending);
    void pending.then(result => { if (!result.success) paths.delete(normalized); });
  }
  return pending;
}

/** Route refreshes through the live session instead of replacing its Redux artifact bytes. */
export async function refreshOpenWordEditor(filePath: string): Promise<boolean> {
  const pending = paths.get(normalizeShellFilePath(filePath));
  if (!pending) return false;
  const result = await pending;
  if (!result.success) return false;
  await result.value.document.refresh();
  return true;
}

if (import.meta.hot) {
  // Keep handles, DOM, listeners and exit protection together across development
  // updates too. A new registry could open a second model for the same file.
  import.meta.hot.data.wordEditorRegistry = registry;
  import.meta.hot.dispose(() => {
    for (const session of sessions.values()) void session.document.flush();
  });
}
