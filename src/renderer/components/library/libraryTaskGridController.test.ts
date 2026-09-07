import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryChangeReason,
  LibraryErrorCode,
  LibraryGridCursorKind,
  LibraryGridLimits,
  LibraryGridProtocol,
  LibraryIpc,
  LibraryItemKind,
  LibraryLocalSort,
  LibraryOrigin,
} from '../../../shared/library/constants';
import { getLibraryGridQueryKey } from '../../../shared/library/gridOrdering';
import type {
  LibraryLocalTaskGroupsData,
  LibraryLocalTaskGroupsOptions,
  LibraryLocalTaskItemsData,
  LibraryLocalTaskItemsOptions,
  LibraryResult,
  LibrarySessionRef,
  LocalArtifactItem,
} from '../../../shared/library/types';
import { LibraryTaskGridController } from './libraryTaskGridController';
import {
  appendLibraryTaskGroups,
  appendLibraryTaskItems,
  validateLibraryTaskGroups,
  validateLibraryTaskItems,
} from './libraryTaskGridValidation';

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value: string): Record<string, unknown> => JSON.parse(Buffer.from(value, 'base64url').toString());
const success = <T>(data: T): LibraryResult<T> => ({ success: true, data });
const settle = async (): Promise<void> => {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

const session = (index: number): LibrarySessionRef => ({
  sessionId: `task-${index}`, title: `Task ${index}`, agentId: 'main',
  createdAt: 100 - index, updatedAt: 1_000 - index, lastRelatedAt: 5,
});
const artifact = (owner: LibrarySessionRef, index: number, count: number): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId: `${owner.sessionId}-file-${index}`,
  title: `file-${index}.txt`, filePath: `/tmp/${owner.sessionId}/${index}.txt`,
  category: LibraryCategory.Document, artifactType: LibraryArtifactType.Text,
  sortTime: count - index + 0.5, createdAt: 0, extension: '.txt', isFavorite: false,
  availability: LibraryAvailability.Available, origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1, latestSession: owner,
});

const makeApi = (counts: number[]) => {
  const model = counts.map((count, index) => {
    const owner = session(index);
    return { session: owner, items: Array.from({ length: count }, (_, itemIndex) => artifact(owner, itemIndex, count)) };
  }).filter(group => group.items.length > 0);
  const groupsPage = (options: LibraryLocalTaskGroupsOptions): LibraryLocalTaskGroupsData => {
    const start = options.taskCursor
      ? model.findIndex(group => group.session.sessionId === decode(options.taskCursor!).sessionId) + 1 : 0;
    const pageSize = options.taskPageSize ?? LibraryGridLimits.DefaultTaskPageSize;
    const selected = model.slice(start, start + pageSize);
    const tail = selected[selected.length - 1];
    const hasMoreTasks = start + pageSize < model.length;
    return {
      protocolVersion: LibraryGridProtocol.Version, sort: LibraryLocalSort.RecentTask,
      groups: selected.map(group => ({ session: group.session, matchedFileCount: group.items.length,
        previewItems: group.items.slice(0, LibraryGridLimits.PreviewCount) })),
      counts: { total: model.reduce((sum, group) => sum + group.items.length, 0),
        available: model.reduce((sum, group) => sum + group.items.length, 0), missing: 0 },
      hasMoreTasks,
      ...(hasMoreTasks ? { nextTaskCursor: encode({
        version: LibraryGridProtocol.Version, kind: LibraryGridCursorKind.TaskGroups,
        sort: LibraryLocalSort.RecentTask, queryKey: getLibraryGridQueryKey(options),
        sessionId: tail.session.sessionId, sessionUpdatedAt: tail.session.updatedAt,
        sessionCreatedAt: tail.session.createdAt,
      }) } : {}),
    };
  };
  const itemsPage = (options: LibraryLocalTaskItemsOptions): LibraryLocalTaskItemsData => {
    const group = model.find(value => value.session.sessionId === options.sessionId)!;
    const start = options.itemCursor
      ? group.items.findIndex(item => item.itemId === decode(options.itemCursor!).itemId) + 1 : 0;
    const pageSize = options.pageSize ?? LibraryGridLimits.ItemPageSize;
    const items = group.items.slice(start, start + pageSize);
    const tail = items[items.length - 1];
    const hasMoreItems = start + pageSize < group.items.length;
    return {
      protocolVersion: LibraryGridProtocol.Version, sort: LibraryLocalSort.RecentTask,
      session: group.session, items, matchedFileCount: group.items.length, hasMoreItems,
      ...(hasMoreItems ? { nextItemCursor: encode({
        version: LibraryGridProtocol.Version, kind: LibraryGridCursorKind.TaskItems,
        sort: LibraryLocalSort.RecentTask, queryKey: getLibraryGridQueryKey(options),
        sessionId: options.sessionId, artifactSortTime: tail.sortTime, itemId: tail.itemId,
      }) } : {}),
    };
  };
  return {
    model, groupsPage, itemsPage,
    listLocalTaskGroups: vi.fn(async (options: LibraryLocalTaskGroupsOptions) => success(groupsPage(options))),
    listLocalTaskItems: vi.fn(async (options: LibraryLocalTaskItemsOptions) => success(itemsPage(options))),
  };
};

const controllers: LibraryTaskGridController[] = [];
const start = async (api = makeApi([120]), now?: () => number) => {
  const controller = new LibraryTaskGridController(() => api, now);
  controllers.push(controller);
  controller.configure({ active: true });
  await settle();
  return controller;
};

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe('task grid protocol validation', () => {
  test('task summaries count files exactly while previews intentionally omit hidden items', () => {
    const api = makeApi([10_000, 2, 1]);
    const page = api.groupsPage({});
    expect(validateLibraryTaskGroups(page, {}).groups.map(group => group.previewItems.length)).toEqual([3, 2, 1]);
    expect(page.counts.total).toBe(10_003);
    expect(() => validateLibraryTaskGroups({ ...page, protocolVersion: 2 }, {})).toThrow(/protocol/);
    expect(() => validateLibraryTaskGroups({ ...page, counts: { ...page.counts, total: 6 } }, {})).toThrow(/counts|totals/);
  });

  test('grid cursors bind task/item kind, filters, exact fractional tail, and item owner', () => {
    const api = makeApi([120, 5]);
    const options = { taskPageSize: 1, keyword: 'test' };
    const groups = api.groupsPage(options);
    expect(validateLibraryTaskGroups(groups, options)).toBe(groups);
    expect(() => validateLibraryTaskGroups(groups, { ...options, favoritesOnly: true })).toThrow(/cursor/);
    const itemsOptions = { sessionId: 'task-0', pageSize: 24 };
    const items = api.itemsPage(itemsOptions);
    expect(validateLibraryTaskItems(items, itemsOptions)).toBe(items);
    expect(() => validateLibraryTaskItems({ ...items, nextItemCursor: groups.nextTaskCursor }, itemsOptions)).toThrow(/cursor/);
    expect(() => validateLibraryTaskItems(items, { ...itemsOptions, sessionId: 'task-1' })).toThrow(/owner/);
    const cursor = decode(items.nextItemCursor!);
    expect(() => validateLibraryTaskItems({ ...items,
      nextItemCursor: encode({ ...cursor, artifactSortTime: Math.floor(Number(cursor.artifactSortTime)) }),
    }, itemsOptions)).toThrow(/cursor/);
  });

  test('rejects duplicate ownership, incomplete previews, reversed order, and missing items', () => {
    const api = makeApi([4, 4]);
    const page = api.groupsPage({});
    expect(() => validateLibraryTaskGroups({ ...page, groups: page.groups.slice().reverse() }, {})).toThrow(/ordering/);
    expect(() => validateLibraryTaskGroups({ ...page, groups: [{ ...page.groups[0], previewItems: [] }, page.groups[1]] }, {})).toThrow(/preview/);
    const data = api.itemsPage({ sessionId: 'task-0' });
    expect(() => validateLibraryTaskItems({ ...data, items: [data.items[0], data.items[0], ...data.items.slice(2)] },
      { sessionId: 'task-0' })).toThrow(/ordered/);
    expect(() => validateLibraryTaskItems({ ...data,
      items: [{ ...data.items[0], availability: LibraryAvailability.Missing }, ...data.items.slice(1)],
    }, { sessionId: 'task-0' })).toThrow(/artifact/);
  });

  test('cross-response count/order/projection drift is retryable, not silently deduplicated', () => {
    const api = makeApi([30, 5]);
    const current = api.groupsPage({ taskPageSize: 1 });
    const next = api.groupsPage({ taskPageSize: 1, taskCursor: current.nextTaskCursor });
    expect(appendLibraryTaskGroups(current, next).groups).toHaveLength(2);
    expect(() => appendLibraryTaskGroups(current, { ...next, counts: { ...next.counts, total: 36 } })).toThrow(/changed/);
    const items = api.itemsPage({ sessionId: 'task-0', pageSize: 24 });
    const nextItems = api.itemsPage({ sessionId: 'task-0', pageSize: 24, itemCursor: items.nextItemCursor });
    expect(appendLibraryTaskItems(items, nextItems).items).toHaveLength(30);
    expect(() => appendLibraryTaskItems(items, { ...nextItems, session: { ...nextItems.session, title: 'changed' } })).toThrow(/changed/);
  });
});

describe('task grid controller', () => {
  test.each([0, 1, 3, 4, 7, 24, 25, 120])('count %i defaults to at most three and expands to a fresh first 24', async count => {
    const api = makeApi([count]);
    const controller = await start(api);
    expect(controller.getSnapshot().groups[0]?.items.length ?? 0).toBe(Math.min(3, count));
    await controller.expand('task-0');
    expect(controller.getSnapshot().groups[0]?.items.length ?? 0).toBe(count > 3 ? Math.min(24, count) : count);
    expect(api.listLocalTaskItems).toHaveBeenCalledTimes(count > 3 ? 1 : 0);
    if (count > 3) expect(api.listLocalTaskItems.mock.calls[0][0]).toMatchObject({ pageSize: 24, itemCursor: undefined });
    if (count > 24) {
      await controller.loadMoreItems('task-0');
      expect(controller.getSnapshot().groups[0].items).toHaveLength(Math.min(48, count));
    }
  });

  test('one task with 10,000 files does not block the next seven tasks or consume inner pages', async () => {
    const api = makeApi([10_000, ...Array(10).fill(1)]);
    const controller = await start(api);
    expect(controller.getSnapshot().groups).toHaveLength(8);
    expect(controller.getSnapshot().counts.total).toBe(10_010);
    expect(api.listLocalTaskItems).not.toHaveBeenCalled();
    await controller.loadMoreTasks();
    expect(controller.getSnapshot().groups).toHaveLength(11);
    expect(api.listLocalTaskItems).not.toHaveBeenCalled();
    expect(controller.getSnapshot().hasMoreTasks).toBe(false);
  });

  test('duplicate expansion clicks are suppressed and collapsing cancels a late response', async () => {
    const api = makeApi([120]);
    const controller = await start(api);
    const response = deferred<LibraryResult<LibraryLocalTaskItemsData>>();
    api.listLocalTaskItems.mockImplementationOnce(() => response.promise);
    const first = controller.expand('task-0');
    await controller.expand('task-0');
    expect(api.listLocalTaskItems).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().groups[0].loading).toBe(true);
    controller.collapse('task-0');
    response.resolve(success(api.itemsPage({ sessionId: 'task-0', pageSize: 24 })));
    await first;
    expect(controller.getSnapshot().groups[0]).toMatchObject({ expanded: false, loading: false });
    expect(controller.getSnapshot().groups[0].items).toHaveLength(3);
  });

  test('an item request from another filter or inactive view cannot commit', async () => {
    const api = makeApi([120]);
    const controller = await start(api);
    const response = deferred<LibraryResult<LibraryLocalTaskItemsData>>();
    api.listLocalTaskItems.mockImplementationOnce(() => response.promise);
    const pending = controller.expand('task-0');
    controller.configure({ active: false });
    response.resolve(success(api.itemsPage({ sessionId: 'task-0', pageSize: 24 })));
    await pending;
    expect(controller.getSnapshot().groups[0].items).toHaveLength(3);
    controller.configure({ active: true, keyword: 'new' });
    await settle();
    expect(controller.getSnapshot().groups[0].expanded).toBe(false);
    expect(controller.getSnapshot().cursorValid).toBe(true);
  });

  test('completed expansion survives view toggles; filter changes and manual refresh collapse it', async () => {
    const api = makeApi([120]);
    const controller = await start(api);
    await controller.expand('task-0');
    await controller.loadMoreItems('task-0');
    controller.configure({ active: false });
    controller.configure({ active: true });
    await settle();
    expect(controller.getSnapshot().groups[0].items).toHaveLength(48);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(1);
    controller.refresh({ manual: true });
    await settle();
    expect(controller.getSnapshot().groups[0].expanded).toBe(false);
    expect(controller.getSnapshot().groups[0].items).toHaveLength(3);
  });

  test('background refresh preserves expanded depth across title/time changes and commits coherently', async () => {
    const api = makeApi([120, 4]);
    const controller = await start(api);
    await controller.expand('task-0');
    await controller.loadMoreItems('task-0');
    const owner = { ...api.model[0].session, title: 'New title', updatedAt: 2_000 };
    api.model[0] = { session: owner, items: api.model[0].items.map(item => ({ ...item, latestSession: owner })) };
    controller.refresh();
    expect(controller.getSnapshot().cursorValid).toBe(false);
    expect(controller.getSnapshot().groups[0].session.title).toBe('Task 0');
    await settle();
    expect(controller.getSnapshot().groups[0].session.title).toBe('New title');
    expect(controller.getSnapshot().groups[0].items).toHaveLength(48);
    expect(controller.getSnapshot().cursorValid).toBe(true);
  });

  test('read-budget exhaustion preserves the old snapshot, blocks cursors, and allows manual reset', async () => {
    let time = 0;
    const api = makeApi([120]);
    const controller = await start(api, () => time);
    await controller.expand('task-0');
    const oldItems = controller.getSnapshot().groups[0].items;
    api.listLocalTaskGroups.mockImplementation(async options => { time += 1_100; return success(api.groupsPage(options)); });
    api.listLocalTaskItems.mockImplementation(async options => { time += 1_100; return success(api.itemsPage(options)); });
    controller.refresh();
    await settle();
    expect(controller.getSnapshot().groups[0].items).toBe(oldItems);
    expect(controller.getSnapshot()).toMatchObject({ cursorValid: false, needsManualRefresh: true, refreshing: false });
    controller.refresh({ manual: true });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ cursorValid: true, needsManualRefresh: false });
    expect(controller.getSnapshot().groups[0]).toMatchObject({ expanded: false });
  });

  test('an initial task page that takes three seconds is accepted rather than deadline-discarded', async () => {
    let time = 0;
    const api = makeApi(Array(12).fill(7));
    api.listLocalTaskGroups.mockImplementation(async options => {
      time += 3_000;
      return success(api.groupsPage(options));
    });
    const controller = await start(api, () => time);
    expect(controller.getSnapshot()).toMatchObject({ cursorValid: true, error: undefined, loading: false });
    expect(controller.getSnapshot().groups).toHaveLength(8);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(1);
  });

  test('a slow background page preserves the old snapshot, while the same manual reset succeeds', async () => {
    let time = 0;
    const api = makeApi([120, ...Array(10).fill(7)]);
    const controller = await start(api, () => time);
    await controller.expand('task-0');
    const oldItems = controller.getSnapshot().groups[0].items;
    api.listLocalTaskGroups.mockImplementation(async options => {
      time += 3_000;
      return success(api.groupsPage(options));
    });
    controller.refresh();
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ cursorValid: false, needsManualRefresh: true });
    expect(controller.getSnapshot().groups[0].items).toBe(oldItems);
    controller.refresh({ manual: true });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ cursorValid: true, needsManualRefresh: false, error: undefined });
    expect(controller.getSnapshot().groups).toHaveLength(8);
    expect(controller.getSnapshot().groups[0]).toMatchObject({ expanded: false });
    expect(controller.getSnapshot().groups[0].items).toHaveLength(3);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(3);
  });

  test('anchor recovery adds at most two task pages and does not expand hidden items', async () => {
    const api = makeApi(Array(40).fill(120));
    const controller = await start(api);
    controller.configure({ active: true, getAnchorSessionIds: () => ['task-39'] });
    controller.refresh();
    await settle();
    expect(controller.getSnapshot().groups).toHaveLength(24);
    expect(api.listLocalTaskItems).not.toHaveBeenCalled();
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(4);
  });

  test('local item errors retain displayed cards and can retry without affecting other tasks', async () => {
    const api = makeApi([120, 7]);
    const controller = await start(api);
    api.listLocalTaskItems.mockRejectedValueOnce(new Error('request failed'));
    await controller.expand('task-0');
    expect(controller.getSnapshot().groups[0]).toMatchObject({ expanded: true, loading: false, error: 'request failed' });
    expect(controller.getSnapshot().groups[1]).toMatchObject({ expanded: false, error: undefined });
    await controller.loadMoreItems('task-0');
    expect(controller.getSnapshot().groups[0].items).toHaveLength(24);
    expect(controller.getSnapshot().groups[0].error).toBeUndefined();
  });

  test('a stable bad cursor stops after one immediate retry without polling again', async () => {
    vi.useFakeTimers();
    const api = makeApi([120]);
    const controller = await start(api);
    api.listLocalTaskGroups.mockImplementation(async () => ({
      success: false, code: LibraryErrorCode.InvalidCursor, error: 'changed',
    }));
    controller.refresh();
    await settle();
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({
      cursorValid: false, needsManualRefresh: true, errorCode: LibraryErrorCode.InvalidCursor,
    });
  });

  test('genuine event storms still use one immediate retry and a one-second quiet backoff', async () => {
    vi.useFakeTimers();
    const api = makeApi([120]);
    const controller = await start(api);
    api.listLocalTaskGroups.mockImplementation(async options => {
      controller.invalidate({ reason: LibraryChangeReason.FileChanged, itemIds: ['task-0-file-0'] });
      return success(api.groupsPage(options));
    });
    controller.refresh();
    await settle();
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(5);
    api.listLocalTaskGroups.mockImplementation(async options => success(api.groupsPage(options)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(6);
    expect(controller.getSnapshot()).toMatchObject({ cursorValid: true, error: undefined });
  });

  test.each([false, true])('foreground item failure shares the retry allowance (already expanded: %s)', async expanded => {
    vi.useFakeTimers();
    const api = makeApi([120]);
    const controller = await start(api);
    if (expanded) await controller.expand('task-0');
    const before = api.listLocalTaskItems.mock.calls.length;
    api.listLocalTaskItems.mockImplementation(async () => ({
      success: false, code: LibraryErrorCode.InvalidCursor, error: 'changed',
    }));
    await controller.loadMoreItems('task-0');
    await settle();
    expect(api.listLocalTaskItems).toHaveBeenCalledTimes(before + 2);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.listLocalTaskItems).toHaveBeenCalledTimes(before + 2);
    expect(controller.getSnapshot()).toMatchObject({ cursorValid: false, needsManualRefresh: true });
    expect(controller.getSnapshot().groups[0].items).toHaveLength(expanded ? 24 : 3);
  });

  test('foreground task paging failure shares the retry allowance and preserves the old prefix', async () => {
    vi.useFakeTimers();
    const api = makeApi(Array(12).fill(1));
    const controller = await start(api);
    api.listLocalTaskGroups.mockImplementation(async () => ({
      success: false, code: LibraryErrorCode.InvalidCursor, error: 'changed',
    }));
    await controller.loadMoreTasks();
    await settle();
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.listLocalTaskGroups).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().groups).toHaveLength(8);
    expect(controller.getSnapshot()).toMatchObject({ loadingMore: false, cursorValid: false, needsManualRefresh: true });
  });

  test('cloud events are ignored and session deletion cancels its expansion', async () => {
    const api = makeApi([120, 7]);
    const controller = await start(api);
    await controller.expand('task-0');
    controller.invalidate({ reason: LibraryChangeReason.Favorite, itemKind: LibraryItemKind.SharedFile });
    expect(controller.getSnapshot().cursorValid).toBe(true);
    api.model.splice(0, 1);
    controller.invalidate({ reason: LibraryChangeReason.SessionDeleted, sessionIds: ['task-0'] });
    expect(controller.getSnapshot().groups[0].expanded).toBe(false);
    controller.refresh();
    await settle();
    expect(controller.getSnapshot().groups.map(group => group.session.sessionId)).toEqual(['task-1']);
  });

  test('missing grid bridge yields explicit protocol mismatch without any list-v2 fallback', async () => {
    const controller = new LibraryTaskGridController(() => undefined);
    controllers.push(controller);
    controller.configure({ active: true });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      errorCode: LibraryErrorCode.ProtocolMismatch, cursorValid: false, loading: false,
    });
  });

  test('new preload against an old Main maps the missing channel to protocol mismatch', async () => {
    const api = makeApi([7]);
    api.listLocalTaskGroups.mockRejectedValueOnce(new Error(
      `Error invoking remote method '${LibraryIpc.ListLocalTaskGroups}': No handler registered for '${LibraryIpc.ListLocalTaskGroups}'`,
    ));
    const controller = await start(api);
    expect(controller.getSnapshot()).toMatchObject({ errorCode: LibraryErrorCode.ProtocolMismatch, cursorValid: false });
  });

  test('collapsing while an outer task page is pending cannot resurrect its expansion', async () => {
    const api = makeApi([120, ...Array(10).fill(1)]);
    const controller = await start(api);
    await controller.expand('task-0');
    const response = deferred<LibraryResult<LibraryLocalTaskGroupsData>>();
    api.listLocalTaskGroups.mockImplementationOnce(() => response.promise);
    const pending = controller.loadMoreTasks();
    controller.collapse('task-0');
    const options = api.listLocalTaskGroups.mock.calls[1][0];
    response.resolve(success(api.groupsPage(options)));
    await pending;
    expect(controller.getSnapshot().groups[0].expanded).toBe(false);
    expect(controller.getSnapshot().loadingMore).toBe(false);
    expect(controller.getSnapshot().groups).toHaveLength(8);
    await controller.loadMoreTasks();
    expect(controller.getSnapshot().groups).toHaveLength(11);
  });

  test('query changes reset to the top and never use a previous query anchor to fetch extra tasks', async () => {
    const api = makeApi(Array(40).fill(1));
    const controller = await start(api);
    const before = vi.fn();
    controller.configure({ active: true, keyword: 'new', onBeforeLayoutChange: before,
      getAnchorSessionIds: () => ['task-39'] });
    await settle();
    expect(controller.getSnapshot().groups).toHaveLength(8);
    expect(before).toHaveBeenCalledWith(undefined, false, true);
  });

  test('only successful data commits advance the revision used by open previews', async () => {
    const api = makeApi([120]);
    const controller = await start(api);
    const initial = controller.getSnapshot().dataRevision;
    const response = deferred<LibraryResult<LibraryLocalTaskItemsData>>();
    api.listLocalTaskItems.mockImplementationOnce(() => response.promise);
    const pending = controller.expand('task-0');
    expect(controller.getSnapshot().dataRevision).toBe(initial);
    response.resolve(success(api.itemsPage({ sessionId: 'task-0', pageSize: 24 })));
    await pending;
    expect(controller.getSnapshot().dataRevision).toBe(initial + 1);
    controller.collapse('task-0');
    controller.invalidate();
    expect(controller.getSnapshot().dataRevision).toBe(initial + 1);
  });
});
