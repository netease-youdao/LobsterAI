import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  findVerticalAlphaBounds,
  normalizePetManifest,
  PetAction,
  type PetAtlasVerticalBounds,
  type PetManifest,
  type RawPetManifest,
} from '../../../../shared/desktopCompanion/petAtlas';

export interface LoadedPetAtlas {
  manifest: PetManifest;
  image: HTMLImageElement;
  standingBounds: PetAtlasVerticalBounds | null;
  staticWidth?: number;
  staticHeight?: number;
}

type AtlasCacheEntry =
  | { status: 'loading'; promise: Promise<LoadedPetAtlas | null> }
  | { status: 'ready'; atlas: LoadedPetAtlas }
  | { status: 'error' };

const atlasCache = new Map<string, AtlasCacheEntry>();

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise<HTMLImageElement | null>(resolve => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (typeof img.decode === 'function') {
        void img.decode().then(() => resolve(img), () => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function measureStandingBounds(image: HTMLImageElement, manifest: PetManifest): PetAtlasVerticalBounds | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = manifest.cellWidth;
    canvas.height = manifest.cellHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const idleRow = manifest.actions[PetAction.Idle].row;
    ctx.drawImage(
      image,
      0,
      idleRow * manifest.cellHeight,
      manifest.cellWidth,
      manifest.cellHeight,
      0,
      0,
      manifest.cellWidth,
      manifest.cellHeight,
    );
    const { data } = ctx.getImageData(0, 0, manifest.cellWidth, manifest.cellHeight);
    return findVerticalAlphaBounds(data, manifest.cellWidth, manifest.cellHeight);
  } catch {
    // Tainted canvas under file:// falls back cleanly to standard Codex Pets standing ratios.
    return null;
  }
}

async function loadPetAtlas(manifestUrl: string, staticAssetUrl?: string): Promise<LoadedPetAtlas | null> {
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) return null;
    const raw = (await response.json()) as RawPetManifest;
    const manifest = normalizePetManifest(raw, manifestUrl);
    if (!manifest) return null;

    const [image, staticImage] = await Promise.all([
      loadImage(manifest.spritesheetUrl),
      staticAssetUrl ? loadImage(staticAssetUrl) : Promise.resolve(null),
    ]);
    if (!image) return null;

    return {
      manifest,
      image,
      standingBounds: measureStandingBounds(image, manifest),
      staticWidth: staticImage?.naturalWidth || undefined,
      staticHeight: staticImage?.naturalHeight || undefined,
    };
  } catch {
    return null;
  }
}

/** Loads and caches a Codex-compatible pet.json + spritesheet.webp atlas once per skin. */
export function usePetAtlas(
  manifestUrl: string | undefined,
  staticAssetUrl?: string | undefined,
): LoadedPetAtlas | null {
  const cacheKey = manifestUrl ? `${manifestUrl}\0${staticAssetUrl ?? ''}` : '';
  const [loaded, setLoaded] = useState<LoadedPetAtlas | null>(() => {
    if (!cacheKey) return null;
    const cached = atlasCache.get(cacheKey);
    return cached?.status === 'ready' ? cached.atlas : null;
  });

  useEffect(() => {
    if (!manifestUrl || !cacheKey) {
      setLoaded(null);
      return;
    }
    const existing = atlasCache.get(cacheKey);
    if (existing?.status === 'ready') {
      setLoaded(existing.atlas);
      return;
    }
    if (existing?.status === 'error') {
      setLoaded(null);
      return;
    }

    let cancelled = false;
    const promise = existing?.status === 'loading' ? existing.promise : loadPetAtlas(manifestUrl, staticAssetUrl);
    if (!existing) atlasCache.set(cacheKey, { status: 'loading', promise });

    void promise.then(result => {
      if (result) atlasCache.set(cacheKey, { status: 'ready', atlas: result });
      else atlasCache.set(cacheKey, { status: 'error' });
      if (!cancelled) setLoaded(result);
    });

    return () => { cancelled = true; };
  }, [cacheKey, manifestUrl, staticAssetUrl]);

  return loaded;
}

interface PetAtlasPlayerProps {
  atlas: LoadedPetAtlas;
  action: PetAction;
  /** Target canvas dimensions in CSS pixels (preserving atlas cell aspect ratio). */
  displayWidth: number;
  displayHeight: number;
  /** Vertical CSS offset from box center to align the standing character with the static `.webp`. */
  offsetY?: number;
  onCycleComplete?: (action: PetAction) => void;
}

/**
 * DPR-aware `<canvas>` renderer for Codex Pets v1 (8x9) and v2 (8x11) sprite atlases.
 * Mounted only while an action is active (idle stays static with zero timers or rAF).
 */
export default function PetAtlasPlayer({
  atlas,
  action,
  displayWidth,
  displayHeight,
  offsetY = 0,
  onCycleComplete,
}: PetAtlasPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onCycleRef = useRef(onCycleComplete);
  onCycleRef.current = onCycleComplete;

  const { manifest, image } = atlas;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || displayWidth <= 0 || displayHeight <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const pixelW = Math.round(displayWidth * dpr);
    const pixelH = Math.round(displayHeight * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const drawCell = (row: number, col: number) => {
      ctx.clearRect(0, 0, displayWidth, displayHeight);
      ctx.drawImage(
        image,
        col * manifest.cellWidth,
        row * manifest.cellHeight,
        manifest.cellWidth,
        manifest.cellHeight,
        0,
        0,
        displayWidth,
        displayHeight,
      );
    };

    const spec = manifest.actions[action];
    let frame = 0;
    drawCell(spec.row, frame);
    if (spec.frames <= 1 || spec.fps <= 0) return;

    const frameDurationMs = 1000 / spec.fps;
    let rafId = 0;
    let lastTime = 0;
    let accumulator = 0;

    const tick = (now: number) => {
      if (lastTime === 0) {
        lastTime = now;
      } else if (!document.hidden) {
        const elapsed = Math.min(now - lastTime, frameDurationMs * 2);
        lastTime = now;
        accumulator += elapsed;
        if (accumulator >= frameDurationMs) {
          const steps = Math.floor(accumulator / frameDurationMs);
          accumulator -= steps * frameDurationMs;
          const next = frame + steps;
          if (next >= spec.frames) {
            frame = next % spec.frames;
            drawCell(spec.row, frame);
            onCycleRef.current?.(action);
          } else {
            frame = next;
            drawCell(spec.row, frame);
          }
        }
      } else {
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [image, manifest, action, displayWidth, displayHeight]);

  return (
    <canvas
      ref={canvasRef}
      className="character-atlas-canvas"
      style={{
        width: displayWidth,
        height: displayHeight,
        '--atlas-offset-y': `${offsetY}px`,
      } as CSSProperties}
      aria-hidden="true"
    />
  );
}
