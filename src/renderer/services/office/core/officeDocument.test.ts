import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type OfficeFileApi, OfficeFileError, type OfficeOpenResult, type OfficePackageInfo, type OfficeResult,
} from '../../../../shared/office/core/officeFile';
import { SheetHiddenContent, SheetReadOnlyReason } from '../../../../shared/office/sheet/sheetFile';
import { WordReadOnlyReason } from '../../../../shared/office/word/wordFile';
import { OfficeDocument, type OfficeEditorPort, OfficeExportRefusal, OfficeSaveState } from './officeDocument';

const AUTOSAVE_MS = 700;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const success = <T>(value: T): OfficeResult<T> => ({ success: true, value });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

/** Each format's package facts next to the shared ones; the document keeps them, not the bytes. */
const FORMATS = [
  { name: 'Word', path: '/report.docx', extra: { fonts: [{ name: '宋体' }] }, readOnlyReason: WordReadOnlyReason.Revisions },
  { name: 'Excel', path: '/book.xlsx', extra: { hidden: [SheetHiddenContent.ChartSheets] }, readOnlyReason: SheetReadOnlyReason.PivotTables },
] as const;

describe.each(FORMATS)('$name document revisions and recovery', format => {
  type Info = OfficePackageInfo & Record<string, unknown>;
  type Recovery = OfficeOpenResult<Info>['recovery'];
  async function harness(recovery?: Recovery, readOnly: string[] = [], inUse = false) {
    const file: OfficeOpenResult<Info> = {
      sessionId: 'handle', filePath: format.path, bytes: bytes('disk'), version: 'disk-v1', recovery, readOnly, ...format.extra,
      ...(inUse ? { inUse } : {}),
    };
    const api = {
      open: vi.fn(async () => success(file)),
      read: vi.fn(async (): Promise<OfficeResult<OfficeOpenResult<Info>>> => success(file)),
      checkpoint: vi.fn(async (): Promise<OfficeResult<null>> => success(null)),
      save: vi.fn(async (): Promise<OfficeResult<{ version: string; originalCopyPath?: string }>> => success({ version: 'disk-v2' })),
      discardDraft: vi.fn(async (): Promise<OfficeResult<null>> => success(null)),
      release: vi.fn(async () => undefined),
    } satisfies OfficeFileApi<Info>;
    const port = {
      load: vi.fn(async (_bytes: Uint8Array) => undefined),
      save: vi.fn(async () => bytes('edited')),
      setReadOnly: vi.fn(),
    } satisfies OfficeEditorPort;
    const document = new OfficeDocument<Info>(file, api, port, { autosaveDelayMs: AUTOSAVE_MS, logTag: '[TestDocument]' });
    await document.initialize();
    return { document, api, port, file };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('autosaves without a mounted React subscriber; dirty edits are immediately unsafe', async () => {
    const { document, api } = await harness();
    document.changed();
    expect(document.unsafe).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(api.save).toHaveBeenCalledOnce();
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Saved);
    expect(document.unsafe).toBe(false);
  });

  test('keeps the package facts and the handle, never the file\'s bytes', async () => {
    const { document, api, file } = await harness({ bytes: bytes('draft'), baseVersion: 'disk-v1', revision: 3 });
    expect(document.file).toEqual({ sessionId: file.sessionId, filePath: file.filePath });
    expect(document.packageInfo).toEqual({ readOnly: [], ...format.extra });
    api.read.mockResolvedValueOnce(success({ ...file, bytes: bytes('external'), version: 'disk-v3', recovery: undefined }));
    await document.resolveConflict(false);
    expect(document.packageInfo).toEqual({ readOnly: [], ...format.extra });
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
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
    expect(document.dirty).toBe(false);
  });

  test('edits during an IPC save remain dirty and the next write uses its predecessor receipt', async () => {
    const { document, api } = await harness();
    const first = deferred<OfficeResult<{ version: string }>>();
    const second = deferred<OfficeResult<{ version: string }>>();
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
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Saved);
  });

  test('conflicts pause disk writes while newer edits still receive recovery checkpoints', async () => {
    const { document, api } = await harness();
    api.save.mockResolvedValueOnce({ success: false, code: OfficeFileError.Conflict });
    document.changed();
    await document.flush();
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Conflict);
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
    api.checkpoint.mockResolvedValueOnce({ success: false, code: OfficeFileError.Io });
    document.changed();
    await document.flush();
    expect(document.getSnapshot().draftSafe).toBe(false);
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Error);
    expect(api.save).not.toHaveBeenCalled();
  });

  test('an export the format writer refuses reports why and writes nothing', async () => {
    const { document, api, port } = await harness();
    port.save.mockRejectedValueOnce(new OfficeExportRefusal('merged-cells', 'Cannot write merged cells here'));
    document.changed();
    await document.flush();
    expect(document.getSnapshot()).toMatchObject({ status: OfficeSaveState.Error, errorCode: OfficeFileError.Unsupported, issue: 'merged-cells' });
    expect(api.checkpoint).not.toHaveBeenCalled();
    document.changed();
    expect(document.getSnapshot().issue).toBeUndefined();
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
    api.read.mockResolvedValueOnce({ success: false, code: OfficeFileError.Io });
    await document.refresh();
    expect(document.getSnapshot().needsResolution).toBe(true);
    document.changed();
    await document.flush();
    expect(api.checkpoint).toHaveBeenCalledOnce();
    expect(api.save).not.toHaveBeenCalled();
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Conflict);
  });

  test('retrying a failed checkpoint does not clear an unresolved disk conflict', async () => {
    const { document, api } = await harness();
    api.save.mockResolvedValueOnce({ success: false, code: OfficeFileError.Conflict });
    document.changed();
    await document.flush();
    api.checkpoint.mockResolvedValueOnce({ success: false, code: OfficeFileError.Io });
    document.changed();
    await document.flush();
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Error);
    expect(document.getSnapshot().needsResolution).toBe(true);
    await document.flush();
    expect(api.save).toHaveBeenCalledOnce();
    expect(document.unsafe).toBe(false);
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Conflict);
  });

  test('a file another program holds open is reported on opening, and no longer once it reads free', async () => {
    const { document, api, file } = await harness(undefined, [], true);
    expect(document.getSnapshot()).toMatchObject({ status: OfficeSaveState.Saved, inUse: true });
    expect(document.packageInfo).toEqual({ readOnly: [], ...format.extra });
    api.read.mockResolvedValueOnce(success({ ...file, inUse: true }));
    await document.refresh();
    expect(document.getSnapshot().inUse).toBe(true);
    api.read.mockResolvedValueOnce(success({ ...file, inUse: false }));
    await document.refresh();
    expect(document.getSnapshot()).toMatchObject({ status: OfficeSaveState.Saved, inUse: false });
    expect(api.save).not.toHaveBeenCalled();
  });

  test('a save refused while another program holds the file waits, then is written once a refresh finds it free', async () => {
    const { document, api, port, file } = await harness();
    api.save.mockResolvedValueOnce({ success: false, code: OfficeFileError.InUse });
    document.changed();
    await document.flush();
    expect(document.getSnapshot()).toMatchObject({ status: OfficeSaveState.Pending, errorCode: undefined, inUse: true, draftSafe: true });
    expect(document.dirty).toBe(true);
    api.read.mockResolvedValueOnce(success({ ...file, inUse: true }));
    await document.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.save).toHaveBeenCalledOnce();
    await document.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(port.load).toHaveBeenCalledTimes(1);
    expect(document.dirty).toBe(false);
    expect(document.getSnapshot()).toMatchObject({ status: OfficeSaveState.Saved, inUse: false });
  });

  test('a read another program refuses outright keeps the content and reports the file held open', async () => {
    const { document, api, port } = await harness();
    api.read.mockResolvedValueOnce({ success: false, code: OfficeFileError.InUse });
    await document.refresh();
    expect(document.getSnapshot()).toMatchObject({ status: OfficeSaveState.Saved, inUse: true });
    expect(document.getSnapshot().errorCode).toBeUndefined();
    await document.refresh();
    expect(document.getSnapshot().inUse).toBe(false);
    expect(port.load).toHaveBeenCalledTimes(1);
  });

  test('a refresh does not repeat saves that failed for other reasons', async () => {
    const { document, api } = await harness();
    api.save.mockResolvedValueOnce({ success: false, code: OfficeFileError.Io });
    document.changed();
    await document.flush();
    await document.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.save).toHaveBeenCalledOnce();
    expect(document.getSnapshot()).toMatchObject({ status: OfficeSaveState.Error, errorCode: OfficeFileError.Io });
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
    const read = deferred<OfficeResult<OfficeOpenResult<Info>>>();
    api.read.mockImplementationOnce(() => read.promise);
    const refreshing = document.refresh();
    await vi.advanceTimersByTimeAsync(0);
    document.changed();
    read.resolve(success({ ...file, bytes: bytes('external'), version: 'external-v2' }));
    await refreshing;
    expect(port.load).toHaveBeenCalledTimes(1);
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Conflict);
  });

  test('a delayed read cannot roll back a newer successful save', async () => {
    const { document, api, port, file } = await harness();
    const read = deferred<OfficeResult<OfficeOpenResult<Info>>>();
    api.read.mockImplementationOnce(() => read.promise);
    const refreshing = document.refresh();
    await vi.advanceTimersByTimeAsync(0);
    document.changed();
    await document.flush();
    read.resolve(success(file));
    await refreshing;
    expect(port.load).toHaveBeenCalledTimes(1);
    expect(document.getSnapshot().status).toBe(OfficeSaveState.Saved);
  });

  test('read-only content stays in viewing mode after loading and refreshing', async () => {
    const { document, port, api, file } = await harness(undefined, [format.readOnlyReason]);
    expect(document.locked).toBe(true);
    expect(document.getSnapshot().readOnlyReasons).toEqual([format.readOnlyReason]);
    expect(port.setReadOnly).toHaveBeenLastCalledWith(true);
    api.read.mockResolvedValueOnce(success({ ...file, bytes: bytes('clean'), version: 'disk-v3', readOnly: [] }));
    await document.refresh();
    expect(document.locked).toBe(false);
    expect(port.setReadOnly).toHaveBeenLastCalledWith(false);
  });
});
