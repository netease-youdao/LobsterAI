import './markdownEditor.css';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';
import React, { useEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';

import { markdownLivePreview, markdownMathSyntax, type MarkdownPreviewOptions } from './markdownLivePreview';
import { applyMarkdownSourceChanges, normalizeMarkdownLineEndings } from './markdownSourceEdits';

interface MarkdownEditorProps extends MarkdownPreviewOptions {
  content: string;
  sourceView: boolean;
  onChange: (content: string) => void;
  onBlur: () => void;
}

const liveHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--lobster-primary)' },
  { tag: tags.comment, color: 'var(--lobster-text-muted)' },
  { tag: tags.string, color: 'var(--lobster-text-secondary)' },
]);

const MarkdownEditor: React.FC<MarkdownEditorProps> = props => {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const rawContent = useRef(props.content);
  const mode = useRef(new Compartment());
  const createState = useRef<(content: string) => EditorState>();
  const presentation = useRef(() => propsRef.current.sourceView
    ? [lineNumbers(), syntaxHighlighting(defaultHighlightStyle)]
    : [syntaxHighlighting(liveHighlight), markdownLivePreview({
      resolveLocalFilePath: (href, text) => propsRef.current.resolveLocalFilePath?.(href, text) ?? null,
    })]);

  useEffect(() => {
    if (!rootRef.current) return;
    createState.current = content => EditorState.create({
      doc: normalizeMarkdownLineEndings(content),
      extensions: [
        markdown({ base: markdownLanguage, extensions: [...GFM, markdownMathSyntax], codeLanguages: languages }),
        history(), drawSelection(), EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        placeholder(i18nService.t('markdownEditorPlaceholder')),
        EditorView.contentAttributes.of({ 'aria-label': i18nService.t('markdownEditorLabel'), 'aria-multiline': 'true' }),
        EditorView.domEventHandlers({ blur: () => { propsRef.current.onBlur(); } }),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          rawContent.current = applyMarkdownSourceChanges(rawContent.current, update.changes);
          propsRef.current.onChange(rawContent.current);
        }),
        mode.current.of(presentation.current()),
      ],
    });
    rawContent.current = propsRef.current.content;
    const view = new EditorView({ state: createState.current(rawContent.current), parent: rootRef.current });
    editorRef.current = view;
    return () => { view.destroy(); editorRef.current = null; };
  }, []);

  useEffect(() => {
    editorRef.current?.dispatch({ effects: mode.current.reconfigure(presentation.current()) });
  }, [props.sourceView]);

  useEffect(() => {
    const view = editorRef.current;
    if (!view || !createState.current || props.content === rawContent.current) return;
    // External updates and explicit conflict resolution start a fresh undo history.
    // Our own edits never enter this branch, so autosave cannot move the caret.
    const anchor = Math.min(view.state.selection.main.head, normalizeMarkdownLineEndings(props.content).length);
    const scrollTop = view.scrollDOM.scrollTop;
    rawContent.current = props.content;
    view.setState(createState.current(props.content));
    view.dispatch({ selection: { anchor } });
    view.scrollDOM.scrollTop = scrollTop;
  }, [props.content]);

  return <div ref={rootRef} className={`markdown-file-editor h-full ${props.sourceView ? 'md-source-view' : 'md-live-view'}`} />;
};

export default MarkdownEditor;
