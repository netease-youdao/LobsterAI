import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import {
  createModalEscapeLayerId,
  isDismissEscapeEvent,
  isTopModalEscapeLayer,
  registerModalEscapeLayer,
  unregisterModalEscapeLayer,
} from '../common/modalEscape';

export interface ImagePreviewSource {
  src: string;
  alt?: string | null;
  title?: string | null;
  name?: string | null;
}

interface ImagePreviewModalProps {
  image: ImagePreviewSource | null;
  onClose: () => void;
}

function getImageLabel(image: ImagePreviewSource): string {
  const label = image.name || image.title || image.alt;
  return label?.trim() || i18nService.t('artifactImageAlt');
}

const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ image, onClose }) => {
  const mouseDownOnBackdropRef = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const layerIdRef = useRef<number | null>(null);
  const isOpen = image !== null;
  if (isOpen && layerIdRef.current === null) {
    layerIdRef.current = createModalEscapeLayerId();
  } else if (!isOpen) {
    layerIdRef.current = null;
  }
  const layerId = layerIdRef.current;

  useEffect(() => {
    if (layerId === null) return;
    registerModalEscapeLayer(layerId);
    const handler = (event: KeyboardEvent) => {
      if (!isDismissEscapeEvent(event) || !isTopModalEscapeLayer(layerId)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      unregisterModalEscapeLayer(layerId);
    };
  }, [layerId, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  if (!image) return null;

  const label = getImageLabel(image);

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
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[10000] flex flex-col bg-neutral-950/70 backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        event.stopPropagation();
        closeButtonRef.current?.focus();
      }}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-end p-4">
        <button
          ref={closeButtonRef}
          type="button"
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
        className="flex min-h-0 flex-1 items-center justify-center px-5 py-16"
        onMouseDown={handleBackdropMouseDown}
        onClick={handleBackdropClick}
      >
        <div
          className="flex max-h-full max-w-full flex-col items-center gap-3"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="max-w-[min(90vw,720px)] truncate rounded-full bg-black/35 px-3 py-1 text-center text-xs font-medium text-white/85 ring-1 ring-white/10">
            {label}
          </div>
          <div className="flex max-h-full max-w-full items-center justify-center rounded-xl bg-white/95 p-1 shadow-2xl ring-1 ring-white/15">
            <img
              src={image.src}
              alt={image.alt ?? label}
              className="block max-h-[calc(100vh-11rem)] max-w-[calc(100vw-3.5rem)] object-contain rounded-lg"
              draggable={false}
            />
          </div>
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
