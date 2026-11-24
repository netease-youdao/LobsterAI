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
