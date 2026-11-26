import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { ipcMain } from 'electron';

import { LibraryErrorCode, LibraryIpc, LibraryLimits, LibraryLocalSort, LibrarySort } from '../../shared/library/constants';
import { LibraryLocalDataError } from '../../shared/library/localOrdering';
import type { LibraryIpcDependencies } from './libraryIpc';
import { normalizeLibraryTargetItemIds, normalizeLocalListOptions, registerLibraryIpcHandlers } from './libraryIpc';

describe('library IPC validation', () => {
  test('preserves exact identifiers while deduplicating targeted reads', () => {
    expect(normalizeLibraryTargetItemIds({
      itemIds: [' item-1 ', 'item-2', 'item-1'],
    })).toEqual([' item-1 ', 'item-2', 'item-1']);
  });

  test('rejects empty, oversized, and malformed targeted item batches', () => {
    expect(() => normalizeLibraryTargetItemIds({ itemIds: [] })).toThrow();
    expect(() => normalizeLibraryTargetItemIds({
      itemIds: Array.from(
        { length: LibraryLimits.MaxTargetItemIds + 1 },
        (_, index) => `item-${index}`,
      ),
    })).toThrow();
    expect(() => normalizeLibraryTargetItemIds({ itemIds: ['valid', 1] })).toThrow();
  });

  test('defaults to the task protocol and rejects cloud sorts and old cursors', () => {
    expect(normalizeLocalListOptions({})).toEqual({});
    expect(normalizeLocalListOptions({ sort: LibraryLocalSort.RecentTask })).toEqual({ sort: LibraryLocalSort.RecentTask });
    expect(() => normalizeLocalListOptions({ sort: LibrarySort.RecentlyUpdated })).toThrow();
    for (const cursor of ['', 12, '!', Buffer.from(JSON.stringify({ sortTime: 1, itemId: 'old' })).toString('base64url')]) {
      expect(() => normalizeLocalListOptions({ cursor })).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidCursor }));
    }
  });

  test('preserves structured cursor and data failures through local IPC', () => {
    const list = vi.fn(() => { throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid data.'); });
    registerLibraryIpcHandlers({ localStore: { list }, indexService: {} } as unknown as LibraryIpcDependencies);
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === LibraryIpc.ListLocal);
    expect(call).toBeDefined();
    const handler = call![1];
    expect(handler({} as Electron.IpcMainInvokeEvent, {})).toMatchObject({ success: false, code: LibraryErrorCode.InvalidLocalData });
    expect(handler({} as Electron.IpcMainInvokeEvent, { cursor: 'invalid' })).toMatchObject({ success: false, code: LibraryErrorCode.InvalidCursor });
  });

  test('routes grid task queries separately and preserves validation, cursor and missing-task failures', () => {
    vi.mocked(ipcMain.handle).mockClear();
    const listTaskGroups = vi.fn(() => ({ groups: [] }));
    const listTaskItems = vi.fn(() => {
      throw new LibraryLocalDataError(LibraryErrorCode.NotFound, 'Missing task.');
    });
    registerLibraryIpcHandlers({
      localStore: { listTaskGroups, listTaskItems }, indexService: {},
    } as unknown as LibraryIpcDependencies);
    const groups = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === LibraryIpc.ListLocalTaskGroups)![1];
    const items = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === LibraryIpc.ListLocalTaskItems)![1];
    const event = {} as Electron.IpcMainInvokeEvent;
    expect(groups(event, undefined)).toMatchObject({ success: true, data: { groups: [] } });
    expect(groups(event, { taskPageSize: 0 })).toMatchObject({ success: false, code: LibraryErrorCode.InvalidInput });
    expect(groups(event, { taskCursor: 'invalid' })).toMatchObject({ success: false, code: LibraryErrorCode.InvalidCursor });
    expect(items(event, {})).toMatchObject({ success: false, code: LibraryErrorCode.InvalidInput });
    expect(items(event, { sessionId: 'missing' })).toMatchObject({ success: false, code: LibraryErrorCode.NotFound });
    expect(items(event, { sessionId: 'task', itemCursor: 'invalid' })).toMatchObject({ success: false, code: LibraryErrorCode.InvalidCursor });
    expect(listTaskGroups).toHaveBeenCalledTimes(1);
    expect(listTaskItems).toHaveBeenCalledTimes(1);
  });

  test('rejects forged private-session candidates before indexing and passes trusted actors to paths', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const owner = { userId: '1001', scopeKey: 'personal' };
    const recordCandidates = vi.fn();
    const sessionExists = vi.fn(() => false);
    const resolvePath = vi.fn(() => null);
    registerLibraryIpcHandlers({ getOwner: () => owner,
      localStore: { sessionExists, resolvePath }, indexService: { recordCandidates },
    } as unknown as LibraryIpcDependencies);
    const handler = (channel: string) => vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1];
    const event = {} as Electron.IpcMainInvokeEvent;
    const result = await handler(LibraryIpc.RecordCandidates)(event, [{
      sessionId: 'private', filePath: '/private/path.md', detectedType: 'markdown', relationKind: 'created', relatedAt: 1,
    }]);
    expect(result).toMatchObject({ success: false, code: LibraryErrorCode.NotFound });
    expect(recordCandidates).not.toHaveBeenCalled();
    expect(sessionExists).toHaveBeenCalledWith('private', owner);
    await handler(LibraryIpc.OpenLocal)(event, 'private-file');
    expect(resolvePath).toHaveBeenCalledWith('private-file', owner);
  });

  test('returns access only through the trusted file policy and hides unavailable identifiers', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const authorize = vi.fn((itemId: string) => {
      if (itemId !== 'mine') throw new Error('private account or path');
      return { filePath: '/mine.md', access: { itemId, accountEpoch: 'boot:1' } };
    });
    registerLibraryIpcHandlers({ fileAccess: { authorize } } as unknown as LibraryIpcDependencies);
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === LibraryIpc.GetLocalAccess)![1];
    const event = {} as Electron.IpcMainInvokeEvent;
    expect(await handler(event, 'mine')).toEqual({ success: true, data: {
      filePath: '/mine.md', access: { itemId: 'mine', accountEpoch: 'boot:1' },
    } });
    const unavailable = await handler(event, 'other');
    expect(unavailable).toEqual(await handler(event, 'missing'));
    expect(unavailable).toEqual({ success: false, code: LibraryErrorCode.NotFound, error: 'Library item was not found.' });
    expect(await handler(event, null)).toMatchObject({ success: false });
  });

});
