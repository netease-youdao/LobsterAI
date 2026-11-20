// @vitest-environment happy-dom
import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';
import { DelimitedTextEncoding, rememberDelimitedTextEncoding } from '@/services/office/sheet/delimitedTextEncoding';
import { getSheetPreviewKey } from '@/services/office/sheet/sheetPreview';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import { OfficePreviewActionsContext, type OfficePreviewZoomControlsConfig } from '../common/OfficePreviewActionsContext';
import { SheetRenderer } from './SheetRenderer';

// Happy DOM has no layout. Only virtual row measurement is replaced: React, effects, decoding,
// SheetJS parsing and the rendered cells/encoding selector are the production implementations.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    measure: () => {},
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * estimateSize(index) })),
  }),
}));

const GBK = Buffer.from('c9ccc6b7b1e0bac52cc9ccc6b7c3fbb3c62ccafdc1bf0d0a3030313032332cd3d0b5c0b4cab5e4b1ca2c380d0a3030343035362cbdb5d4ebb6fabbfa2c3132', 'hex');
const CSV = '商品编号,商品名称,数量\r\n001023,有道词典笔,8\r\n004056,降噪耳机,12';
const dataUrl = (bytes: Uint8Array | string) => `data:text/csv;base64,${Buffer.from(bytes).toString('base64')}`;
const readFile = vi.fn<(filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>>();
const keys = new Set<string>();
let container: HTMLDivElement;
let root: Root;
let zoom: OfficePreviewZoomControlsConfig | null;
let commits: string[];

const actions = { setZoomControls: (value: React.SetStateAction<OfficePreviewZoomControlsConfig | null>) => {
  zoom = typeof value === 'function' ? value(zoom) : value;
} };

function CommitProbe({ artifact }: { artifact: Artifact }) {
  // Observe the commit before passive loading effects run, including transient stale cells.
  useLayoutEffect(() => { commits.push(container.textContent ?? ''); });
  return React.createElement(SheetRenderer, { artifact });
}

function artifact(filePath: string, content = '', sessionId = 'csv-review'): Artifact {
  keys.add(getSheetPreviewKey(sessionId, filePath, filePath));
  return {
    id: filePath, messageId: 'message', sessionId, type: ArtifactTypeValue.Document, title: filePath,
    fileName: filePath.split(/[\\/]/).pop(), filePath, content, createdAt: 1,
  };
}

async function render(file: Artifact) {
  await act(async () => {
    root.render(React.createElement(OfficePreviewActionsContext.Provider, { value: actions },
      React.createElement(CommitProbe, { artifact: file })));
  });
  await act(async () => { await vi.dynamicImportSettled(); });
}

function selector() {
  const select = container.querySelector('select');
  expect(select).not.toBeNull();
  return select!;
}

async function choose(encoding: DelimitedTextEncoding) {
  await act(async () => {
    const select = selector();
    select.value = encoding;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => { await vi.dynamicImportSettled(); });
}

function deferredRead() {
  let resolve!: (value: { success: boolean; dataUrl?: string; error?: string }) => void;
  const promise = new Promise<{ success: boolean; dataUrl?: string; error?: string }>(done => { resolve = done; });
  return { promise, resolve };
}

async function complete(request: ReturnType<typeof deferredRead>, bytes: Uint8Array | string) {
  await act(async () => { request.resolve({ success: true, dataUrl: dataUrl(bytes) }); });
  await act(async () => { await vi.dynamicImportSettled(); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.electron = { dialog: { readFileAsDataUrl: readFile } } as unknown as typeof window.electron;
  readFile.mockReset();
  i18nService.setLanguage('en', { persist: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  zoom = null;
  commits = [];
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  for (const key of keys) rememberDelimitedTextEncoding(key, DelimitedTextEncoding.Auto);
  keys.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CSV preview lifecycle', () => {
  test('remembers the real selector change across files with identical names, without leaking across paths or chats', async () => {
    const gbk = artifact('C:/one/products.csv', dataUrl(GBK));
    const utf8 = artifact('C:/two/products.csv', dataUrl(CSV));
    await render(gbk);
    expect(container.textContent).toContain('有道词典笔');
    await choose(DelimitedTextEncoding.Gb18030);
    await render(utf8);
    expect(selector().value).toBe(DelimitedTextEncoding.Auto);
    expect(container.textContent).toContain('有道词典笔');
    await render(gbk);
    expect(selector().value).toBe(DelimitedTextEncoding.Gb18030);
    await render({ ...gbk, sessionId: 'another-chat' });
    expect(selector().value).toBe(DelimitedTextEncoding.Auto);
  });

  test('keeps the manual choice when the same Windows file is reopened with different path casing', async () => {
    await render(artifact('C:/Products/products.csv', dataUrl(GBK)));
    await choose(DelimitedTextEncoding.Gb18030);
    await render(artifact('c:\\products\\PRODUCTS.CSV', dataUrl(GBK)));
    expect(selector().value).toBe(DelimitedTextEncoding.Gb18030);
    expect(container.textContent).toContain('有道词典笔');
  });

  test('clears encoding errors on a real selection change and does not read or write the file again', async () => {
    await render(artifact('C:/products.csv', dataUrl(GBK)));
    await choose(DelimitedTextEncoding.Utf8);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('有道词典笔');
    await choose(DelimitedTextEncoding.Gb18030);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('001023');
    expect(container.textContent).toContain('有道词典笔');
    expect(readFile).not.toHaveBeenCalled();
  });

  test('refreshes changed inline bytes immediately without committing cells from the old snapshot', async () => {
    const file = artifact('C:/refresh.csv', dataUrl(GBK));
    await render(file);
    commits = [];
    await render({ ...file, content: dataUrl(CSV.replace('有道词典笔', '新的商品')) });
    expect(container.textContent).toContain('新的商品');
    expect(selector().value).toBe(DelimitedTextEncoding.Auto);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('UTF-8');
    expect(commits.some(text => text.includes('有道词典笔'))).toBe(false);
  });

  test('preserves manual choice across refresh and recovers through Auto when the file encoding changed', async () => {
    const file = artifact('C:/refresh-choice.csv', dataUrl(CSV));
    await render(file);
    await choose(DelimitedTextEncoding.Utf8);
    await render({ ...file, content: dataUrl(GBK) });
    expect(selector().value).toBe(DelimitedTextEncoding.Utf8);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await choose(DelimitedTextEncoding.Auto);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('有道词典笔');
  });

  test('a delayed read for A cannot overwrite B or a later reopening of A', async () => {
    const firstA = deferredRead();
    const b = deferredRead();
    const secondA = deferredRead();
    readFile.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);
    const a = artifact('C:/pending-a.csv');
    await render(a);
    await render(artifact('C:/pending-b.csv'));
    await complete(b, 'item\nB content');
    expect(container.textContent).toContain('B content');
    await render(a);
    await complete(secondA, 'item\nNew A content');
    await complete(firstA, 'item\nObsolete A content');
    expect(container.textContent).toContain('New A content');
    expect(container.textContent).not.toContain('Obsolete A content');
    expect(container.textContent).not.toContain('B content');
  });

  test('a delayed earlier refresh cannot replace the result of a newer version', async () => {
    const old = deferredRead();
    const current = deferredRead();
    readFile.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const file = artifact('C:/versioned.csv');
    await render({ ...file, contentVersion: 1 });
    await render({ ...file, contentVersion: 2 });
    await complete(current, 'item\nCurrent version');
    await complete(old, 'item\nObsolete version');
    expect(container.textContent).toContain('Current version');
    expect(container.textContent).not.toContain('Obsolete version');
  });

  test('hides the previous file version while refreshing and clears a read error after retry', async () => {
    readFile.mockResolvedValueOnce({ success: true, dataUrl: dataUrl(CSV) });
    const failed = deferredRead();
    readFile.mockReturnValueOnce(failed.promise);
    const file = artifact('C:/retry.csv');
    await render(file);
    expect(container.textContent).toContain('有道词典笔');
    commits = [];
    await render({ ...file, contentVersion: 1 });
    expect(container.textContent).not.toContain('有道词典笔');
    expect(commits.some(text => text.includes('有道词典笔'))).toBe(false);
    await act(async () => { failed.resolve({ success: false, error: 'Read failed' }); });
    expect(container.textContent).toContain('Read failed');
    readFile.mockResolvedValueOnce({ success: true, dataUrl: dataUrl(GBK) });
    await render({ ...file, contentVersion: 2 });
    expect(container.textContent).not.toContain('Read failed');
    expect(container.textContent).toContain('有道词典笔');
  });

  test('preserves zoom when switching valid encodings or refreshing inline bytes, and resets it for another file', async () => {
    const file = artifact('C:/zoom.csv', dataUrl(CSV));
    await render(file);
    await act(async () => { zoom!.onZoomIn(); });
    expect(zoom?.zoomFactor).toBe(1.1);
    await choose(DelimitedTextEncoding.Utf8);
    expect(zoom?.zoomFactor).toBe(1.1);
    await render({ ...file, content: dataUrl(CSV.replace('有道词典笔', '新的商品')) });
    expect(zoom?.zoomFactor).toBe(1.1);
    await render(artifact('C:/another.csv', dataUrl(GBK)));
    expect(zoom?.zoomFactor).toBe(1);
  });
});
