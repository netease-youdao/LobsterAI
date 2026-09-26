import './markdownEditor.css';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, type Extension, Prec, Transaction } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';
import React, { useEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';

import {
  completeCodeFence,
  cursorLeftOverMarkup,
  cursorLineStartSmart,
  deleteForwardOverMarkup,
  deleteHeadingMarkup,
  InlineMarkup,
  insertLineAboveHeading,
  markdownShiftTab,
  markdownTab,
  toggleInlineMarkup,
} from './markdownEditorCommands';
import {
  markdownLiveInteraction,
  markdownLivePreview,
  markdownMathSyntax,
  type MarkdownPreviewOptions,
  markdownSourceFrontmatter,
} from './markdownLivePreview';
import { applyMarkdownSourceChanges, normalizeMarkdownLineEndings } from './markdownSourceEdits';

interface MarkdownEditorProps extends MarkdownPreviewOptions {
  content: string;
  sourceView: boolean;
  /** The file is still loading; show its last known content without accepting input. */
  readOnly?: boolean;
  onChange: (content: string) => void;
  onFocus?: () => void;
  onBlur: () => void;
}

const t = (key: string) => i18nService.t(key);

/** Marks documents replaced from outside the editor, which must not be written back. */
const externalContent = Annotation.define<boolean>();

/** Static token classes, so code colors can follow the light and dark app themes in CSS. */
const markdownHighlighter = tagHighlighter([
  { tag: tags.keyword, class: 'md-tok-keyword' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], class: 'md-tok-name' },
  { tag: [tags.function(tags.variableName), tags.labelName], class: 'md-tok-function' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], class: 'md-tok-constant' },
  { tag: [tags.definition(tags.name), tags.separator], class: 'md-tok-definition' },
  {
    tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
    class: 'md-tok-type',
  },
  { tag: [tags.operator, tags.operatorKeyword, tags.escape, tags.regexp, tags.special(tags.string)], class: 'md-tok-operator' },
  { tag: tags.url, class: 'md-tok-url' },
  { tag: [tags.meta, tags.comment], class: 'md-tok-comment' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], class: 'md-tok-atom' },
  { tag: [tags.string, tags.inserted], class: 'md-tok-string' },
  { tag: tags.processingInstruction, class: 'md-tok-mark' },
  { tag: tags.invalid, class: 'md-tok-invalid' },
  { tag: tags.heading, class: 'md-tok-heading' },
  { tag: tags.emphasis, class: 'md-tok-emphasis' },
  { tag: tags.strong, class: 'md-tok-strong' },
  { tag: tags.strikethrough, class: 'md-tok-strike' },
  { tag: tags.link, class: 'md-tok-link' },
  { tag: tags.monospace, class: 'md-tok-monospace' },
  { tag: tags.quote, class: 'md-tok-quote' },
  { tag: tags.contentSeparator, class: 'md-tok-separator' },
]);

const editingKeymap = keymap.of([
  { key: 'Mod-b', run: toggleInlineMarkup(InlineMarkup.Strong) },
  { key: 'Mod-i', run: toggleInlineMarkup(InlineMarkup.Emphasis) },
  { key: 'Mod-e', run: toggleInlineMarkup(InlineMarkup.Code) },
  { key: 'Mod-Shift-x', run: toggleInlineMarkup(InlineMarkup.Strike) },
  { key: 'Tab', run: markdownTab, shift: markdownShiftTab },
  { key: 'Enter', run: completeCodeFence },
]);

/** Behaviour that treats hidden list, quote and heading markup like a word processor does. */
const liveKeymap = Prec.high(keymap.of([
  { key: 'Backspace', run: deleteHeadingMarkup },
  { key: 'Enter', run: insertLineAboveHeading },
  { key: 'Delete', run: deleteForwardOverMarkup },
  { key: 'ArrowLeft', run: cursorLeftOverMarkup(false), shift: cursorLeftOverMarkup(true) },
  { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: cursorLeftOverMarkup(false), shift: cursorLeftOverMarkup(true) },
  { key: 'Home', run: view => cursorLineStartSmart(view, false), shift: view => cursorLineStartSmart(view, true) },
  { mac: 'Cmd-ArrowLeft', run: view => cursorLineStartSmart(view, false), shift: view => cursorLineStartSmart(view, true) },
]));

const searchPhrases = () => EditorState.phrases.of({
  Find: t('markdownSearchFind'),
  Replace: t('markdownSearchReplace'),
  next: t('markdownSearchNext'),
  previous: t('markdownSearchPrevious'),
  all: t('markdownSearchAll'),
  'match case': t('markdownSearchMatchCase'),
  regexp: t('markdownSearchRegexp'),
  'by word': t('markdownSearchByWord'),
  replace: t('markdownSearchReplaceOne'),
  'replace all': t('markdownSearchReplaceAll'),
  close: t('markdownSearchClose'),
  'current match': t('markdownSearchCurrentMatch'),
  'replaced $ matches': t('markdownSearchReplacedMatches'),
  'replaced match on line $': t('markdownSearchReplacedMatchOnLine'),
  'on line': t('markdownSearchOnLine'),
  'Go to line': t('markdownSearchGoToLine'),
  go: t('markdownSearchGo'),
});

const editability = (readOnly: boolean): Extension => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

const presentation = (sourceView: boolean, options: MarkdownPreviewOptions): Extension => (sourceView
  ? [lineNumbers(), markdownSourceFrontmatter]
  : [markdownLivePreview(options), liveKeymap]);

/** The smallest single replacement that turns one text into another, so the view keeps its place. */
function minimalReplacement(current: string, next: string): { from: number; to: number; insert: string } {
  let from = 0;
  const shortest = Math.min(current.length, next.length);
  while (from < shortest && current.charCodeAt(from) === next.charCodeAt(from)) from++;
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > from && nextEnd > from && current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)) {
    currentEnd--;
    nextEnd--;
  }
  return { from, to: currentEnd, insert: next.slice(from, nextEnd) };
}

/** A document position near the top of the viewport, or the caret when it is on screen. */
function scrollAnchor(view: EditorView): { position: number; offset: number } | null {
  const rect = view.scrollDOM.getBoundingClientRect();
  const head = view.state.selection.main.head;
  const caret = view.hasFocus ? view.coordsAtPos(head) : null;
  if (caret && caret.top >= rect.top && caret.bottom <= rect.bottom) {
    return { position: head, offset: caret.top - rect.top };
  }
  const position = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 4 }, false);
  const line = view.lineBlockAt(position);
  return { position: line.from, offset: Math.max(0, line.top + view.documentTop - rect.top) };
}

const MarkdownEditor: React.FC<MarkdownEditorProps> = props => {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const rawContent = useRef(props.content);
  const mode = useRef(new Compartment());
  const undoHistory = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const appliedSourceView = useRef(props.sourceView);
  const previewOptions = useRef<MarkdownPreviewOptions>({
    resolveLocalFilePath: (href, text) => propsRef.current.resolveLocalFilePath?.(href, text) ?? null,
  });

  useEffect(() => {
    if (!rootRef.current) return;
    const initial = propsRef.current;
    rawContent.current = initial.content;
    const view = new EditorView({
      parent: rootRef.current,
      state: EditorState.create({
        doc: normalizeMarkdownLineEndings(initial.content),
        extensions: [
          markdown({ base: markdownLanguage, extensions: [...GFM, markdownMathSyntax], codeLanguages: languages }),
          undoHistory.current.of(history()),
          editable.current.of(editability(Boolean(initial.readOnly))),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          editingKeymap,
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          search({ top: true }),
          searchPhrases(),
          placeholder(t('markdownEditorPlaceholder')),
          EditorView.contentAttributes.of({ 'aria-label': t('markdownEditorLabel'), 'aria-multiline': 'true' }),
          syntaxHighlighting(markdownHighlighter),
          markdownLiveInteraction,
          EditorView.domEventHandlers({
            focus: () => { propsRef.current.onFocus?.(); },
            blur: () => { propsRef.current.onBlur(); },
          }),
          EditorView.updateListener.of(update => {
            let changed = false;
            for (const transaction of update.transactions) {
              if (!transaction.docChanged || transaction.annotation(externalContent)) continue;
              rawContent.current = applyMarkdownSourceChanges(rawContent.current, transaction.changes);
              changed = true;
            }
            if (changed) propsRef.current.onChange(rawContent.current);
          }),
          mode.current.of(presentation(initial.sourceView, previewOptions.current)),
        ],
      }),
    });
    editorRef.current = view;
    return () => { view.destroy(); editorRef.current = null; };
  }, []);

  useEffect(() => {
    const view = editorRef.current;
    if (!view || appliedSourceView.current === props.sourceView) return;
    appliedSourceView.current = props.sourceView;
    // Keep the same passage on screen: the two presentations have different line heights.
    const anchor = scrollAnchor(view);
    view.dispatch({
      effects: [
        mode.current.reconfigure(presentation(props.sourceView, previewOptions.current)),
        ...(anchor ? [EditorView.scrollIntoView(anchor.position, { y: 'start', yMargin: anchor.offset })] : []),
      ],
    });
  }, [props.sourceView]);

  useEffect(() => {
    editorRef.current?.dispatch({ effects: editable.current.reconfigure(editability(Boolean(props.readOnly))) });
  }, [props.readOnly]);

  useEffect(() => {
    const view = editorRef.current;
    if (!view || props.content === rawContent.current) return;
    // Our own edits never reach this branch, so autosave cannot move the caret.
    rawContent.current = props.content;
    const current = view.state.doc.toString();
    const next = normalizeMarkdownLineEndings(props.content);
    if (current !== next) {
      // A minimal change keeps the scroll position, selection and rendered blocks around it.
      view.dispatch({
        changes: minimalReplacement(current, next),
        annotations: [externalContent.of(true), Transaction.addToHistory.of(false)],
      });
    }
    // External updates and explicit conflict resolution start a fresh undo history.
    view.dispatch({ effects: undoHistory.current.reconfigure([]) });
    view.dispatch({ effects: undoHistory.current.reconfigure(history()) });
  }, [props.content]);

  return <div ref={rootRef} className={`markdown-file-editor ${props.sourceView ? 'md-source-view' : 'md-live-view'}`} />;
};

export default MarkdownEditor;
