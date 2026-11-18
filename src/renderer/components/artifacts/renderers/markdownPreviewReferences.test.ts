import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { type Decoration, EditorView, type WidgetType } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import MarkdownContent from '@/components/MarkdownContent';

import { buildLivePreviewDecorations, markdownLivePreview } from './markdownLivePreview';
import { markdownPreviewReferences, withMarkdownReferenceDefinitions } from './markdownPreviewReferences';

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdown({ base: markdownLanguage, extensions: GFM }), markdownLivePreview({})],
  });
}

/** Block previews come from state; line and inline rendering from the viewport builder. */
function decorations(state: EditorState): Array<{ from: number; to: number; value: Decoration }> {
  const result: Array<{ from: number; to: number; value: Decoration }> = [];
  const collect = (set: { between: (from: number, to: number, f: (from: number, to: number, value: Decoration) => void) => void }) => {
    set.between(0, state.doc.length, (from, to, value) => { result.push({ from, to, value }); });
  };
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set !== 'function') collect(set);
  }
  collect(buildLivePreviewDecorations(state).decorations);
  return result;
}

function previewWidget(state: EditorState, from: number): WidgetType & { source: string } {
  const widget = decorations(state).find(decoration => decoration.from === from && decoration.value.spec.widget)?.value.spec.widget;
  expect(widget).toBeDefined();
  return widget;
}

function render(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content, enableLargePreview: false }));
}

test('preview blocks resolve links and images using definitions after the block', () => {
  const table = '| Link |\n| --- |\n| [click][ref] |';
  const image = '![photo][pic]';
  const source = `${table}\n\n${image}\n\n[ref]: https://example.com/page\n[pic]: https://example.com/photo.png`;
  const state = createState(source);
  expect(render(previewWidget(state, 0).source)).toContain('href="https://example.com/page"');
  expect(render(previewWidget(state, source.indexOf(image)).source)).toContain('src="https://example.com/photo.png"');
  expect(state.doc.toString()).toBe(source);
});

test('changing a definition updates an unchanged block and selection changes reuse the parse', () => {
  const source = '| Link |\n| --- |\n| [click][ref] |\n\n[ref]: https://example.com/old';
  const state = createState(source);
  const originalWidget = previewWidget(state, 0);
  const moved = state.update({ selection: { anchor: source.indexOf('[ref]:') } }).state;
  expect(moved.field(markdownPreviewReferences)).toBe(state.field(markdownPreviewReferences));
  expect(originalWidget.eq(previewWidget(moved, 0))).toBe(true);
  const updated = moved.update({ changes: { from: source.indexOf('/old'), to: source.length, insert: '/new' } }).state;
  const updatedWidget = previewWidget(updated, 0);
  expect(originalWidget.eq(updatedWidget)).toBe(false);
  expect(render(updatedWidget.source)).toContain('href="https://example.com/new"');
});

test('code examples cannot define references and the first real definition wins', () => {
  const block = '| Link |\n| --- |\n| [click][ref] |';
  const source = `${block}\n\n\`\`\`md\n[ref]: https://wrong.example\n\`\`\`\n\n[REF]: https://first.example\n[ref]: https://second.example`;
  const state = createState(source);
  const html = render(previewWidget(state, 0).source);
  expect(html).toContain('href="https://first.example"');
  expect(html).not.toContain('wrong.example');
  expect(html).not.toContain('second.example');
  const unresolved = createState(`${block}\n\n\`\`\`md\n[ref]: https://wrong.example\n\`\`\``);
  expect(render(previewWidget(unresolved, 0).source)).toContain('[click][ref]');
});

test('multiline definitions in containers preserve escaped labels, destinations, and titles', () => {
  const block = '| Link |\n| --- |\n| [click][A\\* &amp; B] |';
  const source = `${block}\n\n> [A\\* &amp; B]:\n>   <https://example.com/a\\>b?x=1&amp;y=2>\n>   "A &amp; \\"quoted\\"\n>   title"`;
  const state = createState(source);
  const html = render(previewWidget(state, 0).source);
  expect(html).toContain('href="https://example.com/a%3Eb?x=1&amp;y=2"');
  expect(html).toContain('title="A &amp; &quot;quoted&quot;\ntitle"');
});

test('inline full, collapsed, and shortcut references get resolved destinations without hiding unknown labels', () => {
  const source = '[full][ref] [ref][] [ref] [unknown]\n\n[ref]: <https://example.com/?a=1&amp;b=2> "Reference title"';
  const state = createState(source);
  const marks = decorations(state).filter(decoration => decoration.value.spec.attributes?.['data-md-href']);
  expect(marks.map(decoration => source.slice(decoration.from, decoration.to))).toEqual(['full', 'ref', 'ref']);
  expect(marks.every(decoration => decoration.value.spec.attributes['data-md-href'] === 'https://example.com/?a=1&b=2')).toBe(true);
  expect(marks.every(decoration => decoration.value.spec.attributes.title.startsWith('Reference title\n'))).toBe(true);
  const hidden = decorations(state).filter(decoration => decoration.value.spec.widget === undefined && decoration.value.spec.class === undefined && decoration.from < source.indexOf('\n'));
  expect(hidden.map(decoration => source.slice(decoration.from, decoration.to))).toEqual(['[', '][ref]', '[', '][]', '[', ']']);
  expect(hidden.some(decoration => decoration.from >= source.indexOf('[unknown]'))).toBe(false);
});

test('metadata and unsafe reference destinations stay outside the rendered link behavior', () => {
  const source = '---\n[ref]: https://metadata.example\n---\n\n[click][ref]\n\n[ref]: javascript:alert(1)';
  const state = createState(source);
  const content = withMarkdownReferenceDefinitions('[click][ref]', state.field(markdownPreviewReferences));
  expect(content).not.toContain('metadata.example');
  expect(render(content)).not.toContain('javascript:');
  const mark = decorations(state).find(decoration => decoration.value.spec.class === 'md-link');
  expect(mark?.value.spec.attributes['data-md-href']).toBe('');
});

test('an unfinished code fence keeps table-like text as code', () => {
  const source = '[ref]: https://example.com\n\n```md\n| A |\n| --- |\n| [click][ref] |';
  const state = createState(source);
  expect(decorations(state).some(decoration => decoration.value.spec.block)).toBe(false);
  expect(decorations(state).some(decoration => decoration.value.spec.class === 'md-link')).toBe(false);
});

test('an explicit empty link remains a link while an unresolved reference stays literal', () => {
  const source = '[empty]() [unknown]';
  const state = createState(source);
  const marks = decorations(state).filter(decoration => decoration.value.spec.class === 'md-link');
  expect(marks).toHaveLength(1);
  expect(source.slice(marks[0].from, marks[0].to)).toBe('empty');
  expect(marks[0].value.spec.attributes['data-md-href']).toBe('');
});

test('definitions after a large offscreen body are available on the first render and update immediately', () => {
  const table = '| Link |\n| --- |\n| [click][ref] |';
  const source = `${table}\n\n${'An ordinary paragraph.\n\n'.repeat(10000)}[ref]: https://example.com/old`;
  const state = createState(source);
  expect(render(previewWidget(state, 0).source)).toContain('href="https://example.com/old"');
  const updated = state.update({ changes: { from: source.lastIndexOf('/old'), to: source.length, insert: '/new' } }).state;
  expect(render(previewWidget(updated, 0).source)).toContain('href="https://example.com/new"');
});

test('ordinary typing reuses definition fragments and recognizes changes to code fences', () => {
  const source = '[click][ref]\n\n[ref]: https://example.com';
  const state = createState(source);
  const updated = state.update({ changes: { from: source.indexOf('click'), insert: 'new ' } }).state;
  expect([...updated.field(markdownPreviewReferences).definitionCache.values()][0])
    .toBe([...state.field(markdownPreviewReferences).definitionCache.values()][0]);
  const fenced = updated.update({ changes: { from: 0, insert: '```md\n' } }).state;
  expect(fenced.field(markdownPreviewReferences).definitions).toBe('');
  const restored = fenced.update({ changes: { from: 0, to: 6, insert: '' } }).state;
  expect(restored.field(markdownPreviewReferences).definitions).toContain('https://example.com');
});

test('valid consecutive definitions and decoded control characters survive display serialization', () => {
  const block = '| A | B |\n|---|---|\n| [a][first] | [b][second] |';
  const source = `${block}\n\n[first]: <https://example.com/a\\>b>\n[second]: https://example.com/a&#10;b`;
  const html = render(previewWidget(createState(source), 0).source);
  expect(html).toContain('href="https://example.com/a%3Eb"');
  expect(html).toContain('href="https://example.com/a%0Ab"');
});

test('math blocks keep fake references opaque and end at their quote or list boundary', () => {
  for (const math of [
    '$$\n\n[ref]: https://wrong.example\n\n$$',
    '> $$\n>\n> [ref]: https://wrong.example\n>\n> $$',
    '- $$\n\n  [ref]: https://wrong.example\n\n  $$',
    '> $$\n> [ref]: https://wrong.example',
  ]) {
    const source = `[click][ref]\n\n${math}\n\n[ref]: https://example.com`;
    const references = createState(source).field(markdownPreviewReferences);
    expect(references.definitions).not.toContain('wrong.example');
    expect(references.links.get(0)?.url).toBe('https://example.com');
  }
});

test('explicit link destinations use parsed escapes and entities for modified clicks', () => {
  const source = '[link](https://example.com/a\\(b\\)?x=1&amp;y=2)';
  const mark = decorations(createState(source)).find(decoration => decoration.value.spec.class === 'md-link');
  expect(mark?.value.spec.attributes['data-md-href']).toBe('https://example.com/a(b)?x=1&y=2');
});

test('multiline reference labels discard blockquote prefixes before normalization', () => {
  const source = '> [click][a\n> b]\n\n[a b]: https://example.com';
  const state = createState(source);
  const mark = decorations(state).find(decoration => decoration.value.spec.class === 'md-link');
  expect(mark?.value.spec.attributes['data-md-href']).toBe('https://example.com');
});

test('a fallback definition does not hide links in the following paragraph without a blank line', () => {
  for (const source of [
    '[ref]: <https://example.com/a\\>b>\n[click][ref]',
    '> [ref]: <https://example.com/a\\>b>\n> [click][ref]',
  ]) {
    const state = createState(source);
    const mark = decorations(state).find(decoration => decoration.value.spec.class === 'md-link'
      && decoration.from > source.indexOf('[click]'));
    expect(mark?.from).toBe(source.indexOf('[click]') + 1);
    expect(mark?.value.spec.attributes['data-md-href']).toBe('https://example.com/a>b');
  }
});
