import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { DB_FILENAME } from '../../appConstants';
import { SqliteBackupTrigger } from './constants';
import {
  formatTimestampForLocalPath,
  openSqliteDatabaseWithRecovery,
  SqliteBackupManager,
} from './sqliteBackupManager';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-sqlite-recovery-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test('verifyDatabaseHealth returns ok for a valid database', () => {
  const userDataPath = makeTempDir();
  const dbPath = path.join(userDataPath, 'demo.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');

  const manager = new SqliteBackupManager(userDataPath);
  expect(manager.verifyDatabaseHealth(db)).toEqual({ ok: true });
  db.close();
});

test('restoreLatestBackup replaces broken database with newest valid snapshot', async () => {
  const userDataPath = makeTempDir();
  const dbPath = path.join(userDataPath, 'demo.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO demo (value) VALUES (?)').run('first');

  const manager = new SqliteBackupManager(userDataPath);
  await manager.createBackup({ db, trigger: SqliteBackupTrigger.Manual });
  db.close();

  fs.writeFileSync(dbPath, 'not-a-sqlite-db', 'utf8');
  fs.writeFileSync(`${dbPath}-wal`, 'wal', 'utf8');
  fs.writeFileSync(`${dbPath}-shm`, 'shm', 'utf8');

  const restoreStamp = new Date(2026, 3, 20, 13, 14, 15, 16).getTime();
  const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(restoreStamp);

  try {
    const result = manager.restoreLatestBackup(dbPath);
    expect(result.restored).toBe(true);

    const restoredDb = new Database(dbPath, { readonly: true });
    expect(restoredDb.prepare('SELECT value FROM demo WHERE id = 1').get()).toEqual({ value: 'first' });
    restoredDb.close();

    const quarantineEntries = fs.readdirSync(manager.getPaths().quarantineDir);
    expect(quarantineEntries).toEqual([formatTimestampForLocalPath(restoreStamp)]);
    const quarantineDir = path.join(manager.getPaths().quarantineDir, quarantineEntries[0]);
    expect(fs.existsSync(path.join(quarantineDir, 'demo.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(quarantineDir, 'demo.sqlite-wal'))).toBe(true);
    expect(fs.existsSync(path.join(quarantineDir, 'demo.sqlite-shm'))).toBe(true);
  } finally {
    dateNowSpy.mockRestore();
  }
});

test('openSqliteDatabaseWithRecovery restores the latest snapshot before startup pragmas run', async () => {
  const userDataPath = makeTempDir();
  const dbPath = path.join(userDataPath, DB_FILENAME);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO demo (value) VALUES (?)').run('restored');

  const manager = new SqliteBackupManager(userDataPath);
  await manager.createBackup({ db, trigger: SqliteBackupTrigger.Manual });
  db.close();

  fs.writeFileSync(dbPath, 'not-a-sqlite-db', 'utf8');

  const restoredDb = openSqliteDatabaseWithRecovery(userDataPath, dbPath);
  expect(restoredDb.prepare('SELECT value FROM demo WHERE id = 1').get()).toEqual({ value: 'restored' });
  restoredDb.close();
});

test('restoreLatestBackup falls back to the previous backup file when publish was interrupted', async () => {
  const userDataPath = makeTempDir();
  const dbPath = path.join(userDataPath, 'demo.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO demo (value) VALUES (?)').run('first');

  const manager = new SqliteBackupManager(userDataPath);
  const record = await manager.createBackup({ db, trigger: SqliteBackupTrigger.Manual });
  db.close();

  const backupPath = path.join(manager.getPaths().snapshotsDir, record.fileName);
  const previousBackupPath = `${backupPath}.previous`;
  fs.renameSync(backupPath, previousBackupPath);

  fs.writeFileSync(dbPath, 'not-a-sqlite-db', 'utf8');

  const result = manager.restoreLatestBackup(dbPath);
  expect(result.restored).toBe(true);

  const restoredDb = new Database(dbPath, { readonly: true });
  expect(restoredDb.prepare('SELECT value FROM demo WHERE id = 1').get()).toEqual({ value: 'first' });
  restoredDb.close();
});
