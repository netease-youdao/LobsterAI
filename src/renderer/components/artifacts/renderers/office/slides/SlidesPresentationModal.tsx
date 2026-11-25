import {
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  ChatBubbleBottomCenterTextIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import type { SlidesEditorSession } from '@/services/office/slides/slidesEditorSession';
import { resolvePresentationScale, stepSlideIndex } from '@/services/office/slides/slidesLayout';

const t = (key: string) => i18nService.t(key);
const HUD_IDLE_HIDE_MS = 2400;

export interface SlidesPresentationModalProps {
  session: SlidesEditorSession;
  initialIndex: number;
  onExit: (lastIndex: number) => void;
}

/**
 * Full-viewport slideshow presentation overlay. Reuses the live OOXML slide renderer with editing
 * placeholders suppressed, scales crisply to any viewport, supports keyboard & click navigation,
 * auto-hiding HUD controls, optional speaker-notes peek, and native fullscreen when available.
 */
export function SlidesPresentationModal({
  session,
  initialIndex,
  onExit,
}: SlidesPresentationModalProps): React.ReactElement {
  const total = session.slideCount;
  const clampedStart = total > 0 ? Math.max(0, Math.min(total - 1, initialIndex)) : 0;
  const [index, setIndex] = useState(clampedStart);
  const [ended, setEnded] = useState(false);
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const slideSizeRef = useRef<{ width: number; height: number } | null>(null);
  const slideElRef = useRef<HTMLDivElement | null>(null);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const indexRef = useRef(index);
  indexRef.current = index;
  const exitingRef = useRef(false);
  const wasFullscreenRef = useRef(false);
  const manualFullscreenExitRef = useRef(false);

  const revealHud = useCallback(() => {
    setHudVisible(true);
    clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => setHudVisible(false), HUD_IDLE_HIDE_MS);
  }, []);

  const handleClose = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    if (document.fullscreenElement === rootRef.current) {
      void document.exitFullscreen?.().catch(() => undefined);
    }
    onExit(indexRef.current);
  }, [onExit]);

  const goNext = useCallback(() => {
    if (ended) {
      handleClose();
      return;
    }
    if (index >= total - 1) {
      setEnded(true);
      revealHud();
      return;
    }
    setIndex(current => stepSlideIndex(current, 1, total));
  }, [ended, handleClose, index, revealHud, total]);

  const goPrev = useCallback(() => {
    if (ended) {
      setEnded(false);
      return;
    }
    setIndex(current => stepSlideIndex(current, -1, total));
  }, [ended, total]);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement === root) {
      manualFullscreenExitRef.current = true;
      void document.exitFullscreen?.().catch(() => {
        manualFullscreenExitRef.current = false;
      });
    } else {
      void root.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  const applyScale = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const slideEl = slideElRef.current;
    const size = slideSizeRef.current;
    if (!stage || !canvas || !slideEl || !size) return;
    const scale = resolvePresentationScale(size, {
      width: stage.clientWidth,
      height: stage.clientHeight,
    });
    canvas.style.width = `${Math.round(size.width * scale)}px`;
    canvas.style.height = `${Math.round(size.height * scale)}px`;
    slideEl.style.transform = `scale(${scale})`;
  }, []);

  // Enter native fullscreen best-effort on mount; keep modal working even if declined.
  useEffect(() => {
    const root = rootRef.current;
    revealHud();
    if (root?.requestFullscreen) {
      void root.requestFullscreen().catch(() => undefined);
    }
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === rootRef.current;
      setIsFullscreen(active);
      if (active) {
        wasFullscreenRef.current = true;
        return;
      }
      if (wasFullscreenRef.current) {
        wasFullscreenRef.current = false;
        if (manualFullscreenExitRef.current) {
          manualFullscreenExitRef.current = false;
          return;
        }
        // OS/Escape exit from native fullscreen exits presentation in a single press.
        handleClose();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      clearTimeout(hudTimerRef.current);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement && document.fullscreenElement === root) {
        void document.exitFullscreen?.().catch(() => undefined);
      }
    };
  }, [handleClose, revealHud]);

  // Render the active presentation slide cleanly into the black viewport.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (ended) {
      canvas.replaceChildren();
      slideElRef.current = null;
      slideSizeRef.current = null;
      setNotes('');
      return;
    }
    const rendered = session.renderPresentationSlide(index);
    if (!rendered) {
      canvas.replaceChildren();
      slideElRef.current = null;
      slideSizeRef.current = null;
      setNotes('');
      return;
    }
    slideElRef.current = rendered.element;
    slideSizeRef.current = { width: rendered.width, height: rendered.height };
    setNotes(rendered.notes.trim());
    canvas.replaceChildren(rendered.element);
    applyScale();
  }, [applyScale, ended, index, session]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const observer = new ResizeObserver(() => applyScale());
    observer.observe(stage);
    return () => observer.disconnect();
  }, [applyScale]);

  // Capture presentation shortcuts ahead of the editor below.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          handleClose();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
          event.preventDefault();
          event.stopPropagation();
          goNext();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          event.preventDefault();
          event.stopPropagation();
          goPrev();
          break;
        case 'Home':
          event.preventDefault();
          event.stopPropagation();
          setEnded(false);
          setIndex(0);
          break;
        case 'End':
          event.preventDefault();
          event.stopPropagation();
          setEnded(false);
          setIndex(Math.max(0, total - 1));
          break;
        case 'n':
        case 'N':
          event.preventDefault();
          event.stopPropagation();
          setShowNotes(value => !value);
          revealHud();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [goNext, goPrev, handleClose, revealHud, total]);

  return createPortal(
    <div
      ref={rootRef}
      className="lobster-slides-present-root"
      role="dialog"
      aria-modal="true"
      aria-label={t('slidesPresent')}
      onMouseMove={revealHud}
    >
      <div
        ref={stageRef}
        className="lobster-slides-present-stage"
        onClick={goNext}
      >
        {ended ? (
          <div className="lobster-slides-present-end" onClick={event => event.stopPropagation()}>
            <p className="lobster-slides-present-end-title">{t('slidesPresentEnd')}</p>
            <p className="lobster-slides-present-end-hint">{t('slidesPresentEndHint')}</p>
            <div className="lobster-slides-present-end-actions">
              <button
                type="button"
                className="lobster-slides-present-end-btn"
                onClick={() => {
                  setEnded(false);
                  setIndex(0);
                }}
              >
                {t('slidesPresentRestart')}
              </button>
              <button
                type="button"
                className="lobster-slides-present-end-btn is-primary"
                onClick={handleClose}
              >
                {t('slidesPresentExit')}
              </button>
            </div>
          </div>
        ) : (
          <div ref={canvasRef} className="lobster-slides-present-canvas" />
        )}
      </div>

      {showNotes && !ended && (
        <div
          className="lobster-slides-present-notes"
          role="region"
          aria-label={t('slidesNotes')}
          onClick={event => event.stopPropagation()}
        >
          <div className="lobster-slides-present-notes-header">
            <span>{t('slidesNotes')}</span>
            <button
              type="button"
              className="lobster-slides-present-hud-btn"
              title={t('slidesHideNotes')}
              aria-label={t('slidesHideNotes')}
              onClick={() => setShowNotes(false)}
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="lobster-slides-present-notes-body">
            {notes || t('slidesNotesEmpty')}
          </p>
        </div>
      )}

      <div
        className={`lobster-slides-present-hud${hudVisible || showNotes || ended ? ' is-visible' : ''}`}
        onClick={event => event.stopPropagation()}
        onMouseEnter={() => {
          clearTimeout(hudTimerRef.current);
          setHudVisible(true);
        }}
        onMouseLeave={revealHud}
      >
        <button
          type="button"
          className="lobster-slides-present-hud-btn"
          title={t('slidesPrevious')}
          aria-label={t('slidesPrevious')}
          disabled={!ended && index <= 0}
          onClick={goPrev}
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>
        <span className="lobster-slides-present-counter">
          {ended ? `${total} / ${total}` : `${index + 1} / ${total}`}
        </span>
        <button
          type="button"
          className="lobster-slides-present-hud-btn"
          title={t('slidesNext')}
          aria-label={t('slidesNext')}
          disabled={ended}
          onClick={goNext}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>

        <span className="lobster-slides-present-divider" />

        <button
          type="button"
          className={`lobster-slides-present-hud-btn${showNotes ? ' is-active' : ''}`}
          title={showNotes ? t('slidesHideNotes') : t('slidesShowNotes')}
          aria-label={showNotes ? t('slidesHideNotes') : t('slidesShowNotes')}
          aria-pressed={showNotes}
          onClick={() => setShowNotes(value => !value)}
        >
          <ChatBubbleBottomCenterTextIcon className="h-4 w-4" />
          {notes && !showNotes && <span className="lobster-slides-present-notes-dot" />}
        </button>

        <button
          type="button"
          className="lobster-slides-present-hud-btn"
          title={isFullscreen ? t('slidesPresentExitFullscreen') : t('slidesPresentFullscreen')}
          aria-label={isFullscreen ? t('slidesPresentExitFullscreen') : t('slidesPresentFullscreen')}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <ArrowsPointingInIcon className="h-4 w-4" /> : <ArrowsPointingOutIcon className="h-4 w-4" />}
        </button>

        <button
          type="button"
          className="lobster-slides-present-hud-btn"
          title={t('slidesPresentExit')}
          aria-label={t('slidesPresentExit')}
          onClick={handleClose}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
