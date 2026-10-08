import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import { describe, expect, test } from 'vitest';

import { markdownLivePreview, markdownMathSyntax } from './markdownLivePreview';

function preview(content: string) {
  return EditorState.create({
    doc: content,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [...GFM, markdownMathSyntax] }),
      markdownLivePreview({}),
    ],
  });
}

function mathSources(state: EditorState) {
  const sources: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'InlineMath') sources.push(state.doc.sliceString(node.from, node.to));
    },
  });
  return sources;
}

describe('editable Markdown preview', () => {
  test.each(['$x^2$', '$$x^2$$', '\\(x^2\\)', '$ x^2 $', '$x\n+y$'])('recognizes %s as math', content => {
    expect(mathSources(preview(`说明 ${content} 结束`))).toEqual([content]);
  });

  test('keeps code examples and escaped math delimiters literal', () => {
    const state = preview('`$x$ \\(x\\)`\n\n```tex\n$y$\n\\(y\\)\n```\n\n\\$literal\\$ 与 \\\\(z\\)');
    expect(mathSources(state)).toEqual([]);
  });

  test('does not let unmatched or unequal dollar runs consume later math', () => {
    expect(mathSources(preview('说明 $$unclosed $x$ 以及 \\(y\\)'))).toEqual(['$x$', '\\(y\\)']);
  });

  test('allows math after an escaped dollar and leaves empty delimiters literal', () => {
    expect(mathSources(preview('\\$$x$ 与 \\( \\)'))).toEqual(['$x$']);
  });

  test('hides escapes in preview, reveals them on the active line, and preserves source', () => {
    const content = '65\\~70min / 85\\~90min，\\*字面符号\\*';
    const state = preview(content);
    const hiddenSource = (current: EditorState) => {
      const hidden: string[] = [];
      for (const decorations of current.facet(EditorView.decorations)) {
        if (typeof decorations === 'function') continue;
        decorations.between(0, current.doc.length, (from, to, value) => {
          if (!value.spec.class && !value.spec.widget) hidden.push(current.doc.sliceString(from, to));
        });
      }
      return hidden;
    };
    expect(hiddenSource(state)).toEqual(['\\', '\\', '\\', '\\']);
    const focused = state.update({ selection: { anchor: 3 } }).state;
    expect(hiddenSource(focused)).toEqual([]);
    expect(focused.doc.toString()).toBe(content);
  });
});
