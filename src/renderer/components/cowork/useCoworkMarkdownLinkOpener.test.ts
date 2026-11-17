// @vitest-environment happy-dom
import { configureStore } from '@reduxjs/toolkit';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, useSelector } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { DelimitedTextEncoding, rememberDelimitedTextEncoding } from '../../services/office/sheet/delimitedTextEncoding';
import { getSheetPreviewKey } from '../../services/office/sheet/sheetPreview';
import artifactReducer from '../../store/slices/artifactSlice';
import { ArtifactTypeValue } from '../../types/artifact';
import { SheetRenderer } from '../artifacts/renderers/office/sheet/SheetRenderer';
import MarkdownContent from '../MarkdownContent';
import { MarkdownLinkOpenerContext } from '../markdownLinkOpener';
import { useCoworkMarkdownLinkOpener } from './useCoworkMarkdownLinkOpener';

vi.mock('../artifacts/artifactAnalytics', async importOriginal => ({
  ...await importOriginal<typeof import('../artifacts/artifactAnalytics')>(),
  reportArtifactPreviewAction: vi.fn(),
}));

// Happy DOM has no geometry; keep the real parser and cells, and render every virtual row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    measure: () => {},
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * estimateSize(index) })),
  }),
}));

const readFile = vi.fn();
const statFile = vi.fn();
const openPath = vi.fn();
const openExternal = vi.fn();
const CSV = '商品编号,商品名称,数量\r\n001023,有道词典笔,8\r\n004056,降噪耳机,12';
const GBK = Buffer.from('c9ccc6b7b1e0bac52cc9ccc6b7c3fbb3c62ccafdc1bf0d0a3030313032332cd3d0b5c0b4cab5e4b1ca2c380d0a3030343035362cbdb5d4ebb6fabbfa2c3132', 'hex');
const dataUrl = (bytes: string | Uint8Array) => `data:text/csv;base64,${Buffer.from(bytes).toString('base64')}`;
let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof makeStore>;
const makeStore = () => configureStore({ reducer: { artifact: artifactReducer } });

function Conversation({ content, sessionId = 'csv-links' }: { content: string; sessionId?: string }) {
  const artifacts = useSelector((state: ReturnType<typeof store.getState>) => state.artifact);
  const sessionArtifacts = artifacts.artifactsBySession[sessionId] ?? [];
  const tab = artifacts.previewTabsBySession[sessionId]?.find(item => item.id === artifacts.activePreviewTabIdBySession[sessionId]);
  const current = sessionArtifacts.find(item => item.id === tab?.artifactId);
  const opener = useCoworkMarkdownLinkOpener({
    sessionId, cwd: 'C:/products', sessionArtifacts,
    onOpenHtmlFile: vi.fn(), onOpenLocalService: vi.fn(),
  });
  return React.createElement(MarkdownLinkOpenerContext.Provider, { value: opener },
    React.createElement(MarkdownContent, { content }),
    current && React.createElement(SheetRenderer, { artifact: current }));
}

async function render(content: string, sessionId?: string) {
  await act(async () => {
    root.render(React.createElement(Provider, { store, children:
      React.createElement(Conversation, { content, sessionId }),
    }));
  });
}

async function clickLink(label: string) {
  const link = Array.from(container.querySelectorAll('a')).find(anchor => anchor.textContent === label)!;
  expect(link).toBeDefined();
  await act(async () => { link.click(); });
  await act(async () => { await vi.dynamicImportSettled(); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.electron = { dialog: { statFile, readFileAsDataUrl: readFile }, shell: { openPath, openExternal } } as unknown as typeof window.electron;
  statFile.mockReset().mockResolvedValue({ success: true, isFile: true });
  readFile.mockReset().mockImplementation(async (filePath: string) => ({ success: true, dataUrl: dataUrl(filePath.endsWith('gbk.csv') ? GBK : CSV) }));
  openPath.mockReset().mockResolvedValue({ success: true });
  openExternal.mockReset().mockResolvedValue({ success: true });
  store = makeStore();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  for (const [sessionId, artifacts] of Object.entries(store.getState().artifact.artifactsBySession)) {
    for (const artifact of artifacts) rememberDelimitedTextEncoding(getSheetPreviewKey(sessionId, artifact.filePath, artifact.id), DelimitedTextEncoding.Auto);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([
  ['C:/products/products-gbk.csv', 'C:/products/products-gbk.csv'],
  ['c:/products/products-utf8.csv', 'c:/products/products-utf8.csv'],
  [String.raw`D:\products\products-gbk.csv`, String.raw`D:\products\products-gbk.csv`],
  ['file:///C:/products/products-gbk.csv', 'C:/products/products-gbk.csv'],
  ['products-utf8.csv', 'C:/products/products-utf8.csv'],
  ['file://server/share/products-gbk.csv', '//server/share/products-gbk.csv'],
  ['C:%5cproducts%5cproducts-gbk.csv', String.raw`C:\products\products-gbk.csv`],
  ['C:/%E5%95%86%E5%93%81%20data/products-utf8.csv', 'C:/商品 data/products-utf8.csv'],
])('a rendered CSV link %s opens decoded cells in-app from original bytes', async (href, filePath) => {
  await render(`[products.csv](${href})`);
  await clickLink('products.csv');
  expect(openPath).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
  expect(readFile).toHaveBeenCalledWith(filePath);
  expect(store.getState().artifact.previewTabsBySession['csv-links']).toHaveLength(1);
  expect(store.getState().artifact.artifactsBySession['csv-links'][0]).toMatchObject({
    type: ArtifactTypeValue.Document, filePath,
    content: dataUrl(filePath.endsWith('gbk.csv') ? GBK : CSV),
  });
  expect(container.textContent).toContain('有道词典笔');
  expect(container.textContent).toContain('001023');
});

test('repeated body-link clicks reuse tabs and keep encoding choices separate across files and chats', async () => {
  const content = '[GBK](C:/products/products-gbk.csv)\n\n[UTF8](C:/products/products-utf8.csv)';
  await render(content);
  await clickLink('GBK');
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = DelimitedTextEncoding.Gb18030;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickLink('UTF8');
  expect(container.querySelector('select')?.value).toBe(DelimitedTextEncoding.Auto);
  await clickLink('GBK');
  expect(container.querySelector('select')?.value).toBe(DelimitedTextEncoding.Gb18030);
  expect(store.getState().artifact.previewTabsBySession['csv-links']).toHaveLength(2);
  expect(readFile).toHaveBeenCalledTimes(2);
  await render(content, 'another-chat');
  await clickLink('GBK');
  expect(container.querySelector('select')?.value).toBe(DelimitedTextEncoding.Auto);
  expect(store.getState().artifact.previewTabsBySession['another-chat']).toHaveLength(1);
  expect(openPath).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

test.each(['C:/products/', 'C:/products/archive.zip'])('keeps the system fallback for %s', async filePath => {
  await render(`[open](${filePath})`);
  await clickLink('open');
  expect(openPath).toHaveBeenCalledWith(filePath);
  expect(openExternal).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});

test.each(['https://example.com/products.csv', 'mailto:hello@example.com'])('keeps %s external', async href => {
  await render(`[open](${href})`);
  await clickLink('open');
  expect(openExternal).toHaveBeenCalledWith(href);
  expect(openPath).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});
