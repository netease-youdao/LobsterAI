import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import ImagePreviewModal from './ImagePreviewModal';
import {
  applyImagePreviewKeyAction,
  ImagePreviewKeyAction,
  resolveActiveImagePreview,
  resolveClickedImageGallery,
  resolveImagePreviewKeyAction,
  stepImagePreviewIndex,
} from './imagePreviewNavigation';

vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

describe('imagePreviewNavigation', () => {
  test('steps and wraps indices across a gallery', () => {
    expect(stepImagePreviewIndex(0, 1, 3)).toBe(1);
    expect(stepImagePreviewIndex(2, 1, 3)).toBe(0);
    expect(stepImagePreviewIndex(0, -1, 3)).toBe(2);
    expect(stepImagePreviewIndex(1, -1, 3)).toBe(0);
    expect(stepImagePreviewIndex(0, 1, 1)).toBe(0);
    expect(stepImagePreviewIndex(0, 1, 0)).toBe(-1);
  });

  test('resolves keyboard navigation only for unmodified multi-image events', () => {
    expect(resolveImagePreviewKeyAction({ key: 'ArrowLeft' }, 3)).toBe(ImagePreviewKeyAction.Previous);
    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight' }, 3)).toBe(ImagePreviewKeyAction.Next);
    expect(resolveImagePreviewKeyAction({ key: 'Home' }, 3)).toBe(ImagePreviewKeyAction.First);
    expect(resolveImagePreviewKeyAction({ key: 'End' }, 3)).toBe(ImagePreviewKeyAction.Last);

    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight' }, 1)).toBeNull();
    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight', metaKey: true }, 3)).toBeNull();
    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight', ctrlKey: true }, 3)).toBeNull();
    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight', altKey: true }, 3)).toBeNull();
    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight', shiftKey: true }, 3)).toBeNull();
    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight', isComposing: true }, 3)).toBeNull();
    expect(resolveImagePreviewKeyAction({ key: 'ArrowRight', defaultPrevented: true }, 3)).toBeNull();
    expect(resolveImagePreviewKeyAction({ key: 'Enter' }, 3)).toBeNull();
  });

  test('applies key actions to produce the target gallery index', () => {
    expect(applyImagePreviewKeyAction(0, ImagePreviewKeyAction.Previous, 3)).toBe(2);
    expect(applyImagePreviewKeyAction(2, ImagePreviewKeyAction.Next, 3)).toBe(0);
    expect(applyImagePreviewKeyAction(1, ImagePreviewKeyAction.First, 3)).toBe(0);
    expect(applyImagePreviewKeyAction(0, ImagePreviewKeyAction.Last, 3)).toBe(2);
    expect(applyImagePreviewKeyAction(0, ImagePreviewKeyAction.Next, 0)).toBe(-1);
  });

  test('resolves single-image and gallery preview states', () => {
    const a = { src: 'a.png', name: 'a.png' };
    const b = { src: 'b.png', name: 'b.png' };

    expect(resolveActiveImagePreview({ image: a })).toEqual({
      items: [a],
      activeIndex: 0,
      activeImage: a,
    });
    expect(resolveActiveImagePreview({ image: null })).toEqual({
      items: [],
      activeIndex: -1,
      activeImage: null,
    });
    expect(resolveActiveImagePreview({ images: [a, b], currentIndex: 1 })).toEqual({
      items: [a, b],
      activeIndex: 1,
      activeImage: b,
    });
    expect(resolveActiveImagePreview({ images: [a, b], currentIndex: null })).toEqual({
      items: [a, b],
      activeIndex: -1,
      activeImage: null,
    });
    expect(resolveActiveImagePreview({ images: [a, b], currentIndex: 5 })).toEqual({
      items: [a, b],
      activeIndex: -1,
      activeImage: null,
    });
  });

  test('resolves clicked image galleries by identity even with duplicate URLs', () => {
    const first = { id: 'node-1' };
    const second = { id: 'node-2' };
    const third = { id: 'node-3' };
    const entries = [
      { key: first, image: { src: 'localfile:///same.png', alt: 'first' } },
      { key: second, image: { src: 'localfile:///same.png', alt: 'second' } },
      { key: third, image: { src: 'localfile:///other.png', alt: 'third' } },
    ];

    expect(resolveClickedImageGallery(entries, second, { src: 'localfile:///same.png', alt: 'second' })).toEqual({
      images: [
        { src: 'localfile:///same.png', alt: 'first' },
        { src: 'localfile:///same.png', alt: 'second' },
        { src: 'localfile:///other.png', alt: 'third' },
      ],
      index: 1,
    });

    // Falls back to matching src when element reference is omitted, or to single image if absent.
    expect(resolveClickedImageGallery(entries, undefined, { src: 'localfile:///other.png' }).index).toBe(2);
    expect(resolveClickedImageGallery([], undefined, { src: 'localfile:///only.png' })).toEqual({
      images: [{ src: 'localfile:///only.png' }],
      index: 0,
    });
  });
});

describe('ImagePreviewModal rendering', () => {
  test('renders a single image without gallery navigation controls', () => {
    const html = renderToStaticMarkup(createElement(ImagePreviewModal, {
      image: { src: 'https://example.invalid/one.png', name: 'one.png' },
      onClose: () => {},
    }));
    expect(html).toContain('src="https://example.invalid/one.png"');
    expect(html).toContain('one.png');
    expect(html).not.toContain('imagePreviewPrevious');
    expect(html).not.toContain('imagePreviewNext');
    expect(html).not.toContain('imagePreviewThumbnails');
  });

  test('renders navigation arrows, counter, and thumbnail strip when viewing multiple images', () => {
    const html = renderToStaticMarkup(createElement(ImagePreviewModal, {
      images: [
        { src: 'localfile://local/a.png', thumbSrc: 'data:image/jpeg;base64,A', name: 'first.png' },
        { src: 'localfile://local/b.png', thumbSrc: 'data:image/jpeg;base64,B', name: 'second.png' },
        { src: 'localfile://local/c.png', thumbSrc: 'data:image/jpeg;base64,C', name: 'third.png' },
      ],
      currentIndex: 1,
      onIndexChange: () => {},
      onClose: () => {},
    }));
    expect(html).toContain('src="localfile://local/b.png"');
    expect(html).toContain('second.png');
    expect(html).toContain('2 / 3');
    expect(html).toContain('aria-label="imagePreviewPrevious"');
    expect(html).toContain('aria-label="imagePreviewNext"');
    expect(html).toContain('aria-label="imagePreviewThumbnails"');
    expect(html).toContain('src="data:image/jpeg;base64,A"');
    expect(html).toContain('aria-current="true"');
  });

  test('renders nothing when gallery index is null', () => {
    const html = renderToStaticMarkup(createElement(ImagePreviewModal, {
      images: [{ src: 'a.png' }, { src: 'b.png' }],
      currentIndex: null,
      onIndexChange: () => {},
      onClose: () => {},
    }));
    expect(html).toBe('');
  });
});
