import { describe, expect, test, vi } from 'vitest';

import { LibraryThumbnailFailureCode } from '../../shared/library/thumbnail';
import {
  type PptxPreviewModuleLike,
  renderPptxFirstSlide,
  waitForPptxImageReady,
  waitForPptxSlideLayout,
  waitForPptxSlideReady,
} from './pptxThumbnailRenderer';

const createBounds = (
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect => ({ left, top, width, height }) as DOMRect;

describe('PPTX library thumbnail rendering', () => {
  test('loads the deck and renders only the first slide', async () => {
    const slide = {} as HTMLElement;
    const load = vi.fn(async () => undefined);
    const renderSingleSlide = vi.fn();
    const preview = vi.fn();
    const destroy = vi.fn();
    const previewer = {
      slideCount: 12,
      wrapper: {
        querySelector: () => slide,
        firstElementChild: null,
      } as unknown as HTMLElement,
      load,
      renderSingleSlide,
      preview,
      destroy,
    };
    const init = vi.fn(() => previewer);
    const pptxPreview = { init } as PptxPreviewModuleLike;
    const root = {} as HTMLElement;
    const content = new ArrayBuffer(8);

    const result = await renderPptxFirstSlide(pptxPreview, root, content, 640);

    expect(init).toHaveBeenCalledWith(root, { width: 640, mode: 'list' });
    expect(load).toHaveBeenCalledWith(content);
    expect(renderSingleSlide).toHaveBeenCalledTimes(1);
    expect(renderSingleSlide).toHaveBeenCalledWith(0);
    expect(preview).not.toHaveBeenCalled();
    expect(result).toEqual({
      previewer,
      slide,
      slideCount: 12,
      sourceHasVisualContent: false,
      sourceVisualElementCount: 0,
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  test('reports source content before the first slide DOM is captured', async () => {
    const slide = {} as HTMLElement;
    const previewer = {
      slideCount: 2,
      wrapper: {
        querySelector: () => slide,
        firstElementChild: null,
      } as unknown as HTMLElement,
      load: async () => ({
        slides: [{
          nodes: [{ source: { 'p:txBody': { 'a:p': { 'a:t': 'Visible title' } } } }],
        }],
      }),
      renderSingleSlide: vi.fn(),
      destroy: vi.fn(),
    };

    const result = await renderPptxFirstSlide(
      { init: () => previewer } as PptxPreviewModuleLike,
      {} as HTMLElement,
      new ArrayBuffer(8),
      640,
    );

    expect(result.sourceHasVisualContent).toBe(true);
    expect(result.sourceVisualElementCount).toBe(1);
  });

  test('destroys the previewer when the deck has no slides', async () => {
    const destroy = vi.fn();
    const pptxPreview = {
      init: () => ({
        slideCount: 0,
        wrapper: {} as HTMLElement,
        load: async () => undefined,
        renderSingleSlide: vi.fn(),
        destroy,
      }),
    } as PptxPreviewModuleLike;

    await expect(renderPptxFirstSlide(
      pptxPreview,
      {} as HTMLElement,
      new ArrayBuffer(0),
      640,
    )).rejects.toThrow('PPTX has no slides');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('waits for loaded images to decode', async () => {
    const decode = vi.fn(async () => undefined);
    const image = {
      complete: true,
      naturalWidth: 320,
      decode,
    } as unknown as HTMLImageElement;

    await waitForPptxImageReady(image, 20);

    expect(decode).toHaveBeenCalledTimes(1);
  });

  test('rejects an image whose decode never completes', async () => {
    const image = {
      complete: true,
      naturalWidth: 320,
      decode: () => new Promise<void>(() => undefined),
    } as unknown as HTMLImageElement;

    await expect(waitForPptxImageReady(image, 5)).rejects.toThrow(
      'PPTX image decoding timed out',
    );
    await expect(waitForPptxImageReady(image, 5)).rejects.toMatchObject({
      code: LibraryThumbnailFailureCode.PptxMediaTimeout,
    });
  });

  test('reports slide media readiness after fonts and images finish', async () => {
    let resolveFonts: (() => void) | undefined;
    const fontsReady = new Promise<void>(resolve => {
      resolveFonts = resolve;
    });
    const decode = vi.fn(async () => undefined);
    const image = {
      complete: true,
      naturalWidth: 100,
      decode,
    } as unknown as HTMLImageElement;
    const slide = {
      querySelectorAll: () => [image],
      textContent: '',
      childElementCount: 1,
    } as unknown as HTMLElement;
    const readiness = waitForPptxSlideReady(slide, fontsReady, 20);

    expect(decode).not.toHaveBeenCalled();
    resolveFonts?.();

    await expect(readiness).resolves.toEqual({
      imageCount: 1,
      decodedImageCount: 1,
      domHasVisualContent: true,
      hasVisualContent: true,
    });
  });

  test('does not classify structural wrappers on an empty slide as visual content', async () => {
    const slide = {
      querySelectorAll: () => [],
      textContent: '',
    } as unknown as HTMLElement;

    await expect(waitForPptxSlideReady(slide, Promise.resolve(), 20)).resolves.toEqual({
      imageCount: 0,
      decodedImageCount: 0,
      domHasVisualContent: false,
      hasVisualContent: false,
    });
  });

  test('waits for two consecutive stable layout frames', async () => {
    const bounds = [
      createBounds(0, 0, 0, 0),
      createBounds(2, 2, 476, 266),
      createBounds(2, 2, 476, 266),
      createBounds(2, 2, 476, 266),
    ];
    const slide = {
      getBoundingClientRect: () => bounds.shift() ?? createBounds(2, 2, 476, 266),
    } as HTMLElement;
    const nextFrame = vi.fn(async () => undefined);

    await waitForPptxSlideLayout(slide, nextFrame, 6);

    expect(nextFrame).toHaveBeenCalledTimes(4);
  });

  test('fails when the slide never reaches a visible stable layout', async () => {
    const slide = {
      getBoundingClientRect: () => createBounds(0, 0, 0, 0),
    } as HTMLElement;

    await expect(waitForPptxSlideLayout(
      slide,
      async () => undefined,
      3,
    )).rejects.toThrow('PPTX slide layout did not stabilize');
    await expect(waitForPptxSlideLayout(
      slide,
      async () => undefined,
      3,
    )).rejects.toMatchObject({
      code: LibraryThumbnailFailureCode.PptxLayoutUnstable,
    });
  });
});
