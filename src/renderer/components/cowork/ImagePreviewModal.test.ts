import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ImagePreviewModal, { type ImagePreviewSource } from './ImagePreviewModal';

// No DOM/test-renderer dependency is installed. Keep the real React element
// tree and exercise effects with deterministic scheduling and cleanup.
const hooks = vi.hoisted(() => {
  type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
  let stateCursor = 0, refCursor = 0, effectCursor = 0;
  let states: Array<{ value: unknown; set: (value: unknown) => void }> = [];
  let refs: Array<{ current: unknown }> = [];
  let effects: Effect[] = [];
  let pendingEffects: Array<() => void> = [];
  let mounted = true, dirty = false;
  const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => (
    !!left && !!right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))
  );
  return {
    reset: () => {
      states = []; refs = []; effects = []; pendingEffects = [];
      mounted = true; dirty = false;
    },
    begin: () => { stateCursor = 0; refCursor = 0; effectCursor = 0; dirty = false; },
    flushEffects: () => {
      const pending = pendingEffects; pendingEffects = [];
      pending.forEach(effect => effect());
      return dirty;
    },
    unmount: () => {
      if (!mounted) return;
      mounted = false; effects.forEach(effect => effect.cleanup?.());
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = stateCursor++;
      if (!states[index]) {
        states[index] = {
          value: typeof initial === 'function' ? (initial as () => T)() : initial,
          set: (next: unknown) => {
            if (!mounted) return;
            const previous = states[index].value;
            const value = typeof next === 'function' ? next(previous) : next;
            if (!Object.is(value, previous)) { states[index].value = value; dirty = true; }
          },
        };
      }
      return [states[index].value as T, states[index].set] as const;
    },
    useRef: <T,>(initial: T) => {
      const index = refCursor++;
      refs[index] ??= { current: initial };
      return refs[index] as { current: T };
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && sameDeps(previous.deps, deps)) return;
      effects[index] = { deps };
      pendingEffects.push(() => {
        previous?.cleanup?.();
        effects[index].cleanup = effect() || undefined;
      });
    },
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect };
});
vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

type ReadResult = { success: boolean; dataUrl?: string; error?: string };
type ImageProps = React.ImgHTMLAttributes<HTMLImageElement>;
const readFile = vi.fn<(filePath: string) => Promise<ReadResult>>();
const onClose = vi.fn();
const thumbnail = 'data:image/jpeg;base64,dGh1bWJuYWls';
const original = 'data:image/jpeg;base64,b3JpZ2luYWw=';
const attachment = (name = 'mobile.jpg'): ImagePreviewSource => ({
  src: thumbnail, name, localPath: `/remote-inputs/${name}`,
});
let image: ImagePreviewSource | null = null;
let tree: ReactNode;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

const findImage = (node: ReactNode): ReactElement<ImageProps> | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) { const result = findImage(child); if (result) return result; }
  } else if (React.isValidElement<{ children?: ReactNode }>(node)) {
    if (node.type === 'img') return node as ReactElement<ImageProps>;
    return findImage(node.props.children);
  }
  return undefined;
};
const displayedImage = () => {
  const result = findImage(tree);
  if (!result) throw new Error('No preview image rendered');
  return result.props;
};
const render = (nextImage = image) => {
  image = nextImage;
  for (let count = 0; count < 10; count++) {
    hooks.begin();
    tree = ImagePreviewModal({ image, onClose });
    if (!hooks.flushEffects()) return;
  }
  throw new Error('Modal render did not settle');
};
const settle = async () => {
  for (let count = 0; count < 6; count++) { await Promise.resolve(); render(); }
};

beforeEach(() => {
  hooks.reset(); vi.clearAllMocks(); image = null; tree = null;
  readFile.mockResolvedValue({ success: false });
  vi.stubGlobal('window', {
    electron: { dialog: { readFileAsDataUrl: readFile } },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
});
afterEach(() => { hooks.unmount(); vi.unstubAllGlobals(); });

test('reads the original only when opened, showing the thumbnail while it loads', async () => {
  const loading = deferred<ReadResult>(); readFile.mockReturnValue(loading.promise);
  render();
  expect(tree).toBeNull();
  expect(readFile).not.toHaveBeenCalled();
  render(attachment());
  expect(displayedImage().src).toBe(thumbnail);
  expect(readFile).toHaveBeenCalledWith('/remote-inputs/mobile.jpg');
  loading.resolve({ success: true, dataUrl: original }); await settle();
  expect(displayedImage().src).toBe(original);
  expect(readFile).toHaveBeenCalledTimes(1);
});

test('legacy and inline images without a local path keep their existing source', async () => {
  render({ src: original, name: 'legacy.jpg' }); await settle();
  expect(displayedImage().src).toBe(original);
  expect(readFile).not.toHaveBeenCalled();
});

test.each([
  { success: false, error: 'File not found' },
  { success: true },
])('keeps the thumbnail when the original read is unavailable: %j', async (result) => {
  readFile.mockResolvedValue(result);
  render(attachment()); await settle();
  expect(displayedImage().src).toBe(thumbnail);
});

test('keeps the thumbnail when the IPC promise rejects', async () => {
  readFile.mockRejectedValue(new Error('IPC unavailable'));
  render(attachment()); await settle();
  expect(displayedImage().src).toBe(thumbnail);
});

test('falls back to the thumbnail when the browser cannot decode the original', async () => {
  readFile.mockResolvedValue({ success: true, dataUrl: original });
  render(attachment()); await settle();
  expect(displayedImage().src).toBe(original);
  const onError = displayedImage().onError;
  expect(onError).toBeTypeOf('function');
  onError?.({ currentTarget: { src: original } } as React.SyntheticEvent<HTMLImageElement>);
  render();
  expect(displayedImage().src).toBe(thumbnail);
});

test('a late read for the previous image cannot replace the current original', async () => {
  const first = deferred<ReadResult>(), second = deferred<ReadResult>();
  readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(attachment('first.jpg'));
  render({ ...attachment('second.jpg'), src: 'second-thumbnail' });
  expect(displayedImage().src).toBe('second-thumbnail');
  second.resolve({ success: true, dataUrl: 'second-original' }); await settle();
  first.resolve({ success: true, dataUrl: original }); await settle();
  expect(displayedImage().src).toBe('second-original');
});

test('switching away from an already loaded original immediately shows the next thumbnail', async () => {
  readFile.mockResolvedValueOnce({ success: true, dataUrl: original });
  render(attachment()); await settle();
  expect(displayedImage().src).toBe(original);
  readFile.mockReturnValue(deferred<ReadResult>().promise);
  render({ ...attachment('next.jpg'), src: 'next-thumbnail' });
  expect(displayedImage().src).toBe('next-thumbnail');
});

test('closing and reopening the same image ignores the earlier in-flight read', async () => {
  const beforeClose = deferred<ReadResult>(), reopened = deferred<ReadResult>();
  readFile.mockReturnValueOnce(beforeClose.promise).mockReturnValueOnce(reopened.promise);
  const source = attachment();
  render(source); render(null);
  expect(tree).toBeNull();
  render(source);
  beforeClose.resolve({ success: true, dataUrl: 'stale-original' }); await settle();
  expect(displayedImage().src).toBe(thumbnail);
  reopened.resolve({ success: true, dataUrl: original }); await settle();
  expect(displayedImage().src).toBe(original);
});
