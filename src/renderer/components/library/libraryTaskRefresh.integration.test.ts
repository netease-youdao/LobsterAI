import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { decodeLibraryLocalCursor, LibraryLocalStore } from '../../../main/library/libraryLocalStore';
import { initializeLibraryTables } from '../../../main/library/libraryMigrations';
import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryChangeReason,
  LibraryLocalSort,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../../shared/library/constants';
import type { LibraryLocalListData, LibraryLocalListOptions, LocalArtifactItem } from '../../../shared/library/types';
import { LibraryRefreshCoordinator, LibraryRefreshOutcome } from './libraryRefreshCoordinator';
import {
  getLibraryLocalItemKey,
  LibraryWindowRefreshStatus,
  readLibraryLocalWindow,
  validateLibraryLocalAppend,
  validateLibraryLocalPage,
} from './libraryWindowRefresh';

const query = { category: LibraryCategory.All, keyword: '', favoritesOnly: false };

describe('task-first Main/Renderer refresh integration', () => {
  let db: Database.Database;
  let store: LibraryLocalStore;
  let coordinator: LibraryRefreshCoordinator | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    initializeLibraryTables(db);
    store = new LibraryLocalStore(db);
  });

  afterEach(() => {
    coordinator?.dispose();
    coordinator = undefined;
    db.close();
    vi.useRealTimers();
  });

  const addTask = (id: string, updatedAt: number, createdAt = 0.25): void => {
    db.prepare(`
      INSERT INTO cowork_sessions (id, title, cwd, agent_id, created_at, updated_at)
      VALUES (?, ?, '/integration', 'main', ?, ?)
    `).run(id, `Task ${id}`, createdAt, updatedAt);
  };

  const addFile = (taskId: string, name: string, fileTime: number, relatedAt = 10.25): LocalArtifactItem => {
    const filePath = `/integration/${name}.pdf`;
    const item = store.upsertFile({
      pathKey: filePath,
      filePath,
      fileName: `${name}.pdf`,
      extension: '.pdf',
      artifactType: LibraryArtifactType.Document,
      category: LibraryCategory.Document,
      fileMtimeMs: fileTime,
      availability: LibraryAvailability.Available,
      origin: LibraryOrigin.Conversation,
      verifiedAt: 10,
    }, {
      sessionId: taskId,
      filePath,
      detectedType: LibraryArtifactType.Document,
      relationKind: LibraryRelationKind.Created,
      relatedAt,
    });
    if (!item?.latestSession) throw new Error('Expected a visible task-linked artifact.');
    return item as LocalArtifactItem;
  };

  const populateLargeTaskMove = (): void => {
    addTask('A', 3.5);
    addTask('B', 2.5);
    addTask('C', 1.5);
    db.transaction(() => {
      for (let index = 0; index < 24; index += 1) {
        addFile('A', `a-${index}`, 1_000 - index + 0.75);
        addFile('B', `b-${index}`, 1_000 - index + 0.5);
      }
      for (let index = 0; index < 120; index += 1) {
        addFile('C', `c-${index}`, 200 - index + 0.25);
      }
    })();
  };

  test('accepts real Main pages and restores a file displaced by a 120-artifact task', async () => {
    populateLargeTaskMove();
    const before = store.list({ pageSize: 48 });
    expect(validateLibraryLocalPage(before, { pageSize: 48 }).status).toBe(LibraryWindowRefreshStatus.Success);
    const anchor = before.list[35];
    expect(anchor.latestSession.sessionId).toBe('B');
    db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(4.75, 'C');

    const calls: LibraryLocalListOptions[] = [];
    const result = await readLibraryLocalWindow({
      query,
      browseDepth: 48,
      getAnchorKeys: () => [getLibraryLocalItemKey(anchor)],
      isCurrent: () => true,
      getDataEpoch: () => 1,
      readPage: async options => {
        calls.push(options);
        return { success: true, data: store.list(options) };
      },
    });

    expect(result.status).toBe(LibraryWindowRefreshStatus.Success);
    if (result.status !== LibraryWindowRefreshStatus.Success) return;
    expect(result.anchorKey).toBe(getLibraryLocalItemKey(anchor));
    expect(result.anchorDegraded).toBe(false);
    expect(result.data.list).toHaveLength(168);
    expect(result.data.list.findIndex(item => item.itemId === anchor.itemId)).toBe(155);
    expect(new Set(result.data.list.slice(0, 120).map(item => item.latestSession.sessionId))).toEqual(new Set(['C']));
    expect(result.data.list[0].sortTime).toBeLessThan(result.data.list[120].sortTime);
    expect(calls.map(call => call.pageSize)).toEqual([48, 100, 100]);
    expect(calls[0].sort).toBeUndefined();
    expect(calls[1].sort).toBe(LibraryLocalSort.RecentTask);
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextCursor).toBeUndefined();
    expect(result.data.counts).toEqual({ total: 168, available: 168, missing: 0 });
  });

  test('round-trips fractional task times and reassigns owner on an equal-relation-time tie', async () => {
    addTask('older', 2.5, 1.25);
    addTask('newer', 3.75, 1.5);
    const linked = addFile('older', 'shared', 100.5, 20.25);
    addFile('newer', 'shared', 100.5, 20.25);
    addFile('older', 'remaining', 200.75, 20.25);
    expect(store.getDetail(linked.itemId)?.item.latestSession.sessionId).toBe('newer');

    db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(4.5, 'older');
    const first = store.list({ pageSize: 1 });
    expect(validateLibraryLocalPage(first, { pageSize: 1 }).status).toBe(LibraryWindowRefreshStatus.Success);
    expect(decodeLibraryLocalCursor(first.nextCursor)).toMatchObject({
      sessionUpdatedAt: 4.5,
      sessionCreatedAt: 1.25,
      artifactSortTime: 200.75,
    });
    const second = store.list({ pageSize: 1, cursor: first.nextCursor, sort: LibraryLocalSort.RecentTask });
    expect(validateLibraryLocalAppend(first, second, { pageSize: 1 }).status).toBe(LibraryWindowRefreshStatus.Success);
    expect(second.list[0].itemId).toBe(linked.itemId);
    expect(second.list[0].latestSession).toMatchObject({
      sessionId: 'older', updatedAt: 4.5, createdAt: 1.25, lastRelatedAt: 20.25,
    });
    expect(store.getDetail(linked.itemId)?.item.latestSession).toEqual(second.list[0].latestSession);
    expect(db.prepare('SELECT typeof(updated_at) AS storage FROM cowork_sessions WHERE id = ?').get('older'))
      .toEqual({ storage: 'real' });
  });

  test('an event between real SQLite pages discards the candidate and commits only its one trailing retry', async () => {
    populateLargeTaskMove();
    vi.useFakeTimers();
    let epoch = 0;
    let pageReads = 0;
    const outcomes: string[] = [];
    const commits: LibraryLocalListData[] = [];
    const retryAvailability: boolean[] = [];
    coordinator = new LibraryRefreshCoordinator({
      onInvalidate: () => { epoch += 1; },
      onFlush: async batch => {
        retryAvailability.push(batch.immediateRetryAvailable);
        const result = await readLibraryLocalWindow({
          query,
          browseDepth: 120,
          getAnchorKeys: () => [],
          isCurrent: () => true,
          getDataEpoch: () => epoch,
          readPage: async options => {
            const data = store.list(options);
            pageReads += 1;
            if (pageReads === 2) {
              db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(5.25, 'B');
              coordinator?.enqueue({ reason: LibraryChangeReason.SessionProjectionChanged, sessionIds: ['B'] });
            }
            return { success: true, data };
          },
        });
        outcomes.push(result.status);
        if (result.status === LibraryWindowRefreshStatus.Success) {
          commits.push(result.data);
          return LibraryRefreshOutcome.Committed;
        }
        return result.status === LibraryWindowRefreshStatus.Invalidated
          ? LibraryRefreshOutcome.Invalidated : LibraryRefreshOutcome.Stopped;
      },
    });
    coordinator.setActive(true);
    db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(4.75, 'C');
    coordinator.enqueue({ reason: LibraryChangeReason.SessionProjectionChanged, sessionIds: ['C'] });
    await vi.advanceTimersByTimeAsync(300);

    expect(outcomes).toEqual([LibraryWindowRefreshStatus.Invalidated, LibraryWindowRefreshStatus.Success]);
    expect(retryAvailability).toEqual([true, false]);
    expect(pageReads).toBe(4);
    expect(commits).toHaveLength(1);
    expect(commits[0].list).toHaveLength(120);
    expect(commits[0].list[0].latestSession.sessionId).toBe('B');
    expect(commits[0].list[0].latestSession.updatedAt).toBe(5.25);
    const tailPage = store.list({ cursor: commits[0].nextCursor, pageSize: 100, sort: LibraryLocalSort.RecentTask });
    expect(validateLibraryLocalAppend(commits[0], tailPage, { pageSize: 100 }).status)
      .toBe(LibraryWindowRefreshStatus.Success);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pageReads).toBe(4);
  });
});
