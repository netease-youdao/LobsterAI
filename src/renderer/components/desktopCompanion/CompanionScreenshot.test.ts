// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CompanionScreenshotAction } from '../../../shared/desktopCompanion/screenshot';
import CompanionScreenshot from './CompanionScreenshot';
import { renderScreenshotCrop, ScreenshotTool } from './screenshotAnnotation';

vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key, setLanguage: vi.fn() } }));
vi.mock('./screenshotAnnotation', async importOriginal => ({
  ...await importOriginal<typeof import('./screenshotAnnotation')>(), renderScreenshotCrop: vi.fn(),
}));

const api = {
  getScreenshotFrame: vi.fn(async () => 'data:image/png;base64,c2NyZWVu'),
  screenshotReady: vi.fn(async () => undefined),
  finishScreenshot: vi.fn(async (_value: unknown) => undefined),
};
let container: HTMLDivElement;
let root: Root;

function surface(): HTMLElement {
  return container.querySelector('.screenshot-surface')!;
}
async function pointer(type: string, x: number, y: number, target: Element = surface()) {
  await act(async () => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })); });
}
async function select() {
  await pointer('pointerdown', 100, 100);
  await pointer('pointermove', 500, 350);
  await pointer('pointerup', 500, 350);
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(element => element.textContent === `screenshotEditor_${label}`
    || element.getAttribute('aria-label') === `screenshotEditor_${label}`);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); });
}

describe('screenshot editor interactions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(window, 'electron', { configurable: true, value: { desktopCompanion: api } });
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,YW5ub3RhdGVk');
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(CompanionScreenshot)); });
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('releasing a selection opens editing; only an explicit action submits the crop', async () => {
    await select();
    expect(api.finishScreenshot).not.toHaveBeenCalled();
    expect(container.querySelector('[role="toolbar"]')).toBeTruthy();
    await click('copy');
    expect(api.finishScreenshot).toHaveBeenCalledExactlyOnceWith({
      rect: { x: 100, y: 100, width: 400, height: 250 }, action: CompanionScreenshotAction.Copy, imageDataUrl: undefined,
    });
  });

  test('cancel and Escape submit no image or action', async () => {
    await click('cancel');
    expect(api.finishScreenshot).toHaveBeenLastCalledWith(null);
    api.finishScreenshot.mockClear();
    await select();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(api.finishScreenshot).toHaveBeenCalledExactlyOnceWith(null);
  });

  test('resizing a selection changes the eventual crop without submitting during the drag', async () => {
    await select();
    const handle = container.querySelector('[data-screenshot-handle="se"]')!;
    await pointer('pointerdown', 500, 350, handle);
    await pointer('pointermove', 600, 400);
    await pointer('pointerup', 600, 400);
    expect(api.finishScreenshot).not.toHaveBeenCalled();
    await click('ask');
    expect(api.finishScreenshot).toHaveBeenCalledExactlyOnceWith({
      rect: { x: 100, y: 100, width: 500, height: 300 }, action: CompanionScreenshotAction.Ask, imageDataUrl: undefined,
    });
  });

  test('undo removes the last mark and restores original-frame export when no marks remain', async () => {
    await select();
    await click('rectangle');
    await pointer('pointerdown', 150, 150);
    await pointer('pointermove', 250, 200);
    await pointer('pointerup', 250, 200);
    const calls = vi.mocked(renderScreenshotCrop).mock.calls;
    expect(calls[calls.length - 1][4]).toEqual([expect.objectContaining({ tool: ScreenshotTool.Rectangle })]);
    await click('undo');
    const lastCall = vi.mocked(renderScreenshotCrop).mock.calls.slice(-1)[0];
    expect(lastCall[4]).toEqual([]);
    await click('copy');
    expect(api.finishScreenshot).toHaveBeenLastCalledWith(expect.objectContaining({ imageDataUrl: undefined }));
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
  });

  test('an annotated selection exports a PNG only after the chosen action', async () => {
    await select();
    await click('pen');
    await pointer('pointerdown', 150, 150);
    await pointer('pointermove', 160, 160);
    await pointer('pointerup', 170, 160);
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    await click('save');
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledExactlyOnceWith('image/png');
    expect(api.finishScreenshot).toHaveBeenCalledExactlyOnceWith({
      rect: { x: 100, y: 100, width: 400, height: 250 }, action: CompanionScreenshotAction.Save,
      imageDataUrl: 'data:image/png;base64,YW5ub3RhdGVk',
    });
  });
});
