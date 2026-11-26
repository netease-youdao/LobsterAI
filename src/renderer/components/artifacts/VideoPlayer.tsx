import { FilmIcon } from '@heroicons/react/24/outline';
import {
  PauseIcon,
  PlayIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
} from '@heroicons/react/24/solid';
import React, {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { i18nService } from '@/services/i18n';

import {
  formatVideoDuration,
  getPosterSeekTime,
  VideoLoadState,
  type VideoMediaMetadata,
} from './inlineVideoLayout';

const t = (key: string) => i18nService.t(key);

const INLINE_VIDEO_PLAY_EVENT = 'lobster:inline-video-play';
const CONTROLS_IDLE_HIDE_MS = 2200;

interface InlineVideoPlayDetail {
  playerId: string;
}

function notifyVideoPlaying(playerId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<InlineVideoPlayDetail>(INLINE_VIDEO_PLAY_EVENT, {
    detail: { playerId },
  }));
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export const VideoPlayerFullscreenMode = {
  Enter: 'enter',
  Exit: 'exit',
} as const;
export type VideoPlayerFullscreenMode = typeof VideoPlayerFullscreenMode[keyof typeof VideoPlayerFullscreenMode];

const FullscreenEnterIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 7.5V4.5a1 1 0 0 1 1-1h3" />
    <path d="M16.5 7.5V4.5a1 1 0 0 0-1-1h-3" />
    <path d="M3.5 12.5v3a1 1 0 0 0 1 1h3" />
    <path d="M16.5 12.5v3a1 1 0 0 1-1 1h-3" />
  </svg>
);

const FullscreenExitIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.5 3.5v3a1 1 0 0 1-1 1h-3" />
    <path d="M12.5 3.5v3a1 1 0 0 0 1 1h3" />
    <path d="M7.5 16.5v-3a1 1 0 0 0-1-1h-3" />
    <path d="M12.5 16.5v-3a1 1 0 0 1 1-1h3" />
  </svg>
);

export interface VideoPlayerHandle {
  pause: () => void;
  seekTo: (time: number, activateControls?: boolean) => void;
  getCurrentTime: () => number;
  togglePlay: () => void;
}

export interface VideoPlayerProps {
  sources: readonly string[];
  title: string;
  initialTime?: number;
  autoPlay?: boolean;
  compact?: boolean;
  posterMode?: boolean;
  nearViewport?: boolean;
  coverUntilPlay?: boolean;
  metaBadge?: string | null;
  fullscreenMode?: VideoPlayerFullscreenMode;
  className?: string;
  style?: React.CSSProperties;
  onToggleFullscreen?: (currentTime: number, wasPlaying: boolean) => void;
  onMetadataLoaded?: (metadata: VideoMediaMetadata) => void;
  onSourceError?: (info: { sourceIndex: number; code?: number; message?: string }) => void;
}

const VideoPlayer = React.forwardRef<VideoPlayerHandle, VideoPlayerProps>(({
  sources,
  title,
  initialTime = 0,
  autoPlay = false,
  compact = false,
  posterMode = false,
  nearViewport = true,
  coverUntilPlay = false,
  metaBadge,
  fullscreenMode = VideoPlayerFullscreenMode.Enter,
  className = '',
  style,
  onToggleFullscreen,
  onMetadataLoaded,
  onSourceError,
}, ref) => {
  const playerId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<number | null>(null);
  const hasActivatedRef = useRef(!posterMode || autoPlay);
  const appliedInitialTimeRef = useRef(false);
  const wasPlayingBeforeScrubRef = useRef(false);

  const sourcesKey = sources.join('\n');
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const [loadState, setLoadState] = useState<VideoLoadState>(VideoLoadState.Idle);
  const [frameReady, setFrameReady] = useState(false);
  const [hasActivated, setHasActivated] = useState(!posterMode || autoPlay);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(initialTime > 0 ? initialTime : 0);
  const [duration, setDuration] = useState(0);
  const [bufferedRatio, setBufferedRatio] = useState(0);
  const [muted, setMuted] = useState(posterMode && !autoPlay);
  const [volume, setVolume] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const src = sources[activeSourceIndex] ?? '';

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearIdleTimer();
    if (typeof window === 'undefined') return;
    idleTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, CONTROLS_IDLE_HIDE_MS);
  }, [clearIdleTimer]);

  const revealControls = useCallback((keepOpen = false) => {
    setControlsVisible(true);
    if (keepOpen || !isPlaying || isScrubbing) {
      clearIdleTimer();
    } else {
      scheduleControlsHide();
    }
  }, [clearIdleTimer, isPlaying, isScrubbing, scheduleControlsHide]);

  useEffect(() => {
    setActiveSourceIndex(0);
    setLoadState(VideoLoadState.Idle);
    setFrameReady(false);
    const startActive = !posterMode || autoPlay;
    setHasActivated(startActive);
    hasActivatedRef.current = startActive;
    appliedInitialTimeRef.current = false;
    setIsPlaying(false);
    setCurrentTime(initialTime > 0 ? initialTime : 0);
    setDuration(0);
    setBufferedRatio(0);
    setMuted(posterMode && !autoPlay);
  }, [autoPlay, initialTime, posterMode, sourcesKey]);

  useEffect(() => () => clearIdleTimer(), [clearIdleTimer]);

  useEffect(() => {
    if (!isPlaying || isScrubbing) {
      clearIdleTimer();
      setControlsVisible(true);
      return;
    }
    scheduleControlsHide();
  }, [clearIdleTimer, isPlaying, isScrubbing, scheduleControlsHide]);

  // Coordinate playback so only one video plays audio at a time.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleOtherVideoPlay = (event: Event) => {
      const detail = (event as CustomEvent<InlineVideoPlayDetail>).detail;
      if (detail?.playerId === playerId) return;
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
    };
    window.addEventListener(INLINE_VIDEO_PLAY_EVENT, handleOtherVideoPlay);
    return () => window.removeEventListener(INLINE_VIDEO_PLAY_EVENT, handleOtherVideoPlay);
  }, [playerId]);

  const startPlayback = useCallback((restartFromPoster = false) => {
    const video = videoRef.current;
    if (!video || loadState === VideoLoadState.Failed) return;
    hasActivatedRef.current = true;
    setHasActivated(true);
    if (video.muted && muted && volume > 0 && restartFromPoster) {
      video.muted = false;
      setMuted(false);
    }
    if (restartFromPoster && video.currentTime <= 0.25) {
      try {
        video.currentTime = 0;
        setCurrentTime(0);
      } catch {
        // Ignore seek failures before metadata settles.
      }
    } else if (video.ended) {
      try {
        video.currentTime = 0;
        setCurrentTime(0);
      } catch {
        // Ignore seek failures.
      }
    }
    notifyVideoPlaying(playerId);
    void video.play().catch(() => {
      // Keep controls visible so the user can retry if playback was blocked.
    });
  }, [loadState, muted, playerId, volume]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || loadState === VideoLoadState.Failed) return;
    if (!hasActivatedRef.current) {
      startPlayback(true);
      return;
    }
    if (video.paused || video.ended) {
      startPlayback(false);
    } else {
      video.pause();
    }
  }, [loadState, startPlayback]);

  useImperativeHandle(ref, () => ({
    pause: () => {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
    },
    seekTo: (time: number, activateControls = true) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(time) || time < 0) return;
      if (activateControls) {
        hasActivatedRef.current = true;
        setHasActivated(true);
        if (video.muted && volume > 0) {
          video.muted = false;
          setMuted(false);
        }
      }
      setFrameReady(true);
      setCurrentTime(time);
      try {
        video.currentTime = time;
      } catch {
        // Ignore seek errors when element has not buffered yet.
      }
    },
    getCurrentTime: () => {
      const video = videoRef.current;
      if (!video || !hasActivatedRef.current) return 0;
      return Number.isFinite(video.currentTime) ? video.currentTime : 0;
    },
    togglePlay,
  }), [togglePlay, volume]);

  const handleToggleMute = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    if (muted || volume === 0) {
      const nextVolume = volume > 0 ? volume : 1;
      video.muted = false;
      video.volume = nextVolume;
      setMuted(false);
      setVolume(nextVolume);
    } else {
      video.muted = true;
      setMuted(true);
    }
  }, [muted, volume]);

  const handleVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    const nextVolume = Number(event.target.value);
    const video = videoRef.current;
    if (!video || !Number.isFinite(nextVolume)) return;
    video.volume = nextVolume;
    video.muted = nextVolume === 0;
    setVolume(nextVolume);
    setMuted(nextVolume === 0);
  }, []);

  const seekFromClientX = useCallback((clientX: number) => {
    const bar = progressBarRef.current;
    const video = videoRef.current;
    if (!bar || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const nextTime = ratio * video.duration;
    setCurrentTime(nextTime);
    try {
      video.currentTime = nextTime;
    } catch {
      // Ignore transient seek failures.
    }
  }, []);

  const handleProgressPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const video = videoRef.current;
    wasPlayingBeforeScrubRef.current = Boolean(video && !video.paused);
    if (video && !video.paused) {
      video.pause();
    }
    setIsScrubbing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromClientX(event.clientX);
  }, [seekFromClientX]);

  const handleProgressPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing) return;
    event.stopPropagation();
    seekFromClientX(event.clientX);
  }, [isScrubbing, seekFromClientX]);

  const handleProgressPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsScrubbing(false);
    if (wasPlayingBeforeScrubRef.current && videoRef.current) {
      notifyVideoPlaying(playerId);
      void videoRef.current.play().catch(() => {});
    }
  }, [isScrubbing, playerId]);

  const triggerFullscreen = useCallback((event?: React.SyntheticEvent) => {
    event?.stopPropagation();
    if (!onToggleFullscreen) return;
    const video = videoRef.current;
    const activeTime = hasActivatedRef.current && video && Number.isFinite(video.currentTime)
      ? video.currentTime
      : 0;
    const wasPlaying = Boolean(video && !video.paused);
    if (fullscreenMode === VideoPlayerFullscreenMode.Enter && video && !video.paused) {
      video.pause();
    }
    onToggleFullscreen(activeTime, wasPlaying);
  }, [fullscreenMode, onToggleFullscreen]);

  const updateBufferedRatio = useCallback((video: HTMLVideoElement) => {
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.buffered.length === 0) {
      return;
    }
    try {
      const end = video.buffered.end(video.buffered.length - 1);
      setBufferedRatio(Math.min(1, Math.max(0, end / video.duration)));
    } catch {
      // Ignore out-of-range buffered queries.
    }
  }, []);

  const progressRatio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const durationLabel = duration > 0 ? (formatVideoDuration(duration) ?? '0:00') : '0:00';
  const showPosterOverlay = posterMode && !hasActivated && loadState !== VideoLoadState.Failed;
  const isExitFullscreen = fullscreenMode === VideoPlayerFullscreenMode.Exit;
  const fullscreenLabel = isExitFullscreen ? t('artifactVideoExitFullscreen') : t('artifactVideoFullscreen');
  const showControlBar = hasActivated && loadState !== VideoLoadState.Failed && Boolean(src);

  return (
    <div
      className={`group/stage relative overflow-hidden bg-neutral-950 select-none ${className}`}
      style={style}
      onMouseMove={() => revealControls(false)}
      onMouseLeave={() => {
        if (isPlaying && !isScrubbing) {
          clearIdleTimer();
          setControlsVisible(false);
        }
      }}
    >
      {loadState === VideoLoadState.Failed || !src ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-raised px-4 text-center text-xs text-muted">
          <FilmIcon className="h-6 w-6 text-secondary/70" aria-hidden="true" />
          <span>{src ? t('artifactVideoError') : t('artifactVideoLoading')}</span>
        </div>
      ) : (
        <>
          {nearViewport && (
            <video
              ref={videoRef}
              key={src}
              src={src}
              playsInline
              autoPlay={autoPlay}
              muted={muted}
              preload={autoPlay ? 'auto' : 'metadata'}
              onClick={togglePlay}
              onDoubleClick={onToggleFullscreen ? triggerFullscreen : undefined}
              className={`block h-full w-full cursor-pointer bg-black transition-opacity duration-200 ${
                coverUntilPlay && !hasActivated ? 'object-cover' : 'object-contain'
              } ${frameReady || hasActivated ? 'opacity-100' : 'opacity-0'}`}
              onLoadStart={() => {
                setLoadState(prev => (prev === VideoLoadState.Ready ? prev : VideoLoadState.Loading));
              }}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                const videoDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
                setDuration(videoDuration);
                updateBufferedRatio(video);
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                  onMetadataLoaded?.({
                    width: video.videoWidth,
                    height: video.videoHeight,
                    duration: videoDuration > 0 ? videoDuration : null,
                  });
                }
                if (!appliedInitialTimeRef.current && initialTime > 0 && videoDuration > 0 && initialTime < videoDuration) {
                  appliedInitialTimeRef.current = true;
                  try {
                    video.currentTime = initialTime;
                    setCurrentTime(initialTime);
                  } catch {
                    // Ignore initial seek errors.
                  }
                } else if (!hasActivatedRef.current) {
                  const seekTime = getPosterSeekTime(videoDuration);
                  if (seekTime > 0 && video.currentTime === 0) {
                    try {
                      video.currentTime = seekTime;
                    } catch {
                      // Fall back to frame 0.
                    }
                  }
                }
              }}
              onLoadedData={() => {
                setFrameReady(true);
                setLoadState(VideoLoadState.Ready);
              }}
              onSeeked={(event) => {
                setFrameReady(true);
                setLoadState(VideoLoadState.Ready);
                if (hasActivatedRef.current) {
                  setCurrentTime(event.currentTarget.currentTime);
                }
              }}
              onTimeUpdate={(event) => {
                if (!isScrubbing && hasActivatedRef.current) {
                  setCurrentTime(event.currentTarget.currentTime);
                }
                updateBufferedRatio(event.currentTarget);
              }}
              onProgress={(event) => updateBufferedRatio(event.currentTarget)}
              onPlay={() => {
                hasActivatedRef.current = true;
                setHasActivated(true);
                setFrameReady(true);
                setIsPlaying(true);
                notifyVideoPlaying(playerId);
              }}
              onPause={() => {
                setIsPlaying(false);
                setControlsVisible(true);
              }}
              onEnded={() => {
                setIsPlaying(false);
                setControlsVisible(true);
              }}
              onError={(event) => {
                onSourceError?.({
                  sourceIndex: activeSourceIndex,
                  code: event.currentTarget.error?.code,
                  message: event.currentTarget.error?.message,
                });
                if (activeSourceIndex < sources.length - 1) {
                  setActiveSourceIndex(index => index + 1);
                  return;
                }
                setLoadState(VideoLoadState.Failed);
              }}
            />
          )}

          {!frameReady && !hasActivated && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center bg-neutral-900/90"
            >
              <div className="h-full w-full animate-pulse bg-white/[0.04]" />
            </div>
          )}

          {showPosterOverlay && (
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-black/20">
              <button
                type="button"
                onClick={() => startPlayback(true)}
                aria-label={`${t('artifactVideoPlay')} ${title}`}
                className="flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
              >
                <span
                  className={`inline-flex ${compact ? 'h-10 w-10' : 'h-12 w-12'} items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/25 backdrop-blur-md transition-transform duration-200 group-hover/stage:scale-105`}
                >
                  <PlayIcon
                    className={`${compact ? 'h-4 w-4' : 'h-5 w-5'} translate-x-[1px]`}
                    aria-hidden="true"
                  />
                </span>
              </button>
              {metaBadge && (
                <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums text-white/95 backdrop-blur-sm">
                  {metaBadge}
                </span>
              )}
              {onToggleFullscreen && (
                <button
                  type="button"
                  onClick={triggerFullscreen}
                  title={fullscreenLabel}
                  aria-label={fullscreenLabel}
                  className="absolute bottom-2.5 right-2.5 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-black/55 text-white/90 opacity-0 backdrop-blur-sm transition-opacity duration-150 hover:bg-black/75 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 group-hover/stage:opacity-100"
                >
                  <FullscreenEnterIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          )}

          {showControlBar && (
            <div
              onClick={(event) => event.stopPropagation()}
              onMouseEnter={() => revealControls(true)}
              className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent transition-opacity duration-200 ${
                compact ? 'px-2.5 pb-2 pt-7' : 'px-3.5 pb-2.5 pt-8'
              } ${controlsVisible || !isPlaying || isScrubbing ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
              <div
                ref={progressBarRef}
                role="slider"
                tabIndex={0}
                aria-label={t('artifactVideoSeek')}
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(currentTime)}
                onPointerDown={handleProgressPointerDown}
                onPointerMove={handleProgressPointerMove}
                onPointerUp={handleProgressPointerUp}
                onPointerCancel={handleProgressPointerUp}
                onKeyDown={(event) => {
                  const video = videoRef.current;
                  if (!video || duration <= 0) return;
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowRight' ? 5 : -5;
                    const nextTime = Math.min(duration, Math.max(0, video.currentTime + delta));
                    video.currentTime = nextTime;
                    setCurrentTime(nextTime);
                  }
                }}
                className="group/bar relative flex h-4 w-full cursor-pointer items-center touch-none focus-visible:outline-none"
              >
                <div className="relative h-[3px] w-full rounded-full bg-white/30 transition-[height] duration-150 group-hover/bar:h-[5px]">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-white/40"
                    style={{ width: `${bufferedRatio * 100}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-white"
                    style={{ width: `${progressRatio * 100}%` }}
                  />
                  <span
                    className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform duration-150 ${
                      isScrubbing ? 'scale-100' : 'scale-0 group-hover/bar:scale-100'
                    }`}
                    style={{ left: `${progressRatio * 100}%` }}
                  />
                </div>
              </div>

              <div className="mt-0.5 flex items-center justify-between gap-2 text-white">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      togglePlay();
                    }}
                    title={isPlaying ? t('artifactVideoPause') : t('artifactVideoPlay')}
                    aria-label={isPlaying ? t('artifactVideoPause') : t('artifactVideoPlay')}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/95 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    {isPlaying ? (
                      <PauseIcon className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <PlayIcon className="h-4 w-4 translate-x-[0.5px]" aria-hidden="true" />
                    )}
                  </button>
                  <span className={`truncate font-medium tabular-nums text-white/90 ${compact ? 'text-[11px]' : 'text-xs'}`}>
                    {formatClock(currentTime)} / {durationLabel}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <div className="group/vol flex items-center gap-1">
                    {!compact && (
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={muted ? 0 : volume}
                        aria-label={t('artifactVideoVolume')}
                        onChange={handleVolumeChange}
                        onClick={(event) => event.stopPropagation()}
                        className="h-1 w-0 cursor-pointer accent-white opacity-0 transition-all duration-150 group-hover/vol:w-14 group-hover/vol:opacity-100 focus-visible:w-14 focus-visible:opacity-100"
                      />
                    )}
                    <button
                      type="button"
                      onClick={handleToggleMute}
                      title={muted || volume === 0 ? t('artifactVideoUnmute') : t('artifactVideoMute')}
                      aria-label={muted || volume === 0 ? t('artifactVideoUnmute') : t('artifactVideoMute')}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/95 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      {muted || volume === 0 ? (
                        <SpeakerXMarkIcon className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <SpeakerWaveIcon className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>

                  {onToggleFullscreen && (
                    <button
                      type="button"
                      onClick={triggerFullscreen}
                      title={fullscreenLabel}
                      aria-label={fullscreenLabel}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/95 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      {isExitFullscreen ? (
                        <FullscreenExitIcon className="h-4 w-4" />
                      ) : (
                        <FullscreenEnterIcon className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
