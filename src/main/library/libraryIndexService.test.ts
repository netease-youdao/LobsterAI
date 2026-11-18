import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryLimits,
  LibraryOrigin,
} from '../../shared/library/constants';
import { LibraryIndexService } from './libraryIndexService';
import { LibraryLocalStore } from './libraryLocalStore';
import { initializeLibraryTables } from './libraryMigrations';

describe('LibraryIndexService', () => {
  let db: Database.Database;
  let store: LibraryLocalStore;
  let tempDir: string;
  let service: LibraryIndexService | null;

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
    tempDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'library-index-'));
    service = null;
  });

  afterEach(() => {
    service?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const startService = (): LibraryIndexService => {
    service = new LibraryIndexService({
      store,
      userDataPath: path.join(tempDir, 'user-data'),
      onChanged: vi.fn(),
      getMetadata: () => undefined,
      setMetadata: () => undefined,
    });
    service.start();
    return service;
  };

  const trackFile = (filePath: string, missingSince?: number): string => {
    const item = store.upsertFile({
      pathKey: filePath,
      filePath,
      fileName: path.basename(filePath),
      extension: '.html',
      artifactType: LibraryArtifactType.Html,
      category: LibraryCategory.Web,
      availability: LibraryAvailability.Available,
      origin: LibraryOrigin.Manual,
      verifiedAt: Date.now(),
    });
    if (missingSince !== undefined) store.markMissing(item.itemId, missingSince);
    return item.itemId;
  };

  test('tries a missing directory once per rebuild without warning for each item', () => {
    const presentDir = path.join(tempDir, 'present');
    const deletedDir = path.join(tempDir, 'deleted-project');
    fs.mkdirSync(presentDir);
    trackFile(path.join(presentDir, 'kept.html'));
    trackFile(path.join(deletedDir, 'report.html'));
    trackFile(path.join(deletedDir, 'chart.html'), Date.now() - 60_000);
    trackFile(path.join(deletedDir, 'slides.html'), Date.now() - 60_000);
    const watch = vi.spyOn(fs, 'watch');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    const status = startService().getStatus();

    expect(watch.mock.calls.filter(([directory]) => directory === deletedDir)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Skipped watching 1 missing artifact dir(s)'),
    );
    expect(debug.mock.calls[0][0]).not.toContain(tempDir);
    expect(status).toMatchObject({ trackedCount: 4, watchedDirectoryCount: 1, watcherDegraded: false });
  });

  test('watches a previously missing directory once it exists again', async () => {
    const projectDir = path.join(tempDir, 'project');
    trackFile(path.join(projectDir, 'old.html'), Date.now() - 60_000);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const running = startService();
    expect(running.getStatus().watchedDirectoryCount).toBe(0);

    fs.mkdirSync(projectDir);
    const recreatedFile = path.join(projectDir, 'new.html');
    fs.writeFileSync(recreatedFile, '<html></html>');
    await running.addLocalFiles([recreatedFile]);

    expect(running.getStatus()).toMatchObject({ watchedDirectoryCount: 1, watcherDegraded: false });
  });

  test('purges items missing past the retention period before rebuilding watchers', () => {
    const now = Date.now();
    const expiredDir = path.join(tempDir, 'expired-project');
    const expiredIds = ['a.html', 'b.html'].map(name => trackFile(
      path.join(expiredDir, name),
      now - LibraryLimits.MissingRetentionMs - 60_000,
    ));
    const recentId = trackFile(path.join(tempDir, 'recent-project', 'c.html'), now - 60_000);
    const watch = vi.spyOn(fs, 'watch');
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    const status = startService().getStatus();

    for (const itemId of expiredIds) expect(store.getItem(itemId)).toBeNull();
    expect(store.getItem(recentId)).toMatchObject({ availability: LibraryAvailability.Missing });
    expect(watch.mock.calls.map(([directory]) => directory)).not.toContain(expiredDir);
    expect(status).toMatchObject({ trackedCount: 1, missingCount: 1 });
  });

  test('purges items that expire while running and releases their directory watcher', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const startedAt = Date.now();
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir);
    const itemId = trackFile(
      path.join(projectDir, 'deleted.html'),
      startedAt - LibraryLimits.MissingRetentionMs + 60_000,
    );
    // Recently verified items stay out of the reconcile batch, so the tick does no file I/O.
    db.prepare('UPDATE library_local_artifacts SET last_verified_at = ?').run(startedAt);
    const close = vi.fn();
    vi.spyOn(fs, 'watch').mockReturnValue({ on: vi.fn(), close } as unknown as fs.FSWatcher);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    const running = startService();
    expect(running.getStatus()).toMatchObject({ trackedCount: 1, watchedDirectoryCount: 1 });

    vi.setSystemTime(startedAt + 2 * 60_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(store.getItem(itemId)).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    expect(running.getStatus()).toMatchObject({ trackedCount: 0, watchedDirectoryCount: 0 });
  });

  test.each(['EACCES', 'EPERM', 'EMFILE'])('still warns once per directory when watching fails with %s', (code) => {
    const restrictedDir = path.join(tempDir, 'restricted');
    trackFile(path.join(restrictedDir, 'a.html'));
    trackFile(path.join(restrictedDir, 'b.html'));
    const watch = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw Object.assign(new Error(`${code}: watch '${restrictedDir}'`), { code });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const status = startService().getStatus();

    expect(watch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[Library] Unable to watch an indexed artifact directory.',
      expect.objectContaining({ message: `Directory watcher setup failed (${code})` }),
    );
    expect(status.watcherDegraded).toBe(true);
  });
});
