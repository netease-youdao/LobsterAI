import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { AgentId } from '../../shared/agent/constants';
import {
  CoworkMemoryStatus,
  CoworkMemoryStatusFilter,
} from '../../shared/cowork/constants';
import {
  LobsterMemoryService,
  memoryFingerprint,
  WorkspaceFileName,
} from './lobsterMemoryService';
import {
  createManagedMemoryEntry,
  deleteManagedMemoryEntries,
  deleteManagedMemoryEntry,
  getManagedMemoryStats,
  LEGACY_MEMORY_ID_PREFIX,
  listManagedMemoryEntries,
  readManagedMemoryRaw,
  updateManagedMemoryEntry,
  writeManagedMemoryRaw,
} from './memoryManagementService';

const tempDirs: string[] = [];
const services: LobsterMemoryService[] = [];
const dbs: Database.Database[] = [];

function setupEnv(): { memoryService: LobsterMemoryService; db: Database.Database } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-mem-mgmt-'));
  tempDirs.push(dir);
  const memoryService = new LobsterMemoryService(path.join(dir, 'workspaces'));
  services.push(memoryService);

  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE user_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.75,
      is_explicit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE user_memory_sources (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      role TEXT NOT NULL DEFAULT 'system',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  return { memoryService, db };
}

afterEach(() => {
  while (services.length > 0) services.pop()?.close();
  while (dbs.length > 0) dbs.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('memoryManagementService', () => {
  test('enriches active MEMORY.md entries with SQLite provenance and supports text, section, and source search', () => {
    const { memoryService, db } = setupEnv();

    memoryService.addMemory(AgentId.Main, 'Prefers dark mode in IDE', 'Preferences');
    memoryService.addMemory(AgentId.Main, 'Deploy pipeline runs on GitHub Actions', 'DevOps');

    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('sess-design', 'UI 风格偏好讨论');
    const prefText = 'Prefers dark mode in IDE';
    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'um-1',
      prefText,
      memoryFingerprint(prefText),
      0.92,
      0,
      CoworkMemoryStatus.Created,
      1000,
      2000,
      3000,
    );
    db.prepare('INSERT INTO user_memory_sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'src-1',
      'um-1',
      'sess-design',
      'msg-42',
      'user',
      1,
      1500,
    );
    db.prepare('INSERT INTO user_memory_sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'src-2',
      'um-1',
      'sess-design',
      'msg-43',
      'assistant',
      1,
      1600,
    );

    const all = listManagedMemoryEntries(memoryService, db);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      text: prefText,
      section: 'Preferences',
      status: CoworkMemoryStatus.Created,
      confidence: 0.92,
      isExplicit: false,
      createdAt: 1000,
      updatedAt: 2000,
      lastUsedAt: 3000,
      sourceCount: 2,
      sourceLabel: 'UI 风格偏好讨论',
    });
    expect(all[0].sources?.roles).toEqual(['assistant', 'user']);

    // Search by entry text
    expect(listManagedMemoryEntries(memoryService, db, { query: 'GitHub Actions' })).toHaveLength(1);
    // Search by section name
    const bySection = listManagedMemoryEntries(memoryService, db, { query: 'devops' });
    expect(bySection).toHaveLength(1);
    expect(bySection[0].text).toContain('GitHub Actions');
    // Search by source session title
    const bySourceTitle = listManagedMemoryEntries(memoryService, db, { query: '风格偏好' });
    expect(bySourceTitle).toHaveLength(1);
    expect(bySourceTitle[0].text).toBe(prefText);
    // Search by source session ID and role
    expect(listManagedMemoryEntries(memoryService, db, { query: 'sess-design' })).toHaveLength(1);
    expect(listManagedMemoryEntries(memoryService, db, { query: 'assistant' })).toHaveLength(1);
  });

  test('exposes deleted and stale legacy entries with provenance, filters by status/includeDeleted, and paginates', () => {
    const { memoryService, db } = setupEnv();

    memoryService.addMemory(AgentId.Main, 'Active memory 1');
    memoryService.addMemory(AgentId.Main, 'Active memory 2');

    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('sess-old', '旧对话记录');
    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'um-stale',
      'Stale implicit fact',
      memoryFingerprint('Stale implicit fact'),
      0.65,
      0,
      CoworkMemoryStatus.Stale,
      100,
      200,
    );
    db.prepare('INSERT INTO user_memory_sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'src-stale',
      'um-stale',
      'sess-old',
      'msg-s',
      'assistant',
      0,
      100,
    );
    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'um-del',
      'Deleted legacy fact',
      memoryFingerprint('Deleted legacy fact'),
      0.88,
      1,
      CoworkMemoryStatus.Deleted,
      110,
      210,
    );
    db.prepare('INSERT INTO user_memory_sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'src-del',
      'um-del',
      'sess-old',
      'msg-d',
      'user',
      0,
      110,
    );

    // Default (status='all', includeDeleted=false) returns only active entries
    expect(listManagedMemoryEntries(memoryService, db)).toHaveLength(2);

    // status='deleted' returns only legacy deleted entry with read-only flag & provenance
    const deletedOnly = listManagedMemoryEntries(memoryService, db, {
      status: CoworkMemoryStatusFilter.Deleted,
    });
    expect(deletedOnly).toHaveLength(1);
    expect(deletedOnly[0]).toMatchObject({
      id: `${LEGACY_MEMORY_ID_PREFIX}um-del`,
      text: 'Deleted legacy fact',
      status: CoworkMemoryStatus.Deleted,
      isLegacyReadOnly: true,
      sourceCount: 1,
      sourceLabel: '旧对话记录',
    });

    // status='stale' returns only legacy stale entry
    const staleOnly = listManagedMemoryEntries(memoryService, db, {
      status: CoworkMemoryStatusFilter.Stale,
    });
    expect(staleOnly).toHaveLength(1);
    expect(staleOnly[0]).toMatchObject({
      id: `${LEGACY_MEMORY_ID_PREFIX}um-stale`,
      status: CoworkMemoryStatus.Stale,
      isLegacyReadOnly: true,
    });

    // includeDeleted=true with status='all' returns active + stale + deleted
    const everything = listManagedMemoryEntries(memoryService, db, {
      status: CoworkMemoryStatusFilter.All,
      includeDeleted: true,
    });
    expect(everything).toHaveLength(4);

    // Pagination (offset & limit)
    const page2 = listManagedMemoryEntries(memoryService, db, {
      status: CoworkMemoryStatusFilter.All,
      includeDeleted: true,
      offset: 1,
      limit: 2,
    });
    expect(page2).toHaveLength(2);
    expect(page2.map((e) => e.text)).toEqual(['Active memory 2', 'Stale implicit fact']);

    // Stats combine active MEMORY.md + legacy SQLite stale/deleted + explicit/implicit
    const stats = getManagedMemoryStats(memoryService, db);
    expect(stats).toEqual({
      total: 4,
      created: 2,
      stale: 1,
      deleted: 1,
      explicit: 3, // 2 active (default explicit) + 1 deleted explicit
      implicit: 1, // 1 stale implicit
    });

    // Legacy read-only entries reject mutation cleanly
    expect(() =>
      updateManagedMemoryEntry(memoryService, db, { id: `${LEGACY_MEMORY_ID_PREFIX}um-del`, text: 'x' }),
    ).toThrow(/read-only/i);
    expect(() =>
      deleteManagedMemoryEntry(memoryService, db, { id: `${LEGACY_MEMORY_ID_PREFIX}um-del` }),
    ).toThrow(/read-only/i);
  });

  test('syncs edit and delete across MEMORY.md, FTS5, and SQLite user_memories/user_memory_sources', () => {
    const { memoryService, db } = setupEnv();

    const originalText = 'User works on LobsterAI desktop';
    const created = createManagedMemoryEntry(memoryService, db, { text: originalText });

    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('sess-1', '开发讨论');
    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'um-sync',
      originalText,
      memoryFingerprint(originalText),
      0.9,
      1,
      CoworkMemoryStatus.Created,
      1000,
      1000,
    );
    db.prepare('INSERT INTO user_memory_sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'src-sync',
      'um-sync',
      'sess-1',
      'msg-1',
      'user',
      1,
      1000,
    );

    // Edit updates MEMORY.md, FTS5, AND preserves SQLite provenance
    const updatedText = 'User maintains LobsterAI DSH engine';
    const updated = updateManagedMemoryEntry(memoryService, db, {
      id: created.id,
      text: updatedText,
    });
    expect(updated?.text).toBe(updatedText);
    expect(updated?.sourceLabel).toBe('开发讨论');
    expect(memoryService.search(AgentId.Main, 'LobsterAI DSH engine')).toHaveLength(1);
    expect(memoryService.search(AgentId.Main, 'LobsterAI desktop')).toHaveLength(0);

    // Delete removes from MEMORY.md + FTS5 AND marks SQLite row status='deleted' & source is_active=0
    expect(deleteManagedMemoryEntry(memoryService, db, { id: updated!.id })).toBe(true);
    expect(memoryService.listMemories(AgentId.Main)).toHaveLength(0);
    expect(memoryService.search(AgentId.Main, 'LobsterAI DSH engine')).toHaveLength(0);

    const dbRow = db
      .prepare('SELECT status FROM user_memories WHERE id = ?')
      .get('um-sync') as { status: string };
    const srcRow = db
      .prepare('SELECT is_active FROM user_memory_sources WHERE id = ?')
      .get('src-sync') as { is_active: number };
    expect(dbRow.status).toBe(CoworkMemoryStatus.Deleted);
    expect(srcRow.is_active).toBe(0);

    // Now visible under deleted filter with its provenance intact
    const deletedList = listManagedMemoryEntries(memoryService, db, {
      status: CoworkMemoryStatusFilter.Deleted,
    });
    expect(deletedList).toHaveLength(1);
    expect(deletedList[0].text).toBe(updatedText);
    expect(deletedList[0].sourceLabel).toBe('开发讨论');
  });

  test('supports multi-agent CRUD, raw read/write, and isolates expert memories from main legacy SQLite rows', () => {
    const { memoryService, db } = setupEnv();

    // Seed legacy deleted row on main
    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'um-main-del',
      'Main deleted memory',
      memoryFingerprint('Main deleted memory'),
      0.8,
      1,
      CoworkMemoryStatus.Deleted,
      100,
      100,
    );

    const expertEntry = createManagedMemoryEntry(memoryService, db, {
      agentId: 'analyst',
      text: 'Focus on quarterly YoY metrics',
      section: 'Analysis',
    });
    expect(expertEntry.agentId).toBe('analyst');

    // Main has 0 active, 1 deleted
    expect(getManagedMemoryStats(memoryService, db, { agentId: AgentId.Main })).toEqual({
      total: 1,
      created: 0,
      stale: 0,
      deleted: 1,
      explicit: 1,
      implicit: 0,
    });

    // Analyst sees ONLY its own memory and zero main legacy rows
    expect(
      listManagedMemoryEntries(memoryService, db, {
        agentId: 'analyst',
        includeDeleted: true,
      }),
    ).toHaveLength(1);
    expect(getManagedMemoryStats(memoryService, db, { agentId: 'analyst' })).toEqual({
      total: 1,
      created: 1,
      stale: 0,
      deleted: 0,
      explicit: 1,
      implicit: 0,
    });

    // Raw read/write per agentId
    expect(readManagedMemoryRaw(memoryService, { agentId: 'analyst' })).toContain('quarterly YoY metrics');
    writeManagedMemoryRaw(memoryService, {
      agentId: 'analyst',
      content: '# User Memories\n\n- Updated raw analyst rule\n',
    });
    expect(memoryService.readWorkspaceFile('analyst', WorkspaceFileName.Memory)).toContain(
      'Updated raw analyst rule',
    );
    expect(memoryService.search('analyst', 'raw analyst rule')).toHaveLength(1);
    expect(memoryService.listMemories(AgentId.Main)).toHaveLength(0);
  });

  test('deleteManagedMemoryEntries batch-deletes entries, syncs SQLite status, and exposes projectKeys in search', () => {
    const { memoryService, db } = setupEnv();

    memoryService.writeWorkspaceFile(
      AgentId.Main,
      WorkspaceFileName.Memory,
      [
        '# User Memories',
        '',
        '- Keep global fact',
        '- Repo build command <!-- project: github.com/acme/lobsterai -->',
        '- Temp promoted note',
        '',
      ].join('\n'),
    );

    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'um-temp',
      'Temp promoted note',
      memoryFingerprint('Temp promoted note'),
      0.8,
      0,
      CoworkMemoryStatus.Created,
      100,
      100,
    );

    const entries = listManagedMemoryEntries(memoryService, db, {
      status: CoworkMemoryStatusFilter.Created,
    });
    expect(entries).toHaveLength(3);
    expect(entries[1].projectKeys).toEqual(['github.com/acme/lobsterai']);

    // Search matches projectKeys as well
    expect(
      listManagedMemoryEntries(memoryService, db, {
        status: CoworkMemoryStatusFilter.Created,
        query: 'acme/lobsterai',
      }).map((e) => e.text),
    ).toEqual(['Repo build command']);

    const deletedCount = deleteManagedMemoryEntries(memoryService, db, {
      agentId: AgentId.Main,
      ids: [entries[1].id, entries[2].id],
    });
    expect(deletedCount).toBe(2);
    expect(memoryService.listMemories(AgentId.Main).map((e) => e.text)).toEqual(['Keep global fact']);

    const row = db
      .prepare('SELECT status FROM user_memories WHERE id = ?')
      .get('um-temp') as { status: string };
    expect(row.status).toBe(CoworkMemoryStatus.Deleted);
  });
});
