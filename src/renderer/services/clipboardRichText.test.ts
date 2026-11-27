// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest';

import {
  handleRichTextCopyEvent,
  installCleanRichTextCopy,
  normalizeCssColorValue,
  serializeSelectionAsCleanHtml,
} from './clipboardRichText';

const selectRange = (
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): Selection => {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
};

const createMockCopyEvent = (target: EventTarget): {
  event: ClipboardEvent;
  data: Record<string, string>;
} => {
  const data: Record<string, string> = {};
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      getData: (type: string) => data[type] ?? '',
    },
  });
  Object.defineProperty(event, 'target', { value: target });
  return { event, data };
};

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('normalizeCssColorValue', () => {
  test('converts CSS Color 4 color(srgb ...) values to rgb() and rgba()', () => {
    expect(normalizeCssColorValue('color(srgb 1 1 1)')).toBe('rgb(255, 255, 255)');
    expect(normalizeCssColorValue('color(srgb 0.101961 0.101961 0.101961)')).toBe('rgb(26, 26, 26)');
    expect(normalizeCssColorValue('color(srgb 1 1 1 / 0.3)')).toBe('rgba(255, 255, 255, 0.3)');
    expect(normalizeCssColorValue('color(srgb 0.101961 0.101961 0.101961 / 0.9)')).toBe('rgba(26, 26, 26, 0.9)');
    expect(normalizeCssColorValue('color(srgb 50% 25% 0% / 50%)')).toBe('rgba(128, 64, 0, 0.5)');
    expect(normalizeCssColorValue('color(srgb none 1 0 / 1)')).toBe('rgb(0, 255, 0)');
  });

  test('clamps out-of-range channels and leaves non-srgb strings unchanged', () => {
    expect(normalizeCssColorValue('color(srgb 1.2 -0.5 0.5)')).toBe('rgb(255, 0, 128)');
    expect(normalizeCssColorValue('rgb(26, 26, 26)')).toBe('rgb(26, 26, 26)');
    expect(normalizeCssColorValue('background-color: color(srgb 1 1 1); color: color(srgb 0 0 0);'))
      .toBe('background-color: rgb(255, 255, 255); color: rgb(0, 0, 0);');
  });
});

describe('serializeSelectionAsCleanHtml', () => {
  test('returns plain text only (no html) for unformatted inline prose inside a paragraph', () => {
    document.body.innerHTML = `
      <div class="bg-background">
        <div class="markdown-content">
          <p class="my-3 text-foreground" style="background-color: color(srgb 1 1 1); color: color(srgb 0.101961 0.101961 0.101961)">
            体感温度低，穿的衣服得按 3℃ 来准备，最好
          </p>
        </div>
      </div>
    `;
    const p = document.querySelector('p')!;
    const textNode = p.firstChild!;
    const selection = selectRange(textNode, 0, textNode, textNode.textContent!.length);

    const result = serializeSelectionAsCleanHtml(selection, p);
    expect(result).not.toBeNull();
    expect(result!.text.trim()).toBe('体感温度低，穿的衣服得按 3℃ 来准备，最好');
    expect(result!.html).toBeNull();
  });

  test('preserves semantic inline tags and strips classes, theme styles, and color(srgb ...)', () => {
    document.body.innerHTML = `
      <div class="markdown-content">
        <p class="my-3 text-foreground">
          体感温度低，<strong class="font-semibold text-foreground" style="color: color(srgb 0.1 0.1 0.1)">穿的衣服</strong>得按
          <code class="inline bg-foreground/[0.05] text-foreground/90" style="background-color: color(srgb 0.1 0.1 0.1 / 0.05)">3℃</code>
          来准备，见 <a href="https://example.com" class="text-primary" target="_blank" rel="noopener">天气预报</a>
        </p>
      </div>
    `;
    const p = document.querySelector('p')!;
    const selection = selectRange(p, 0, p, p.childNodes.length);

    const result = serializeSelectionAsCleanHtml(selection, p);
    expect(result).not.toBeNull();
    expect(result!.html).toContain('<strong>穿的衣服</strong>');
    expect(result!.html).toContain('<code>3℃</code>');
    expect(result!.html).toContain('<a href="https://example.com">天气预报</a>');
    expect(result!.html).not.toContain('class=');
    expect(result!.html).not.toContain('style=');
    expect(result!.html).not.toContain('color(srgb');
    expect(result!.html).not.toContain('background-color');
  });

  test('re-wraps partial selections inside strong, code, and external links', () => {
    document.body.innerHTML = `
      <div class="markdown-content">
        <p><a href="https://example.com" class="text-primary"><strong class="font-semibold">important detail</strong></a></p>
        <p><code class="inline bg-foreground/[0.05]">npm run build</code></p>
      </div>
    `;
    const strongText = document.querySelector('strong')!.firstChild!;
    const linkResult = serializeSelectionAsCleanHtml(
      selectRange(strongText, 0, strongText, 9),
      strongText,
    );
    expect(linkResult).toEqual({
      text: 'important',
      html: '<a href="https://example.com"><strong>important</strong></a>',
    });

    const codeText = document.querySelector('code')!.firstChild!;
    const codeResult = serializeSelectionAsCleanHtml(
      selectRange(codeText, 4, codeText, 7),
      codeText,
    );
    expect(codeResult).toEqual({
      text: 'run',
      html: '<code>run</code>',
    });
  });

  test('unwraps non-portable local file links while keeping link text', () => {
    document.body.innerHTML = `
      <div class="markdown-content">
        <p>查看 <a href="file:///Users/demo/notes.md" class="text-primary">notes.md</a> 和 <strong>说明</strong></p>
      </div>
    `;
    const p = document.querySelector('p')!;
    const result = serializeSelectionAsCleanHtml(selectRange(p, 0, p, p.childNodes.length), p);

    expect(result?.html).toBe('查看 notes.md 和 <strong>说明</strong>');
  });

  test('cleans blockquotes, lists, and tables while preserving structure and alignment', () => {
    document.body.innerHTML = `
      <div class="markdown-content">
        <blockquote class="bg-surface-raised/30 text-foreground/90">
          <p class="text-foreground">第一行引用</p>
          <p class="text-foreground">第二行引用</p>
        </blockquote>
        <ul class="list-disc text-foreground">
          <li class="my-2">条目一</li>
          <li class="my-2">条目二</li>
        </ul>
        <div class="my-4 overflow-x-auto rounded-xl border border-border">
          <table class="w-full">
            <thead class="bg-surface-raised">
              <tr><th class="px-4" style="text-align: center; background-color: color(srgb 0.96 0.96 0.96)">列</th></tr>
            </thead>
            <tbody>
              <tr><td class="px-4" style="text-align: right; color: color(srgb 0.1 0.1 0.1)">值</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Selection across both <p>s inside <blockquote> preserves <blockquote>.
    const blockquote = document.querySelector('blockquote')!;
    const quoteResult = serializeSelectionAsCleanHtml(
      selectRange(blockquote, 0, blockquote, blockquote.childNodes.length),
      blockquote,
    );
    expect(quoteResult?.html?.replace(/\s+/g, ' ').trim())
      .toBe('<blockquote> <p>第一行引用</p> <p>第二行引用</p> </blockquote>');

    // Selection across two <li>s inside <ul> preserves <ul>.
    const items = document.querySelectorAll('li');
    const listResult = serializeSelectionAsCleanHtml(
      selectRange(items[0].firstChild!, 0, items[1].firstChild!, 3),
      items[0],
    );
    expect(listResult?.html?.replace(/>\s+</g, '><')).toBe('<ul><li>条目一</li><li>条目二</li></ul>');

    // Selection across two <td> cells inside <tr> wraps with <table><tbody><tr>.
    const tableBodyRow = document.querySelector('tbody tr')!;
    const secondCell = document.createElement('td');
    secondCell.textContent = '值2';
    tableBodyRow.appendChild(secondCell);
    const cells = tableBodyRow.querySelectorAll('td');
    const cellResult = serializeSelectionAsCleanHtml(
      selectRange(cells[0].firstChild!, 0, cells[1].firstChild!, 2),
      cells[0],
    );
    expect(cellResult?.html).toBe('<table><tbody><tr><td style="text-align: right">值</td><td>值2</td></tr></tbody></table>');

    // Selection across the table keeps clean <table> + text-align, drops wrapper div and colors.
    const md = document.querySelector('.markdown-content')!;
    const tableWrapper = md.querySelector('div')!;
    const tableResult = serializeSelectionAsCleanHtml(
      selectRange(tableWrapper, 0, tableWrapper, tableWrapper.childNodes.length),
      tableWrapper,
    );
    expect(tableResult?.html).toContain('<table>');
    expect(tableResult?.html).toContain('<th style="text-align: center">列</th>');
    expect(tableResult?.html).toContain('<td style="text-align: right">值</td>');
    expect(tableResult?.html).not.toContain('color(srgb');
    expect(tableResult?.html).not.toContain('<div');
  });

  test('strips code block toolbars and converts CodeMirror / block code to <pre><code>', () => {
    document.body.innerHTML = `
      <div class="markdown-content">
        <p>示例：</p>
        <div class="group/code bg-surface-raised/40">
          <div data-cowork-search-exclude="true" data-copy-exclude="true">
            <span>ts</span>
            <button type="button">Copy</button>
          </div>
          <div class="m-0 overflow-x-auto">
            <code data-code-block="true" class="block text-foreground/90">const a = 1;\nconst b = 2;</code>
          </div>
        </div>
        <div class="group/code bg-surface-raised/40">
          <div data-cowork-search-exclude="true" data-copy-exclude="true">
            <span>python</span>
            <button type="button">Copy</button>
          </div>
          <div data-cowork-search-exclude="true">
            <div class="cm-editor">
              <div class="cm-gutters"><div class="cm-gutterElement">1</div><div class="cm-gutterElement">2</div></div>
              <div class="cm-content">
                <div class="cm-line">x = 1</div>
                <div class="cm-line">print(x)</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const md = document.querySelector('.markdown-content')!;
    const result = serializeSelectionAsCleanHtml(
      selectRange(md, 0, md, md.childNodes.length),
      md,
    );
    expect(result?.html).toContain('<p>示例：</p>');
    expect(result?.html).toContain('<pre><code>const a = 1;\nconst b = 2;</code></pre>');
    expect(result?.html).toContain('<pre><code>x = 1\nprint(x)</code></pre>');
    expect(result?.html).not.toContain('Copy');
    expect(result?.html).not.toContain('cm-gutters');
    expect(result?.html).not.toContain('<span>ts</span>');
  });

  test('strips visual-only aria-hidden KaTeX spans while keeping MathML', () => {
    document.body.innerHTML = `
      <div class="markdown-content">
        <p>
          公式 <span class="katex">
            <span class="katex-mathml"><math><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow></semantics></math></span>
            <span class="katex-html" aria-hidden="true"><span class="base">x2</span></span>
          </span>
        </p>
      </div>
    `;
    const p = document.querySelector('p')!;
    const result = serializeSelectionAsCleanHtml(selectRange(p, 0, p, p.childNodes.length), p);

    expect(result?.html).toContain('<math>');
    expect(result?.html).not.toContain('katex-html');
    expect(result?.html).not.toContain('x2');
  });

  test('ignores selections inside inputs, contenteditable, CodeMirror, or non-markdown regions', () => {
    document.body.innerHTML = `
      <textarea id="ta">hello textarea</textarea>
      <div id="ce" contenteditable="true"><div class="markdown-content"><p>editable</p></div></div>
      <div class="markdown-content">
        <div class="cm-editor"><div class="cm-content"><div class="cm-line">code line</div></div></div>
      </div>
      <div id="plain">outside markdown</div>
    `;

    const ceP = document.querySelector('#ce p')!;
    expect(serializeSelectionAsCleanHtml(
      selectRange(ceP.firstChild!, 0, ceP.firstChild!, 8),
      ceP,
    )).toBeNull();

    const cmLine = document.querySelector('.cm-line')!;
    expect(serializeSelectionAsCleanHtml(
      selectRange(cmLine.firstChild!, 0, cmLine.firstChild!, 9),
      cmLine,
    )).toBeNull();

    const plain = document.querySelector('#plain')!;
    expect(serializeSelectionAsCleanHtml(
      selectRange(plain.firstChild!, 0, plain.firstChild!, 7),
      plain,
    )).toBeNull();

    const ta = document.querySelector('#ta')!;
    expect(serializeSelectionAsCleanHtml(
      selectRange(ta.firstChild!, 0, ta.firstChild!, 5),
      ta,
    )).toBeNull();
  });

  test('handles cross-message selections spanning multiple markdown blocks and strips message meta rows', () => {
    document.body.innerHTML = `
      <div id="conversation">
        <div class="assistant-turn">
          <div class="markdown-content"><p class="text-foreground">第一段<strong>结论</strong></p></div>
          <div class="cowork-message-meta"><span>16:10</span><button type="button">Copy</button></div>
        </div>
        <div class="assistant-turn">
          <div class="markdown-content"><p class="text-foreground">第二段补充</p></div>
        </div>
      </div>
    `;
    const conv = document.querySelector('#conversation')!;
    const result = serializeSelectionAsCleanHtml(
      selectRange(conv, 0, conv, conv.childNodes.length),
      conv,
    );
    expect(result?.html?.replace(/>\s+</g, '><').trim())
      .toBe('<p>第一段<strong>结论</strong></p><p>第二段补充</p>');
  });

  test('installCleanRichTextCopy handles document copy events and respects defaultPrevented', () => {
    document.body.innerHTML = `
      <div class="markdown-content">
        <p><strong>加粗</strong>和正文</p>
      </div>
    `;
    const p = document.querySelector('p')!;
    selectRange(p, 0, p, p.childNodes.length);

    const uninstall = installCleanRichTextCopy(document);
    try {
      const { event, data } = createMockCopyEvent(p);
      document.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(data['text/plain']).toBe('加粗和正文');
      expect(data['text/html']).toBe('<strong>加粗</strong>和正文');

      // Already-handled events are left untouched.
      const prevented = createMockCopyEvent(p);
      prevented.event.preventDefault();
      expect(handleRichTextCopyEvent(prevented.event)).toBe(false);
      expect(prevented.data).toEqual({});
    } finally {
      uninstall();
    }
  });
});
