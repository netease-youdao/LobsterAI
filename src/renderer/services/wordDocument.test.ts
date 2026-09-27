import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type WordFileApi, WordFileError, type WordOpenResult, WordReadOnlyReason, type WordResult } from '../../shared/artifactPreview/wordEditing';
import { WordDocument, type WordEditorPort, WordSaveState } from './wordDocument';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const success = <T>(value: T): WordResult<T> => ({ success: true, value });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function harness(recovery?: WordOpenResult['recovery'], readOnly: WordOpenResult['readOnly'] = []) {
  const file: WordOpenResult = {
    sessionId: 'handle', filePath: '/report.docx', bytes: bytes('disk'), version: 'disk-v1', recovery, readOnly, fonts: [],
  };
  const api = {
    open: vi.fn(async () => success(file)),
    read: vi.fn(async () => success(file)),
    checkpoint: vi.fn(async () => success(null)),
    save: vi.fn(async () => success({ version: 'disk-v2' })),
    discardDraft: vi.fn(async () => success(null)),
    release: vi.fn(async () => undefined),
  } satisfies WordFileApi;
  const port = {
    load: vi.fn(async () => undefined), save: vi.fn(async () => bytes('edited')), setReadOnly: vi.fn(),
  } satisfies WordEditorPort;
  const document = new WordDocument(file, api, port);
  await document.initialize();
  return { document, api, port, file };
}

describe('Word document revisions and recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('autosaves without a mounted React subscriber; dirty edits are immediately unsafe', async () => {
    const { document, api } = await harness();
    document.changed();
    expect(document.unsafe).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(api.save).toHaveBeenCalledOnce();
    expect(document.getSnapshot().status).toBe(WordSaveState.Saved);
    expect(document.unsafe).toBe(false);
  });

  test('an export that awaited a later edit is not mislabeled or marked saved', async () => {
    const { document, api, port } = await harness();
    const pending = deferred<Uint8Array>();
    port.save.mockImplementationOnce(() => pending.promise);
    document.changed();
    const saving = document.flush();
    document.changed();
    pending.resolve(bytes('later revision'));
    await saving;
    expect(api.checkpoint).not.toHaveBeenCalled();
    expect(document.dirty).toBe(true);
    expect(document.unsafe).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
    expect(document.dirty).toBe(false);
  });

  test('edits during an IPC save remain dirty and the next write uses its predecessor receipt', async () => {
    const { document, api } = await harness();
    const first = deferred<WordResult<{ version: string }>>();
    const second = deferred<WordResult<{ version: string }>>();
    api.save.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    document.changed();
    const saving = document.flush();
    await vi.advanceTimersByTimeAsync(0);
    document.changed();
    expect(document.unsafe).toBe(true);
    first.resolve(success({ version: 'receipt-1' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.dirty).toBe(true);
    expect(api.save.mock.calls[1]).toEqual([expect.objectContaining({ revision: 2, baseVersion: 'receipt-1' })]);
    second.resolve(success({ version: 'receipt-2' }));
    await saving;
    expect(document.getSnapshot().status).toBe(WordSaveState.Saved);
  });

  test('conflicts pause disk writes while newer edits still receive recovery checkpoints', async () => {
    const { document, api } = await harness();
    api.save.mockResolvedValueOnce({ success: false, code: WordFileError.Conflict });
    document.changed();
    await document.flush();
    expect(document.getSnapshot().status).toBe(WordSaveState.Conflict);
    expect(document.unsafe).toBe(false);
    document.changed();
    await document.flush();
    expect(api.save).toHaveBeenCalledOnce();
    expect(api.checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }));
    expect(document.dirty).toBe(true);
    expect(document.unsafe).toBe(false);
  });

  test('a failed checkpoint cannot be advertised as recoverable or proceed to file replacement', async () => {
    const { document, api } = await harness();
    api.checkpoint.mockResolvedValueOnce({ success: false, code: WordFileError.Io });
    document.changed();
    await document.flush();
    expect(document.getSnapshot().draftSafe).toBe(false);
    expect(document.getSnapshot().status).toBe(WordSaveState.Error);
    expect(api.save).not.toHaveBeenCalled();
  });

  test('opening recovery never silently overwrites a file; the explicit keep choice does', async () => {
    const recovery = { bytes: bytes('recovered'), baseVersion: 'old-disk', revision: 8 };
    const { document, api, port } = await harness(recovery);
    expect(port.load).toHaveBeenCalledWith(recovery.bytes);
    expect(document.getSnapshot().restored).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.save).not.toHaveBeenCalled();
    await document.resolveConflict(true);
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 'disk-v1', revision: 8 }));
    expect(document.dirty).toBe(false);
  });

  test('choosing the disk version loads it without writing and discards recovery', async () => {
    const { document, api, port, file } = await harness({ bytes: bytes('draft'), baseVersion: 'old', revision: 4 });
    await document.resolveConflict(false);
    expect(port.load).toHaveBeenLastCalledWith(file.bytes);
    expect(api.discardDraft).toHaveBeenCalledWith(file.sessionId);
    expect(api.save).not.toHaveBeenCalled();
    expect(document.dirty).toBe(false);
  });

  test('a transient read error cannot authorize overwriting a recovered file', async () => {
    const { document, api } = await harness({ bytes: bytes('draft'), baseVersion: 'disk-v1', revision: 4 });
    api.read.mockResolvedValueOnce({ success: false, code: WordFileError.Io });
    await document.refresh();
    expect(document.getSnapshot().needsResolution).toBe(true);
    document.changed();
    await document.flush();
    expect(api.checkpoint).toHaveBeenCalledOnce();
    expect(api.save).not.toHaveBeenCalled();
    expect(document.getSnapshot().status).toBe(WordSaveState.Conflict);
  });

  test('retrying a failed checkpoint does not clear an unresolved disk conflict', async () => {
    const { document, api } = await harness();
    api.save.mockResolvedValueOnce({ success: false, code: WordFileError.Conflict });
    document.changed();
    await document.flush();
    api.checkpoint.mockResolvedValueOnce({ success: false, code: WordFileError.Io });
    document.changed();
    await document.flush();
    expect(document.getSnapshot().status).toBe(WordSaveState.Error);
    expect(document.getSnapshot().needsResolution).toBe(true);
    await document.flush();
    expect(api.save).toHaveBeenCalledOnce();
    expect(document.unsafe).toBe(false);
    expect(document.getSnapshot().status).toBe(WordSaveState.Conflict);
  });

  test('watcher notifications from our own save preserve the live model and undo history', async () => {
    const { document, api, port, file } = await harness();
    document.changed();
    await document.flush();
    api.read.mockResolvedValue(success({ ...file, version: 'disk-v2' }));
    await document.refresh();
    expect(port.load).toHaveBeenCalledTimes(1);
  });

  test('a refresh that finds no change leaves the editing mode alone', async () => {
    const { document, api, port, file } = await harness();
    port.setReadOnly.mockClear();
    document.changed();
    await document.flush();
    api.read.mockResolvedValue(success({ ...file, version: 'disk-v2' }));
    await document.refresh();
    await document.refresh();
    expect(port.setReadOnly).not.toHaveBeenCalled();
    expect(port.load).toHaveBeenCalledTimes(1);
  });

  test('an edit arriving during an external read is retained instead of replaced', async () => {
    const { document, api, port, file } = await harness();
    const read = deferred<WordResult<WordOpenResult>>();
    api.read.mockImplementationOnce(() => read.promise);
    const refreshing = document.refresh();
    await vi.advanceTimersByTimeAsync(0);
    document.changed();
    read.resolve(success({ ...file, bytes: bytes('external'), version: 'external-v2' }));
    await refreshing;
    expect(port.load).toHaveBeenCalledTimes(1);
    expect(document.getSnapshot().status).toBe(WordSaveState.Conflict);
  });

  test('a delayed read cannot roll back a newer successful save', async () => {
    const { document, api, port, file } = await harness();
    const read = deferred<WordResult<WordOpenResult>>();
    api.read.mockImplementationOnce(() => read.promise);
    const refreshing = document.refresh();
    await vi.advanceTimersByTimeAsync(0);
    document.changed();
    await document.flush();
    read.resolve(success(file));
    await refreshing;
    expect(port.load).toHaveBeenCalledTimes(1);
    expect(document.getSnapshot().status).toBe(WordSaveState.Saved);
  });
});

describe('Read-only Word documents', () => {
  test('review content stays in viewing mode after loading and refreshing', async () => {
    const { document, port, api, file } = await harness(undefined, [WordReadOnlyReason.Revisions]);
    expect(document.locked).toBe(true);
    expect(document.getSnapshot().readOnlyReasons).toEqual([WordReadOnlyReason.Revisions]);
    expect(port.setReadOnly).toHaveBeenLastCalledWith(true);
    api.read.mockResolvedValueOnce(success({ ...file, bytes: bytes('clean'), version: 'disk-v3', readOnly: [] }));
    await document.refresh();
    expect(document.locked).toBe(false);
    expect(port.setReadOnly).toHaveBeenLastCalledWith(false);
  });
});
