import {
  getLibraryThumbnailFailureDetails,
  LibraryThumbnailError,
  LibraryThumbnailFailureCode,
} from '../../shared/library/thumbnail';
import {
  analyzePptxFirstSlideSource,
  type PptxDocumentSourceLike,
  type PptxSourceVisualContent,
} from './pptxSourceVisualContent';

export const PptxThumbnailTiming = {
  MediaReadyTimeoutMs: 3_000,
  StableLayoutMaxFrames: 8,
} as const;

interface PptxPreviewerLike {
  readonly slideCount: number;
  readonly wrapper: HTMLElement;
  readonly pptx?: PptxDocumentSourceLike;
  load: (file: ArrayBuffer) => Promise<PptxDocumentSourceLike | undefined>;
  renderSingleSlide: (slideIndex: number) => void;
  destroy: () => void;
}

export interface PptxPreviewModuleLike {
  init: (
    root: HTMLElement,
    options: { width: number; mode: 'list' },
  ) => PptxPreviewerLike;
}

export interface PptxFirstSlideRender extends PptxSourceVisualContent {
  previewer: PptxPreviewerLike;
  slide: HTMLElement;
  slideCount: number;
}

export interface PptxSlideReadiness {
  imageCount: number;
  decodedImageCount: number;
  domHasVisualContent: boolean;
  hasVisualContent: boolean;
}

type NextFrame = () => Promise<void>;

const nextAnimationFrame: NextFrame = () => new Promise(resolve => {
  requestAnimationFrame(() => resolve());
});

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  failureCode: typeof LibraryThumbnailFailureCode.PptxMediaTimeout,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(
          new LibraryThumbnailError(failureCode, message),
        ), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const waitForImageLoad = (
  image: HTMLImageElement,
  timeoutMs: number,
): Promise<void> => {
  if (image.complete) {
    return image.naturalWidth > 0
      ? Promise.resolve()
      : Promise.reject(new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxMediaLoadFailed,
        'PPTX image could not be loaded',
      ));
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      image.removeEventListener('load', handleLoad);
      image.removeEventListener('error', handleError);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleLoad = (): void => {
      finish(image.naturalWidth > 0 ? undefined : new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxMediaLoadFailed,
        'PPTX image could not be loaded',
      ));
    };
    const handleError = (): void => {
      finish(new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxMediaLoadFailed,
        'PPTX image could not be loaded',
      ));
    };

    image.addEventListener('load', handleLoad, { once: true });
    image.addEventListener('error', handleError, { once: true });
    timer = setTimeout(() => finish(new LibraryThumbnailError(
      LibraryThumbnailFailureCode.PptxMediaTimeout,
      'PPTX image loading timed out',
    )), timeoutMs);

    // The image can finish between the initial check and listener registration.
    if (image.complete) handleLoad();
  });
};

export const waitForPptxImageReady = async (
  image: HTMLImageElement,
  timeoutMs: number = PptxThumbnailTiming.MediaReadyTimeoutMs,
): Promise<void> => {
  await waitForImageLoad(image, timeoutMs);
  if (typeof image.decode === 'function') {
    await withTimeout(
      image.decode(),
      timeoutMs,
      LibraryThumbnailFailureCode.PptxMediaTimeout,
      'PPTX image decoding timed out',
    ).catch(error => {
      const failure = getLibraryThumbnailFailureDetails(
        error,
        LibraryThumbnailFailureCode.PptxMediaLoadFailed,
        'PPTX image could not be decoded',
      );
      throw new LibraryThumbnailError(failure.code, failure.message);
    });
  }
  if (image.naturalWidth <= 0) {
    throw new LibraryThumbnailError(
      LibraryThumbnailFailureCode.PptxMediaLoadFailed,
      'PPTX image could not be decoded',
    );
  }
};

const hasRenderedSlideBackground = (slide: HTMLElement): boolean => {
  const background = slide.querySelector?.<HTMLElement>('.slide-background');
  if (!background || typeof window.getComputedStyle !== 'function') return false;
  const style = window.getComputedStyle(background);
  if (style.backgroundImage && style.backgroundImage !== 'none') return true;
  const color = style.backgroundColor.replace(/\s/g, '').toLowerCase();
  return Boolean(
    color
    && color !== 'transparent'
    && color !== 'rgba(0,0,0,0)'
    && color !== 'rgb(255,255,255)'
    && color !== 'rgba(255,255,255,1)',
  );
};

export const waitForPptxSlideReady = async (
  slide: HTMLElement,
  fontsReady: Promise<unknown> | undefined = document.fonts?.ready,
  timeoutMs: number = PptxThumbnailTiming.MediaReadyTimeoutMs,
): Promise<PptxSlideReadiness> => {
  if (fontsReady) {
    await fontsReady.catch(() => {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxMediaLoadFailed,
        'PPTX fonts could not be loaded',
      );
    });
  }
  const images = Array.from(slide.querySelectorAll<HTMLImageElement>('img'));
  await Promise.all(images.map(image => waitForPptxImageReady(image, timeoutMs)));

  const visualElements = slide.querySelectorAll(
    'img, svg, canvas, video, table, .text-wrapper, .chart-node, '
    + '.smart-chart-diagram, .shape-wrapper, .group',
  );
  const domHasVisualContent = images.length > 0
    || Boolean(slide.textContent?.trim())
    || visualElements.length > 0
    || hasRenderedSlideBackground(slide);
  return {
    imageCount: images.length,
    decodedImageCount: images.length,
    domHasVisualContent,
    hasVisualContent: domHasVisualContent,
  };
};

const hasStableBounds = (left: DOMRect, right: DOMRect): boolean => (
  Math.abs(left.left - right.left) < 0.5
  && Math.abs(left.top - right.top) < 0.5
  && Math.abs(left.width - right.width) < 0.5
  && Math.abs(left.height - right.height) < 0.5
);

export const waitForPptxSlideLayout = async (
  slide: HTMLElement,
  nextFrame: NextFrame = nextAnimationFrame,
  maxFrames: number = PptxThumbnailTiming.StableLayoutMaxFrames,
): Promise<void> => {
  let previousBounds: DOMRect | undefined;
  let stableFrameCount = 0;

  for (let frame = 0; frame < maxFrames; frame += 1) {
    await nextFrame();
    const bounds = slide.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      previousBounds = undefined;
      stableFrameCount = 0;
      continue;
    }
    if (previousBounds && hasStableBounds(previousBounds, bounds)) {
      stableFrameCount += 1;
      if (stableFrameCount >= 2) return;
    } else {
      stableFrameCount = 0;
    }
    previousBounds = bounds;
  }

  throw new LibraryThumbnailError(
    LibraryThumbnailFailureCode.PptxLayoutUnstable,
    'PPTX slide layout did not stabilize',
  );
};

export const renderPptxFirstSlide = async (
  pptxPreview: PptxPreviewModuleLike,
  root: HTMLElement,
  content: ArrayBuffer,
  width: number,
): Promise<PptxFirstSlideRender> => {
  const previewer = pptxPreview.init(root, { width, mode: 'list' });
  try {
    let presentation: PptxDocumentSourceLike | undefined;
    try {
      presentation = await previewer.load(content);
    } catch (error) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxParseFailed,
        error instanceof Error ? error.message : 'PPTX could not be parsed',
      );
    }
    if (previewer.slideCount <= 0) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxNoSlides,
        'PPTX has no slides',
      );
    }

    try {
      previewer.renderSingleSlide(0);
    } catch (error) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxFirstSlideDomMissing,
        error instanceof Error ? error.message : 'PPTX first slide could not be rendered',
      );
    }
    const slide = previewer.wrapper.querySelector<HTMLElement>('.pptx-preview-slide-wrapper-0')
      ?? previewer.wrapper.firstElementChild as HTMLElement | null;
    if (!slide) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.PptxFirstSlideDomMissing,
        'PPTX slide is unavailable',
      );
    }

    const sourceVisualContent = analyzePptxFirstSlideSource(presentation ?? previewer.pptx);

    return {
      previewer,
      slide,
      slideCount: previewer.slideCount,
      ...sourceVisualContent,
    };
  } catch (error) {
    previewer.destroy();
    throw error;
  }
};
