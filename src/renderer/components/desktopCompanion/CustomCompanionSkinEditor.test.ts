// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import CustomCompanionSkinEditor from './CustomCompanionSkinEditor';
import CompanionCharacter from './mascot/CompanionCharacter';
import { CompanionMood } from './mascot/companionMood';

const mock = vi.hoisted(() => ({ read: vi.fn(), apply: vi.fn() }));
vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./customSkinImage', () => ({ readCompanionSkinImage: mock.read, cropCompanionSkinImage: (image: HTMLImageElement) => image.src }));
let root: Root;
let host: HTMLDivElement;
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
}
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.apply.mockResolvedValue({ success: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('previews and applies a GIF unchanged, hiding static crop controls', async () => {
  const dataUrl = 'data:image/gif;base64,R0lGODlh';
  mock.read.mockResolvedValue({ naturalWidth: 256, naturalHeight: 512, src: dataUrl });
  await act(async () => { root.render(React.createElement(CustomCompanionSkinEditor, { disabled: false, onSelect: vi.fn(), onApply: mock.apply })); });
  await click('desktopCompanionSkinCustomize');
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  expect(input.accept).toContain('image/gif');
  Object.defineProperty(input, 'files', { value: [new File(['gif'], 'pet.gif', { type: 'image/gif' })] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelectorAll('input[type=range]')).toHaveLength(0);
  expect(host.textContent).toContain('desktopCompanionSkinGifHint');
  expect(host.querySelector('img')?.src).toBe(dataUrl);
  await click('desktopCompanionSkinApply');
  expect(mock.apply).toHaveBeenCalledWith(dataUrl, '');
});

it('keeps the desktop GIF image mounted when task mood changes', async () => {
  const dataUrl = 'data:image/gif;base64,R0lGODlh';
  const props = { skin: `custom-${'a'.repeat(64)}`, size: 144, customAsset: dataUrl };
  await act(async () => { root.render(React.createElement(CompanionCharacter, { ...props, mood: CompanionMood.Idle })); });
  const image = host.querySelector('img');
  expect(image?.src).toBe(dataUrl);
  await act(async () => { root.render(React.createElement(CompanionCharacter, { ...props, mood: CompanionMood.Working })); });
  expect(host.querySelector('img')).toBe(image);
  expect(image?.src).toBe(dataUrl);
});
