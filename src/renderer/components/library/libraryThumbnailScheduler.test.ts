import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  LibraryThumbnailFailureCode,
  type LibraryThumbnailGenerateResponse,
  LibraryThumbnailRequestPriority,
} from '../../../shared/library/thumbnail';
import {
  LibraryThumbnailLoadStatus,
  LibraryThumbnailScheduler,
} from './libraryThumbnailScheduler';

const flushTasks = (): Promise<void> => new Promise(resolve => {
  setImmediate(resolve);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LibraryThumbnailScheduler', () => {
  test('limits IPC work and starts visible tasks before queued near-viewport tasks', async () => {
    const scheduler = new LibraryThumbnailScheduler({ maxConcurrency: 1 });
    const started: string[] = [];
    const releases = new Map<string, (response: LibraryThumbnailGenerateResponse) => void>();
    const load = (name: string) => () => new Promise<LibraryThumbnailGenerateResponse>(resolve => {
      started.push(name);
      releases.set(name, resolve);
    });

    scheduler.subscribe({
      key: 'running',
      priority: LibraryThumbnailRequestPriority.NearViewport,
      load: load('running'),
      onStateChange: () => undefined,
    });
    scheduler.subscribe({
      key: 'near',
      priority: LibraryThumbnailRequestPriority.NearViewport,
      load: load('near'),
      onStateChange: () => undefined,
    });
    scheduler.subscribe({
      key: 'visible',
      priority: LibraryThumbnailRequestPriority.Visible,
      load: load('visible'),
      onStateChange: () => undefined,
    });
    expect(started).toEqual(['running']);

    releases.get('running')?.({ success: true, dataUrl: 'running' });
    await flushTasks();
    expect(started).toEqual(['running', 'visible']);
    releases.get('visible')?.({ success: true, dataUrl: 'visible' });
    await flushTasks();
    releases.get('near')?.({ success: true, dataUrl: 'near' });
    await flushTasks();
    scheduler.clear();
  });

  test('deduplicates the same file version and cancels work after the last subscriber leaves', () => {
    const scheduler = new LibraryThumbnailScheduler({ maxConcurrency: 1 });
    const load = vi.fn(() => new Promise<LibraryThumbnailGenerateResponse>(() => undefined));
    const cancel = vi.fn();
    const first = scheduler.subscribe({
      key: 'same',
      priority: LibraryThumbnailRequestPriority.Visible,
      load,
      cancel,
      onStateChange: () => undefined,
    });
    const second = scheduler.subscribe({
      key: 'same',
      priority: LibraryThumbnailRequestPriority.NearViewport,
      load,
      cancel,
      onStateChange: () => undefined,
    });

    expect(load).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    expect(cancel).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(cancel).toHaveBeenCalledTimes(1);
    scheduler.clear();
  });

  test('retries transient failures but leaves permanent failures settled', async () => {
    vi.useFakeTimers();
    const scheduler = new LibraryThumbnailScheduler({
      maxConcurrency: 1,
      retryDelaysMs: [10],
    });
    const states: string[] = [];
    const load = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        failureCode: LibraryThumbnailFailureCode.PresentationTimeout,
        retryable: true,
      })
      .mockResolvedValueOnce({ success: true, dataUrl: 'ready' });
    scheduler.subscribe({
      key: 'transient',
      priority: LibraryThumbnailRequestPriority.Visible,
      load,
      onStateChange: state => states.push(state.status),
    });
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(2);
    expect(states).toContain(LibraryThumbnailLoadStatus.RetryWait);
    expect(states[states.length - 1]).toBe(LibraryThumbnailLoadStatus.Ready);

    const permanentStates: string[] = [];
    const permanentLoad = vi.fn(async () => ({
      success: false,
      failureCode: LibraryThumbnailFailureCode.UnsupportedFormat,
      retryable: false,
    }));
    const permanentSubscription = scheduler.subscribe({
      key: 'unsupported',
      priority: LibraryThumbnailRequestPriority.Visible,
      load: permanentLoad,
      onStateChange: state => permanentStates.push(state.status),
    });
    await vi.runAllTimersAsync();
    expect(permanentStates[permanentStates.length - 1]).toBe(
      LibraryThumbnailLoadStatus.Unsupported,
    );
    permanentSubscription.unsubscribe();
    const remountedStates: string[] = [];
    scheduler.subscribe({
      key: 'unsupported',
      priority: LibraryThumbnailRequestPriority.Visible,
      load: permanentLoad,
      onStateChange: state => remountedStates.push(state.status),
    });
    await vi.runAllTimersAsync();
    expect(permanentLoad).toHaveBeenCalledTimes(1);
    expect(remountedStates[remountedStates.length - 1]).toBe(
      LibraryThumbnailLoadStatus.Unsupported,
    );
    scheduler.clear();
  });
});
