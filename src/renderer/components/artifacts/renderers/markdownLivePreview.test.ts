import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { type Decoration, EditorView } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import { describe, expect, test } from 'vitest';

import {
  buildLivePreviewDecorations,
  markdownLivePreview,
  markdownMathSyntax,
  setLivePreviewFocus,
} from './markdownLivePreview';
import { fencedCodeText, tableCellPosition } from './markdownLiveWidgets';

function preview(content: string, anchor?: number) {
  return EditorState.create({
    doc: content,
    selection: anchor === undefined ? undefined : EditorSelection.cursor(anchor),
    extensions: [
      markdown({ base: markdownLanguage, extensions: [...GFM, markdownMathSyntax] }),
      markdownLivePreview({}),
    ],
  });
}

/** A state as the focused editor sees it, with the caret at `anchor`. */
function focused(content: string, anchor: number) {
  return preview(content).update({ selection: { anchor }, effects: setLivePreviewFocus.of(true) }).state;
}

interface Found { from: number; to: number; value: Decoration; text: string }

function inlineDecorations(state: EditorState): Found[] {
  const found: Found[] = [];
  buildLivePreviewDecorations(state).decorations.between(0, state.doc.length, (from, to, value) => {
    found.push({ from, to, value, text: state.doc.sliceString(from, to) });
  });
  return found;
}

function blockDecorations(state: EditorState): Found[] {
  const found: Found[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue;
    set.between(0, state.doc.length, (from, to, value) => {
      found.push({ from, to, value, text: state.doc.sliceString(from, to) });
    });
  }
  return found;
}

const hidden = (state: EditorState) => inlineDecorations(state)
  .filter(found => found.from < found.to && !found.value.spec.class && !found.value.spec.widget)
  .map(found => found.text);
const marked = (state: EditorState, className: string) => inlineDecorations(state)
  .filter(found => found.value.spec.class === className)
  .map(found => found.text);
const lineClasses = (state: EditorState, line: number) => inlineDecorations(state)
  .filter(found => found.from === state.doc.line(line).from && found.from === found.to && found.value.spec.class)
  .map(found => found.value.spec.class as string)
  .join(' ');
const widgets = (state: EditorState) => inlineDecorations(state)
  .filter(found => found.value.spec.widget)
  .map(found => ({ text: found.text, widget: found.value.spec.widget }));

function mathSources(state: EditorState) {
  const sources: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'InlineMath') sources.push(state.doc.sliceString(node.from, node.to));
    },
  });
  return sources;
}

describe('editable Markdown math syntax', () => {
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
});

describe('live preview reveal', () => {
  test('reveals only the element under the caret and preserves source', () => {
    const content = '65\\~70min / 85\\~90min，\\*字面符号\\*';
    expect(hidden(preview(content))).toEqual(['\\', '\\', '\\', '\\']);
    const caret = focused(content, 3);
    expect(hidden(caret)).toEqual(['\\', '\\', '\\']);
    expect(caret.doc.toString()).toBe(content);
  });

  test('keeps the rest of a line rendered while one emphasis shows its marks', () => {
    const content = '一段**加粗**和*斜体*以及`代码`';
    const rendered = preview(content);
    expect(hidden(rendered)).toEqual(['**', '**', '*', '*', '`', '`']);
    const caret = focused(content, content.indexOf('加粗') + 1);
    expect(hidden(caret)).toEqual(['*', '*', '`', '`']);
    expect(marked(caret, 'md-syntax')).toEqual(['**', '**']);
    expect(marked(caret, 'md-strong')).toEqual(['加粗']);
  });

  test('reveals nothing while the editor is not focused', () => {
    const content = '**bold**';
    const unfocused = preview(content).update({ selection: { anchor: 3 } }).state;
    expect(hidden(unfocused)).toEqual(['**', '**']);
  });

  test('hides the whole link destination, including the space before a title', () => {
    const content = '看[官网](https://example.com "示例")以及';
    expect(hidden(preview(content))).toEqual(['[', '](https://example.com "示例")']);
    const link = inlineDecorations(preview(content)).find(found => found.value.spec.class === 'md-link')!;
    expect(link.text).toBe('官网');
    expect(link.value.spec.attributes['data-md-href']).toBe('https://example.com');
    expect(link.value.spec.attributes.title).toContain('示例');
  });

  test('marks bare URLs as links but not the destination inside a link', () => {
    const content = '见 https://example.com/a 与 [文](https://example.com/b)';
    expect(marked(preview(content), 'md-link')).toEqual(['https://example.com/a', '文']);
  });
});

describe('live preview structure', () => {
  test('headings hide their marks and hang them in the margin on the caret line', () => {
    const content = '## 标题\n\n正文';
    expect(hidden(preview(content))).toEqual(['## ']);
    expect(lineClasses(preview(content), 1)).toBe('md-heading md-h2');
    const caret = focused(content, 4);
    expect(hidden(caret)).toEqual([]);
    expect(marked(caret, 'md-heading-mark')).toEqual(['## ']);
  });

  test('lists render hanging markers, count ordered items, and show tasks as checkboxes', () => {
    const content = '- 一\n  - 二\n    续行\n\n3. 三\n4. 四\n\n- [x] 完成';
    const state = preview(content);
    const markers = widgets(state).map(({ text, widget }) => ({ text, marker: (widget as { marker?: unknown }).marker }));
    expect(markers).toEqual([
      { text: '- ', marker: { kind: 'bullet', label: '•', checked: false, taskFrom: -1 } },
      { text: '  - ', marker: { kind: 'bullet', label: '•', checked: false, taskFrom: -1 } },
      { text: '3. ', marker: { kind: 'ordered', label: '3.', checked: false, taskFrom: -1 } },
      { text: '4. ', marker: { kind: 'ordered', label: '4.', checked: false, taskFrom: -1 } },
      { text: '- [x] ', marker: { kind: 'task', label: '', checked: true, taskFrom: content.indexOf('[x]') } },
    ]);
    // The continuation keeps only its structural indentation hidden.
    expect(hidden(state)).toEqual(['    ']);
    expect(lineClasses(state, 2)).toBe('md-block md-list-item');
    expect(lineClasses(state, 3)).toBe('md-block');
  });

  test('quotes hide their markers and draw one bar per level', () => {
    const content = '> 一\n> > 二';
    const state = preview(content);
    expect(hidden(state)).toEqual(['> ', '> > ']);
    const nested = inlineDecorations(state).find(found => found.from === content.indexOf('> >') && found.value.spec.attributes?.style);
    expect(nested?.value.spec.attributes.style).toContain('linear-gradient(var(--md-quote-bar), var(--md-quote-bar)), linear-gradient');
  });

  test('code fences show a language label until the caret is on the fence line', () => {
    const content = '```ts\nconst a = 1;\n```';
    const state = preview(content);
    expect(widgets(state).map(found => found.text)).toEqual(['```ts']);
    expect(hidden(state)).toEqual(['```']);
    expect(lineClasses(state, 1)).toBe('md-code md-code-first md-code-fence');
    const inCode = focused(content, 8);
    expect(widgets(inCode).map(found => found.text)).toEqual(['```ts']);
    const onFence = focused(content, 2);
    expect(widgets(onFence)).toEqual([]);
  });

  test('front matter renders as a block without Markdown decorations', () => {
    const content = '---\ntitle: 标题\n---\n\n# 正文';
    const state = preview(content);
    expect(lineClasses(state, 1)).toBe('md-frontmatter md-frontmatter-first');
    expect(lineClasses(state, 3)).toBe('md-frontmatter md-frontmatter-last');
    expect(hidden(state)).toEqual(['# ']);
  });

  test('the caret never rests inside hidden list markup', () => {
    const content = '段落\n- 项目';
    const state = focused(content, 0).update({ selection: { anchor: content.indexOf('-') } }).state;
    expect(state.selection.main.head).toBe(content.indexOf('项'));
  });
});

describe('live preview blocks', () => {
  const table = '| 功能 | 状态 |\n| --- | :---: |\n| 预览 | 进行中 |';

  test('tables render until the caret enters them, then show their source', () => {
    const content = `${table}\n\n后文`;
    expect(blockDecorations(preview(content)).filter(found => found.value.spec.block)).toHaveLength(1);
    const editing = focused(content, content.indexOf('进行中'));
    expect(blockDecorations(editing).filter(found => found.value.spec.block)).toEqual([]);
    expect(lineClasses(editing, 1)).toBe('md-table-source');
  });

  test('display math keeps a live preview below its source while editing', () => {
    const content = '$$\nx^2\n$$\n\n后文';
    const editing = focused(content, 4);
    const [live] = blockDecorations(editing).filter(found => found.value.spec.block);
    expect(live.from).toBe(content.indexOf('\n\n'));
    expect((live.value.spec.widget as { live: boolean }).live).toBe(true);
  });

  test('maps a click on a rendered cell to the matching source position', () => {
    const state = preview(table);
    expect(tableCellPosition(state, 0, 1, 1, ' 进行中 ', 3)).toBe(table.indexOf('进行中') + 2);
    expect(tableCellPosition(state, 0, 0, 0, '**x**', 1)).toBe(table.indexOf('功能') + 2);
  });

  test('copies fenced code without the indentation that nests it in a list', () => {
    const content = '- 项目\n  ```js\n  if (a) {\n    b();\n  }\n  ```';
    expect(fencedCodeText(preview(content), content.indexOf('```'))).toBe('if (a) {\n  b();\n}');
  });
});
