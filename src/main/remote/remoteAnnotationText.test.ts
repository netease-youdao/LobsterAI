import { describe, expect, it } from 'vitest';

import { buildRemoteAnnotationText, RemoteAnnotationTextLimits } from './remoteAnnotationText';
import { replyBlocks, replyUserText } from './remoteReplyProjection';

const browser = (comment = '把按钮改成点我') => ({ browserAnnotations: [{ pageTitle: 'index.html',
  pageUrl: 'file:///private/work/index.html?token=hidden', documentId: 'private-document',
  annotations: [{ comment, anchor: { selector: '#private-selector', immediateText: 'private DOM' },
    screenshot: { status: 'ready', asset: { assetId: 'private-asset' } } }] }] });

describe('remote annotation text', () => {
  it('retains user requests in a compatible text block and never copies reference metadata', () => {
    const output = replyBlocks({ id: 'm', type: 'user', content: '' }, browser());
    expect(output).toHaveLength(1); expect(output[0].type).toBe('text');
    expect(output[0].text).toContain('index.html'); expect(output[0].text).toContain('把按钮改成点我');
    expect(JSON.stringify(output)).not.toMatch(/private|hidden|selector|assetId|documentId|file:\/\//u);
    expect(output[0].text).toContain('电脑端查看');
    expect(replyUserText('请保持配色', browser())).toBe(`请保持配色\n\n${output[0].text}`);
    expect(replyUserText(output[0].text!, browser())).toBe(output[0].text);
  });
  it.each(['data:image/png;base64,private-pixels', 'blob:https://private.example/id', 'javascript:private', ' data:text/plain;base64,private-pixels', '\tjavascript:private', 'da\nta:text/plain;base64,private-pixels'])('does not publish opaque or active URL titles (%s)', title => {
    const text = buildRemoteAnnotationText({ browserAnnotations: [{ pageTitle: title, annotations: [{ comment: 'Visible note' }] }] }, 'en');
    expect(text).toContain('Untitled file'); expect(text).toContain('Visible note');
    expect(text).not.toContain('private');
  });
  it('normalizes lone surrogates while preserving valid emoji', () => {
    const text = buildRemoteAnnotationText(browser('abc\ud800def\udfff😀'), 'en');
    expect(text).toContain('abc�def�😀');
    expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
  });
  it('includes property-only edits, including clearing text, without requiring a screenshot or comment', () => {
    const output = buildRemoteAnnotationText({ browserAnnotations: [{ pageTitle: 'Page', annotations: [
      { elementEdit: { original: { text: 'Old', color: 'red' }, current: { text: '', color: 'blue' } } },
    ] }] }, 'en');
    expect(output).toContain('Text: Old → (empty)'); expect(output).toContain('Text color: red → blue');
    expect(output).not.toContain('undefined');
  });
  it('includes image region comments and gives an honest desktop fallback for visual-only marks', () => {
    const output = buildRemoteAnnotationText({ imageEdits: [
      { operation: 'comment', source: { title: 'C:\\private\\cup.png', filePath: '/private/frozen.png' }, regions: [{ text: 'Make the cup blue', x: 0.1 }], instruction: 'Keep lighting' },
      { operation: 'markup', source: { title: 'photo.png' }, regions: [] },
    ] }, 'en');
    expect(output).toContain('cup.png'); expect(output).toContain('Make the cup blue'); expect(output).toContain('Keep lighting');
    expect(output).toContain('photo.png'); expect(output).toContain('View the annotated image on the desktop.');
    expect(output).not.toMatch(/private|filePath|0\.1/u);
  });
  it('bounds malformed and oversized metadata without throwing or silently hiding truncation', () => {
    expect(buildRemoteAnnotationText({ browserAnnotations: [null, {}, { annotations: [null, { elementEdit: {} }] }], imageEdits: [{ operation: 'unknown' }] })).toBe('');
    const many = { browserAnnotations: [{ annotations: Array.from({ length: 50 }, () => ({ comment: '中😀'.repeat(3000) })) }] };
    const output = buildRemoteAnnotationText(many, 'en');
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(RemoteAnnotationTextLimits.Bytes);
    expect(output).toContain('Only part of the annotations is shown.'); expect(output).not.toContain('�');
    expect(output).not.toContain('21.');
  });
  it('redacts recognizable credentials in comments and does not add annotations to assistant/tool output', () => {
    const metadata = browser('password=private-password Authorization: Bearer private-token');
    const output = replyBlocks({ id: 'm', type: 'user', content: '正文' }, metadata);
    expect(output[0].text).toContain('[redacted]'); expect(output[0].text).not.toMatch(/private-password|private-token/u);
    expect(replyBlocks({ id: 'm', type: 'assistant', content: '回答' }, metadata)[0].text).toBe('回答');
    expect(replyBlocks({ id: 'm', type: 'tool_result', content: '结果' }, metadata)[0].text).toBe('结果');
  });
});
