import { describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryErrorCode,
  LibraryItemKind,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibraryOrigin,
} from '../../../shared/library/constants';
import { compareLibraryLocalItems, getLibraryLocalOrderKey } from '../../../shared/library/localOrdering';
import type { LibraryLocalListData, LibraryLocalListOptions, LocalArtifactItem } from '../../../shared/library/types';
import {
  getLibraryLocalItemKey,
  LibraryWindowRefreshStatus,
  readLibraryLocalWindow,
  validateLibraryLocalAppend,
  validateLibraryLocalPage,
} from './libraryWindowRefresh';

const makeItem = (index: number, overrides: Partial<LocalArtifactItem> = {}): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId: `item-${index}`,
  title: `File ${index}.pdf`,
  category: LibraryCategory.Document,
  sortTime: 10_000 - index + 0.25,
  createdAt: 1,
  isFavorite: false,
  latestSession: {
    sessionId: 'task', title: 'Task', agentId: 'main',
    createdAt: 1.25, updatedAt: 2.5, lastRelatedAt: 1,
  },
  filePath: `/tmp/file-${index}.pdf`,
  artifactType: LibraryArtifactType.Document,
  extension: '.pdf',
  availability: LibraryAvailability.Available,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
  ...overrides,
});
const encodeCursor = (item: LocalArtifactItem): string => Buffer.from(JSON.stringify({
  version: LibraryLocalProtocol.Version, sort: LibraryLocalSort.RecentTask,
  ...getLibraryLocalOrderKey(item),
}), 'utf8').toString('base64url');
const makePage = (all: LocalArtifactItem[], start: number, count: number): LibraryLocalListData => {
  const list = all.slice(start, start + count);
  const hasMore = start + count < all.length;
  return {
    protocolVersion: LibraryLocalProtocol.Version,
    sort: LibraryLocalSort.RecentTask,
    list,
    counts: { total: all.length, available: all.length, missing: 0 },
    hasMore,
    ...(hasMore ? { nextCursor: encodeCursor(list[list.length - 1]) } : {}),
  };
};
const makeReader = (items: LocalArtifactItem[]) => {
  const calls: LibraryLocalListOptions[] = [];
  const readPage = async (options: LibraryLocalListOptions) => {
    calls.push(options);
    const afterId = options.cursor
      ? JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')).itemId
      : undefined;
    const start = afterId ? items.findIndex(item => item.itemId === afterId) + 1 : 0;
    return { success: true as const, data: makePage(items, start, options.pageSize ?? 24) };
  };
  return { calls, readPage };
};
const defaults = {
  query: { category: LibraryCategory.All, keyword: '', favoritesOnly: false },
  browseDepth: 48,
  getAnchorKeys: (): string[] => [],
  isCurrent: () => true,
  getDataEpoch: () => 1,
};

describe('local library page contracts', () => {
  test('accepts fractional timestamps and UTF-8 cursor IDs without rounding', () => {
    const first = makeItem(0, { itemId: '文件😀' });
    const second = makeItem(1);
    const page = makePage([first, second], 0, 1);
    expect(validateLibraryLocalPage(page, { pageSize: 1 }).status).toBe(LibraryWindowRefreshStatus.Success);
    expect(page.list[0].latestSession.updatedAt).toBe(2.5);
  });

  test('rejects old protocol or missing task timestamps as a version mismatch', () => {
    const page = makePage([makeItem(0)], 0, 24);
    for (const broken of [
      { ...page, protocolVersion: undefined },
      { ...page, sort: 'recently_updated' },
      { ...page, list: [{ ...page.list[0], latestSession: { sessionId: 'old' } }] },
    ]) {
      expect(validateLibraryLocalPage(broken)).toMatchObject({
        status: LibraryWindowRefreshStatus.Failure, code: LibraryErrorCode.ProtocolMismatch,
      });
    }
  });

  test('reports invalid timestamps, missing files, or inconsistent projections', () => {
    const all = [makeItem(0), makeItem(1)];
    const page = makePage(all, 0, 24);
    for (const list of [
      [{ ...all[0], sortTime: Number.POSITIVE_INFINITY }],
      [{ ...all[0], availability: LibraryAvailability.Missing }],
      [all[0], { ...all[1], latestSession: { ...all[1].latestSession, title: 'Changed' } }],
    ]) {
      expect(validateLibraryLocalPage({ ...page, list })).toMatchObject({
        status: LibraryWindowRefreshStatus.Failure, code: LibraryErrorCode.InvalidLocalData,
      });
    }
  });

  test('rejects page duplicates and descending-key violations', () => {
    const all = [makeItem(0), makeItem(1)];
    for (const list of [[all[0], all[0]], [...all].reverse()]) {
      expect(validateLibraryLocalPage({ ...makePage(all, 0, 24), list }).status)
        .toBe(LibraryWindowRefreshStatus.Failure);
    }
  });

  test('requires a progressing cursor identifying the exact page tail', () => {
    const all = [makeItem(0), makeItem(1)];
    const page = makePage(all, 0, 1);
    for (const nextCursor of [undefined, '', 'not-a-cursor', encodeCursor(all[1])]) {
      expect(validateLibraryLocalPage({ ...page, nextCursor }).status).toBe(LibraryWindowRefreshStatus.Failure);
    }
    expect(validateLibraryLocalPage(page, { requestCursor: page.nextCursor }).status)
      .toBe(LibraryWindowRefreshStatus.Failure);
  });

  test('invalidates cross-page duplicates, order, counts, or task projection drift', () => {
    const all = Array.from({ length: 4 }, (_, index) => makeItem(index));
    const current = makePage(all, 0, 2);
    const next = makePage(all, 2, 2);
    const variants = [
      { ...next, list: [all[1], all[3]] },
      { ...next, list: [makeItem(-1), all[3]] },
      { ...next, counts: { ...next.counts, missing: 1 } },
      { ...next, list: next.list.map(item => ({
        ...item, latestSession: { ...item.latestSession, updatedAt: 2.25 },
      })) },
    ];
    for (const page of variants) {
      expect(validateLibraryLocalAppend(current, page).status).toBe(LibraryWindowRefreshStatus.Invalidated);
    }
  });
});

describe('continuous-prefix local library window refresh', () => {
  test('recovers an anchor pushed from position 36 to 156 through at most two extra pages', async () => {
    const all = Array.from({ length: 168 }, (_, index) => makeItem(index));
    const reader = makeReader(all);
    const result = await readLibraryLocalWindow({
      ...defaults, ...reader, getAnchorKeys: () => [getLibraryLocalItemKey(all[155])],
    });
    expect(result.status).toBe(LibraryWindowRefreshStatus.Success);
    if (result.status !== LibraryWindowRefreshStatus.Success) return;
    expect(result.anchorKey).toBe(getLibraryLocalItemKey(all[155]));
    expect(result.anchorDegraded).toBe(false);
    expect(result.data.list).toEqual(all);
    expect(reader.calls.map(call => call.pageSize)).toEqual([48, 100, 100]);
    expect(reader.calls[0].sort).toBeUndefined();
    expect(reader.calls[1].sort).toBe(LibraryLocalSort.RecentTask);
  });

  test('bounds a 1,000-file task move at N + 200 and returns the actual prefix cursor', async () => {
    const all = Array.from({ length: 1_048 }, (_, index) => makeItem(index));
    const reader = makeReader(all);
    const result = await readLibraryLocalWindow({
      ...defaults, ...reader, getAnchorKeys: () => [getLibraryLocalItemKey(all[1_035])],
    });
    expect(result.status).toBe(LibraryWindowRefreshStatus.Success);
    if (result.status !== LibraryWindowRefreshStatus.Success) return;
    expect(result.data.list).toEqual(all.slice(0, 248));
    expect(result.data.nextCursor).toBe(encodeCursor(all[247]));
    expect(result.anchorDegraded).toBe(true);
    expect(reader.calls).toHaveLength(3);
  });

  test('does not inflate the baseline on repeated automatic anchor reads', async () => {
    const all = Array.from({ length: 1_048 }, (_, index) => makeItem(index));
    for (let index = 0; index < 3; index += 1) {
      const reader = makeReader(all);
      await readLibraryLocalWindow({
        ...defaults, ...reader, getAnchorKeys: () => [getLibraryLocalItemKey(all[900])],
      });
      expect(reader.calls.map(call => call.pageSize)).toEqual([48, 100, 100]);
    }
  });

  test('does not seek anchors for users at the top', async () => {
    const reader = makeReader(Array.from({ length: 300 }, (_, index) => makeItem(index)));
    const result = await readLibraryLocalWindow({ ...defaults, ...reader });
    expect(result.status).toBe(LibraryWindowRefreshStatus.Success);
    expect(reader.calls).toHaveLength(1);
  });

  test('prefers the original file to a neighbor, then falls back if source exhausts', async () => {
    const all = Array.from({ length: 168 }, (_, index) => makeItem(index));
    const primary = getLibraryLocalItemKey(all[155]);
    const neighbor = getLibraryLocalItemKey(all[1]);
    const result = await readLibraryLocalWindow({
      ...defaults, ...makeReader(all), getAnchorKeys: () => [primary, neighbor],
    });
    expect(result).toMatchObject({ anchorKey: primary, anchorDegraded: false });
    const removed = await readLibraryLocalWindow({
      ...defaults, ...makeReader(all), getAnchorKeys: () => ['local_artifact:removed', neighbor],
    });
    expect(removed).toMatchObject({ anchorKey: neighbor, anchorDegraded: false });
  });

  test('resamples a moving user anchor without replenishing extra budget', async () => {
    const all = Array.from({ length: 500 }, (_, index) => makeItem(index));
    const reader = makeReader(all);
    let target = all[130];
    const result = await readLibraryLocalWindow({
      ...defaults,
      getAnchorKeys: () => [getLibraryLocalItemKey(target)],
      readPage: async options => {
        const response = await reader.readPage(options);
        if (reader.calls.length === 2) target = all[400];
        return response;
      },
    });
    expect(reader.calls).toHaveLength(3);
    expect(result).toMatchObject({ anchorDegraded: true });
  });

  test('discards all buffered pages immediately when an event changes the epoch', async () => {
    const reader = makeReader(Array.from({ length: 300 }, (_, index) => makeItem(index)));
    let epoch = 1;
    const result = await readLibraryLocalWindow({
      ...defaults, browseDepth: 120, getDataEpoch: () => epoch,
      readPage: async options => {
        const response = await reader.readPage(options);
        if (reader.calls.length === 2) epoch += 1;
        return response;
      },
    });
    expect(result).toEqual({ status: LibraryWindowRefreshStatus.Invalidated });
    expect(reader.calls).toHaveLength(2);
  });

  test('does not keep reading after a query changes or a view unmounts', async () => {
    const reader = makeReader(Array.from({ length: 300 }, (_, index) => makeItem(index)));
    let current = true;
    const result = await readLibraryLocalWindow({
      ...defaults, browseDepth: 120, isCurrent: () => current,
      readPage: async options => {
        current = false;
        return reader.readPage(options);
      },
    });
    expect(result.status).toBe(LibraryWindowRefreshStatus.Invalidated);
    expect(reader.calls).toHaveLength(1);
  });

  test('never commits a shortened base window when its soft budget is exhausted', async () => {
    const reader = makeReader(Array.from({ length: 300 }, (_, index) => makeItem(index)));
    let clock = 0;
    const result = await readLibraryLocalWindow({
      ...defaults, browseDepth: 120, now: () => clock,
      readPage: async options => {
        const response = await reader.readPage(options);
        clock += 2_000;
        return response;
      },
    });
    expect(result).toEqual({ status: LibraryWindowRefreshStatus.BudgetExceeded });
    expect(reader.calls).toHaveLength(1);
  });

  test('can commit a complete base window with degraded anchoring after its budget expires', async () => {
    const all = Array.from({ length: 300 }, (_, index) => makeItem(index));
    const reader = makeReader(all);
    let clock = 0;
    const result = await readLibraryLocalWindow({
      ...defaults, now: () => clock, getAnchorKeys: () => [getLibraryLocalItemKey(all[200])],
      readPage: async options => {
        const response = await reader.readPage(options);
        clock += 2_000;
        return response;
      },
    });
    expect(result).toMatchObject({ status: LibraryWindowRefreshStatus.Success, anchorDegraded: true });
    expect(reader.calls).toHaveLength(1);
  });

  test('returns an empty authoritative result without degraded-position feedback', async () => {
    const result = await readLibraryLocalWindow({
      ...defaults, ...makeReader([]), getAnchorKeys: () => ['local_artifact:gone'],
    });
    expect(result).toMatchObject({ status: LibraryWindowRefreshStatus.Success, anchorDegraded: false });
  });

  test('does not retry ordinary failures and delegates cursor retry to the coordinator', async () => {
    for (const code of [LibraryErrorCode.Internal, LibraryErrorCode.InvalidCursor]) {
      let calls = 0;
      const result = await readLibraryLocalWindow({
        ...defaults, readPage: async () => {
          calls += 1;
          return { success: false, code, error: 'Failed' };
        },
      });
      expect(calls).toBe(1);
      expect(result.status).toBe(code === LibraryErrorCode.InvalidCursor
        ? LibraryWindowRefreshStatus.Invalidated : LibraryWindowRefreshStatus.Failure);
    }
  });

  test('newer tasks outrank newer files while preserving continuous results', async () => {
    const olderFile = makeItem(1, { sortTime: 0 });
    olderFile.latestSession = { ...olderFile.latestSession, sessionId: 'newer-task', updatedAt: 3 };
    const all = [makeItem(0), olderFile].sort(compareLibraryLocalItems);
    const result = await readLibraryLocalWindow({ ...defaults, ...makeReader(all) });
    expect(result).toMatchObject({ data: { list: [olderFile, makeItem(0)] } });
  });
});
