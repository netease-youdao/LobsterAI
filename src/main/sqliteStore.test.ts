/**
 * Unit tests for the atomic write pattern in SqliteStore.save().
 *
 * The save logic is mirrored inline because SqliteStore.create() depends on
 * Electron's `app` module which is unavailable in Vitest.
 */
import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import initSqlJs, { Database } from 'sql.js';

// ---------------------------------------------------------------------------
// Mirror of SqliteStore.save() — must stay in sync with sqliteStore.ts
// ---------------------------------------------------------------------------

function atomicSave(db: Database, dbPath: string): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, dbPath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitestore-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makeDb(): Promise<Database> {
  const SQL = await initSqlJs();
  return new SQL.Database();
}

function dbPath(): string {
  return path.join(tmpDir, 'test.sqlite');
}

// ---------------------------------------------------------------------------
// Basic save behavior
// ---------------------------------------------------------------------------

describe('atomicSave', () => {
  test('writes a new database file that can be read back', async () => {
    const db = await makeDb();
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    db.run("INSERT INTO t VALUES (1, 'hello')");

    const target = dbPath();
    atomicSave(db, target);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);

    const SQL = await initSqlJs();
    const loaded = new SQL.Database(fs.readFileSync(target));
    const rows = loaded.exec('SELECT val FROM t WHERE id = 1');
    expect(rows[0].values[0][0]).toBe('hello');
    loaded.close();
    db.close();
  });

  test('overwrites an existing file atomically', async () => {
    const db = await makeDb();
    const target = dbPath();

    db.run('CREATE TABLE t (v INTEGER)');
    db.run('INSERT INTO t VALUES (1)');
    atomicSave(db, target);

    db.run('INSERT INTO t VALUES (2)');
    atomicSave(db, target);

    expect(fs.existsSync(`${target}.tmp`)).toBe(false);

    const SQL = await initSqlJs();
    const loaded = new SQL.Database(fs.readFileSync(target));
    const rows = loaded.exec('SELECT v FROM t ORDER BY v');
    expect(rows[0].values).toEqual([[1], [2]]);
    loaded.close();
    db.close();
  });

  test('no leftover .tmp file after successful save', async () => {
    const db = await makeDb();
    const target = dbPath();

    for (let i = 0; i < 5; i++) {
      atomicSave(db, target);
    }

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Crash resistance — writeFileSync failure
// ---------------------------------------------------------------------------

describe('crash resistance: write failure', () => {
  test('original file untouched when writeFileSync throws', async () => {
    const db = await makeDb();
    const target = dbPath();

    db.run('CREATE TABLE t (v TEXT)');
    db.run("INSERT INTO t VALUES ('original')");
    atomicSave(db, target);

    const originalContent = fs.readFileSync(target);

    db.run("INSERT INTO t VALUES ('should-not-persist')");

    const realWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
      const filePath = args[0] as string;
      if (typeof filePath === 'string' && filePath.endsWith('.tmp')) {
        throw new Error('Simulated disk full');
      }
      return realWriteFileSync.apply(fs, args as Parameters<typeof realWriteFileSync>);
    });

    expect(() => atomicSave(db, target)).toThrow('Simulated disk full');

    vi.restoreAllMocks();

    const afterContent = fs.readFileSync(target);
    expect(Buffer.compare(originalContent, afterContent)).toBe(0);

    const SQL = await initSqlJs();
    const loaded = new SQL.Database(afterContent);
    const rows = loaded.exec('SELECT v FROM t');
    expect(rows[0].values).toEqual([['original']]);
    loaded.close();
    db.close();
  });

  test('no .tmp file left behind when writeFileSync throws', async () => {
    const db = await makeDb();
    const target = dbPath();

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('Simulated I/O error');
    });

    expect(() => atomicSave(db, target)).toThrow('Simulated I/O error');

    vi.restoreAllMocks();

    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Crash resistance — renameSync failure
// ---------------------------------------------------------------------------

describe('crash resistance: rename failure', () => {
  test('original file untouched when renameSync throws', async () => {
    const db = await makeDb();
    const target = dbPath();

    db.run('CREATE TABLE t (v TEXT)');
    db.run("INSERT INTO t VALUES ('safe')");
    atomicSave(db, target);

    const originalContent = fs.readFileSync(target);

    db.run("INSERT INTO t VALUES ('risky')");

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('Simulated rename failure');
    });

    expect(() => atomicSave(db, target)).toThrow('Simulated rename failure');

    vi.restoreAllMocks();

    const afterContent = fs.readFileSync(target);
    expect(Buffer.compare(originalContent, afterContent)).toBe(0);

    const SQL = await initSqlJs();
    const loaded = new SQL.Database(afterContent);
    const rows = loaded.exec('SELECT v FROM t');
    expect(rows[0].values).toEqual([['safe']]);
    loaded.close();
    db.close();
  });

  test('.tmp file exists as recovery artifact when rename fails', async () => {
    const db = await makeDb();
    const target = dbPath();

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('Simulated rename failure');
    });

    db.run('CREATE TABLE t (v INTEGER)');
    db.run('INSERT INTO t VALUES (42)');

    expect(() => atomicSave(db, target)).toThrow('Simulated rename failure');

    vi.restoreAllMocks();

    expect(fs.existsSync(`${target}.tmp`)).toBe(true);

    const SQL = await initSqlJs();
    const recovered = new SQL.Database(fs.readFileSync(`${target}.tmp`));
    const rows = recovered.exec('SELECT v FROM t');
    expect(rows[0].values).toEqual([[42]]);
    recovered.close();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Data integrity across multiple save cycles
// ---------------------------------------------------------------------------

describe('data integrity', () => {
  test('100 sequential saves produce correct final state', async () => {
    const db = await makeDb();
    const target = dbPath();

    db.run('CREATE TABLE counter (n INTEGER)');
    db.run('INSERT INTO counter VALUES (0)');

    for (let i = 1; i <= 100; i++) {
      db.run('UPDATE counter SET n = ?', [i]);
      atomicSave(db, target);
    }

    const SQL = await initSqlJs();
    const loaded = new SQL.Database(fs.readFileSync(target));
    const rows = loaded.exec('SELECT n FROM counter');
    expect(rows[0].values[0][0]).toBe(100);
    loaded.close();
    db.close();
  });

  test('file size matches exported buffer size', async () => {
    const db = await makeDb();
    const target = dbPath();

    db.run('CREATE TABLE data (payload TEXT)');
    db.run("INSERT INTO data VALUES (?)", ['x'.repeat(10000)]);
    atomicSave(db, target);

    const exported = Buffer.from(db.export());
    const fileSize = fs.statSync(target).size;
    expect(fileSize).toBe(exported.length);
    db.close();
  });
});
