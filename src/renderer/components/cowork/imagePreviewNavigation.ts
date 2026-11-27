export interface ImagePreviewSource {
  src: string;
  /** Optional lower-resolution fallback if `src` fails to load. */
  fallbackSrc?: string | null;
  /** Optional thumbnail source used in multi-image preview strips. */
  thumbSrc?: string | null;
  alt?: string | null;
  title?: string | null;
  name?: string | null;
}

export const MARKDOWN_PREVIEW_IMAGE_ATTR = 'data-markdown-preview-image';

export interface ImagePreviewGalleryState {
  images: readonly ImagePreviewSource[];
  index: number;
}

export const ImagePreviewKeyAction = {
  Previous: 'previous',
  Next: 'next',
  First: 'first',
  Last: 'last',
} as const;
export type ImagePreviewKeyAction =
  typeof ImagePreviewKeyAction[keyof typeof ImagePreviewKeyAction];

export interface ImagePreviewKeyEventLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
}

/** Wraps an image gallery index by `delta` within `[0, count - 1]`. */
export function stepImagePreviewIndex(currentIndex: number, delta: number, count: number): number {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const normalized = Number.isInteger(currentIndex)
    ? ((currentIndex % count) + count) % count
    : 0;
  return (((normalized + delta) % count) + count) % count;
}

export function resolveImagePreviewKeyAction(
  event: ImagePreviewKeyEventLike,
  count: number,
): ImagePreviewKeyAction | null {
  if (!Number.isInteger(count) || count <= 1) return null;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === 'ArrowLeft') return ImagePreviewKeyAction.Previous;
  if (event.key === 'ArrowRight') return ImagePreviewKeyAction.Next;
  if (event.key === 'Home') return ImagePreviewKeyAction.First;
  if (event.key === 'End') return ImagePreviewKeyAction.Last;
  return null;
}

export function applyImagePreviewKeyAction(
  currentIndex: number,
  action: ImagePreviewKeyAction,
  count: number,
): number {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (action === ImagePreviewKeyAction.Previous) return stepImagePreviewIndex(currentIndex, -1, count);
  if (action === ImagePreviewKeyAction.Next) return stepImagePreviewIndex(currentIndex, 1, count);
  if (action === ImagePreviewKeyAction.First) return 0;
  return count - 1;
}

export function resolveActiveImagePreview(params: {
  image?: ImagePreviewSource | null;
  images?: readonly ImagePreviewSource[];
  currentIndex?: number | null;
}): {
  items: readonly ImagePreviewSource[];
  activeIndex: number;
  activeImage: ImagePreviewSource | null;
} {
  if (params.images) {
    const index = params.currentIndex;
    if (
      typeof index === 'number'
      && Number.isInteger(index)
      && index >= 0
      && index < params.images.length
    ) {
      return {
        items: params.images,
        activeIndex: index,
        activeImage: params.images[index],
      };
    }
    return {
      items: params.images,
      activeIndex: -1,
      activeImage: null,
    };
  }
  if (params.image) {
    return {
      items: [params.image],
      activeIndex: 0,
      activeImage: params.image,
    };
  }
  return {
    items: [],
    activeIndex: -1,
    activeImage: null,
  };
}

/**
 * Resolves the full preview gallery and active index when one rendered image is clicked.
 * Uses element identity first so duplicate URLs still open at the exact clicked occurrence.
 */
export function resolveClickedImageGallery<T>(
  entries: readonly { key: T; image: ImagePreviewSource }[],
  clickedKey: T | undefined,
  fallbackImage: ImagePreviewSource,
): ImagePreviewGalleryState {
  const validEntries = entries.filter((entry) => Boolean(entry.image.src));
  if (validEntries.length === 0) {
    return { images: [fallbackImage], index: 0 };
  }

  let index = clickedKey !== undefined
    ? validEntries.findIndex((entry) => entry.key === clickedKey)
    : -1;
  if (index < 0) {
    index = validEntries.findIndex((entry) => entry.image.src === fallbackImage.src);
  }
  if (index < 0) {
    return { images: [fallbackImage], index: 0 };
  }
  return {
    images: validEntries.map((entry) => entry.image),
    index,
  };
}

/**
 * Collects all rendered previewable markdown images inside `container` and returns
 * the gallery centered on `clickedElement`.
 */
export function collectMarkdownPreviewGallery(
  container: ParentNode | null | undefined,
  clickedElement: HTMLImageElement | undefined,
  fallbackImage: ImagePreviewSource,
): ImagePreviewGalleryState {
  if (!container) {
    return { images: [fallbackImage], index: 0 };
  }
  const elements = Array.from(
    container.querySelectorAll<HTMLImageElement>(`img[${MARKDOWN_PREVIEW_IMAGE_ATTR}="true"]`),
  );
  const entries = elements.map((element) => ({
    key: element,
    image: {
      src: element.getAttribute('src') || element.src,
      alt: element.getAttribute('alt'),
    },
  }));
  return resolveClickedImageGallery(entries, clickedElement, fallbackImage);
}
