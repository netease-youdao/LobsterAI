import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import {
  createModalEscapeLayerId,
  isDismissEscapeEvent,
  isTopModalEscapeLayer,
  registerModalEscapeLayer,
  unregisterModalEscapeLayer,
} from '../common/modalEscape';
import {
  applyImagePreviewKeyAction,
  type ImagePreviewSource,
  resolveActiveImagePreview,
  resolveImagePreviewKeyAction,
  stepImagePreviewIndex,
} from './imagePreviewNavigation';

export type { ImagePreviewSource };

interface ImagePreviewModalProps {
  image?: ImagePreviewSource | null;
  images?: readonly ImagePreviewSource[];
  currentIndex?: number | null;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
}

function getImageLabel(image: ImagePreviewSource): string {
  const label = image.name || image.title || image.alt;
  return label?.trim() || i18nService.t('artifactImageAlt');
}

const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({
  image,
  images,
  currentIndex,
  onIndexChange,
  onClose,
}) => {
  const mouseDownOnBackdropRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const layerIdRef = useRef<number | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const { items, activeIndex, activeImage } = resolveActiveImagePreview({
    image,
    images,
    currentIndex,
  });
  const isOpen = activeImage !== null;
  const canNavigate = items.length > 1 && typeof onIndexChange === 'function';

  if (isOpen && layerIdRef.current === null) {
    layerIdRef.current = createModalEscapeLayerId();
  } else if (!isOpen) {
    layerIdRef.current = null;
  }
  const layerId = layerIdRef.current;

  useEffect(() => {
    if (layerId === null) return;
    registerModalEscapeLayer(layerId);
    return () => {
      unregisterModalEscapeLayer(layerId);
    };
  }, [layerId]);

  useEffect(() => {
    if (layerId === null) return;
    const handler = (event: KeyboardEvent) => {
      if (!isTopModalEscapeLayer(layerId)) return;
      if (isDismissEscapeEvent(event)) {
        event.preventDefault();
        onClose();
        return;
      }
      if (!canNavigate) return;
      const action = resolveImagePreviewKeyAction(event, items.length);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const nextIndex = applyImagePreviewKeyAction(activeIndex, action, items.length);
      if (nextIndex >= 0 && nextIndex !== activeIndex) {
        onIndexChange?.(nextIndex);
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [activeIndex, canNavigate, items.length, layerId, onClose, onIndexChange]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  if (!activeImage) return null;

  const label = getImageLabel(activeImage);
  const displaySrc = failedSrc === activeImage.src && activeImage.fallbackSrc
    ? activeImage.fallbackSrc
    : activeImage.src;

  const navigateBy = (delta: number) => {
    if (!canNavigate) return;
    const nextIndex = stepImagePreviewIndex(activeIndex, delta, items.length);
    if (nextIndex >= 0 && nextIndex !== activeIndex) {
      onIndexChange?.(nextIndex);
    }
  };

  const handleBackdropMouseDown: React.MouseEventHandler<HTMLDivElement> = (event) => {
    event.stopPropagation();
    mouseDownOnBackdropRef.current = event.target === event.currentTarget;
  };

  const handleBackdropClick: React.MouseEventHandler<HTMLDivElement> = (event) => {
    event.stopPropagation();
    if (event.target === event.currentTarget && mouseDownOnBackdropRef.current) {
      mouseDownOnBackdropRef.current = false;
      onClose();
    }
  };

  const modal = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[10000] flex flex-col bg-neutral-950/70 backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        event.stopPropagation();
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        const active = document.activeElement;
        if (buttons.length === 1 || !dialogRef.current?.contains(active)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-end p-4">
        <button
          ref={closeButtonRef}
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="pointer-events-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
          title={i18nService.t('close')}
          aria-label={i18nService.t('close')}
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      <div
        className={`relative flex min-h-0 flex-1 items-center justify-center ${
          canNavigate ? 'px-16 py-14' : 'px-5 py-16'
        }`}
        onMouseDown={handleBackdropMouseDown}
        onClick={handleBackdropClick}
      >
        {canNavigate && (
          <>
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                navigateBy(-1);
              }}
              className="absolute left-4 top-1/2 z-10 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white/85 ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-black/55 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
              title={i18nService.t('imagePreviewPrevious')}
              aria-label={i18nService.t('imagePreviewPrevious')}
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                navigateBy(1);
              }}
              className="absolute right-4 top-1/2 z-10 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white/85 ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-black/55 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
              title={i18nService.t('imagePreviewNext')}
              aria-label={i18nService.t('imagePreviewNext')}
            >
              <ChevronRightIcon className="h-5 w-5" />
            </button>
          </>
        )}

        <div
          className="flex max-h-full max-w-full flex-col items-center gap-3"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex max-w-[min(90vw,720px)] items-center gap-2 rounded-full bg-black/35 px-3 py-1 text-center text-xs font-medium text-white/85 ring-1 ring-white/10">
            <span className="truncate">{label}</span>
            {items.length > 1 && (
              <span className="shrink-0 tabular-nums text-white/60">
                {activeIndex + 1} / {items.length}
              </span>
            )}
          </div>
          <div className="flex max-h-full max-w-full items-center justify-center rounded-xl bg-white/95 p-1 shadow-2xl ring-1 ring-white/15">
            <img
              src={displaySrc}
              alt={activeImage.alt ?? label}
              className={`block rounded-lg object-contain ${
                canNavigate
                  ? 'max-h-[calc(100vh-15rem)] max-w-[calc(100vw-8.5rem)]'
                  : 'max-h-[calc(100vh-11rem)] max-w-[calc(100vw-3.5rem)]'
              }`}
              onError={() => {
                if (activeImage.fallbackSrc && failedSrc !== activeImage.src) {
                  setFailedSrc(activeImage.src);
                }
              }}
              draggable={false}
            />
          </div>
          {canNavigate && (
            <div
              role="group"
              aria-label={i18nService.t('imagePreviewThumbnails')}
              className="flex max-w-[calc(100vw-8.5rem)] items-center gap-1.5 overflow-x-auto rounded-xl bg-black/35 p-1.5 ring-1 ring-white/10 backdrop-blur-sm"
            >
              {items.map((item, index) => {
                const isActive = index === activeIndex;
                const itemLabel = getImageLabel(item);
                return (
                  <button
                    key={`${item.src}-${index}`}
                    type="button"
                    aria-label={`${itemLabel} (${index + 1} / ${items.length})`}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      onIndexChange?.(index);
                    }}
                    className={`h-10 w-10 shrink-0 overflow-hidden rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-white/60 ${
                      isActive
                        ? 'opacity-100 ring-2 ring-white'
                        : 'opacity-55 ring-1 ring-white/20 hover:opacity-90'
                    }`}
                  >
                    <img
                      src={item.thumbSrc || item.src}
                      alt={item.alt ?? itemLabel}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modal;
  }

  return createPortal(modal, document.body);
};

export default ImagePreviewModal;
