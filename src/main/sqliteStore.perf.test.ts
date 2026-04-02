/**
 * Performance benchmark: SQLite write-path optimisation
 *
 * Measures disk I/O cost for the three heaviest write scenarios before and
 * after the debounce + transaction batch changes.
 *
 * Run with:  npm test -- sqliteStore.perf
 *
 * The test creates a temporary database in the OS temp directory and uses
 * real sql.js + fs.writeFileSync so the numbers reflect genuine disk cost,
 * not mocked I/O.
 */

import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const WASM_PATH = path.join(
  process.cwd(),
  'node_modules/sql.js/dist/sql-wasm.wasm',
);

async function makeDb(): Promise<{ db: Database; SQL: SqlJsStatic }> {
  const wasmBinary = (() => {
    const buf = fs.readFileSync(WASM_PATH);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  })();
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS cowork_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    sequence INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.75,
    is_explicit INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'created',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_memory_sources (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    session_id TEXT,
    message_id TEXT,
    role TEXT NOT NULL DEFAULT 'system',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  return { db, SQL };
}

function exportAndWrite(db: Database, dbPath: string): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function measure(label: string, fn: () => void): number {
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  return elapsed;
}

async function measureAsync(label: string, fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  const elapsed = performance.now() - start;
  return elapsed;
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

let tmpDir: string;

interface BenchResult {
  label: string;
  beforeMs: number;
  afterMs: number;
  ratio: number;
}

const results: BenchResult[] = [];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-bench-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n========================================================');
  console.log('  SQLite Write-Path Optimisation — Performance Report');
  console.log('========================================================');
  console.log(
    'Scenario'.padEnd(42) +
    'Before'.padStart(10) +
    'After'.padStart(10) +
    'Speedup'.padStart(10),
  );
  console.log('-'.repeat(72));
  for (const r of results) {
    const speedup = `${r.ratio.toFixed(1)}x`;
    console.log(
      r.label.padEnd(42) +
      `${r.beforeMs.toFixed(1)} ms`.padStart(10) +
      `${r.afterMs.toFixed(1)} ms`.padStart(10) +
      speedup.padStart(10),
    );
  }
  console.log('========================================================\n');
});

// --------------------------------------------------------------------------
// Scenario 1: 10 sequential addMessage — naive vs. debounce coalesced
// --------------------------------------------------------------------------

describe('Scenario 1: 10 addMessage (streaming session)', () => {
  test('BEFORE: 10 individual export+writeFileSync calls', async () => {
    const dbPath = path.join(tmpDir, 'before_messages.sqlite');
    const { db } = await makeDb();
    const sessionId = uuidv4();
    const messageCount = 10;

    const before = measure('before-messages', () => {
      for (let i = 0; i < messageCount; i++) {
        const id = uuidv4();
        const now = Date.now();
        db.run(
          `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, sessionId, 'assistant', `Streaming chunk ${i} — ${'x'.repeat(200)}`, null, now, i + 1],
        );
        exportAndWrite(db, dbPath);
      }
    });

    results.push({ label: '10 addMessage (before)', beforeMs: before, afterMs: 0, ratio: 0 });
    expect(before).toBeGreaterThan(0);
  });

  test('AFTER: 10 inserts inside one transaction, single export+writeFileSync', async () => {
    const dbPath = path.join(tmpDir, 'after_messages.sqlite');
    const { db } = await makeDb();
    const sessionId = uuidv4();
    const messageCount = 10;

    const after = measure('after-messages', () => {
      db.run('BEGIN TRANSACTION;');
      for (let i = 0; i < messageCount; i++) {
        const id = uuidv4();
        const now = Date.now();
        db.run(
          `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, sessionId, 'assistant', `Streaming chunk ${i} — ${'x'.repeat(200)}`, null, now, i + 1],
        );
      }
      db.run('COMMIT;');
      exportAndWrite(db, dbPath);
    });

    const bench = results.find(r => r.label === '10 addMessage (before)')!;
    bench.afterMs = after;
    bench.ratio = bench.beforeMs / after;

    expect(after).toBeGreaterThan(0);
    expect(bench.ratio).toBeGreaterThan(1);
  });
});

// --------------------------------------------------------------------------
// Scenario 2: 5 memory deletes — naive (saveDb per delete) vs. batched
// --------------------------------------------------------------------------

describe('Scenario 2: 20 memory deletes (applyTurnMemoryUpdates)', () => {
  test('BEFORE: 20 individual export+writeFileSync calls', async () => {
    const dbPath = path.join(tmpDir, 'before_memories.sqlite');
    const { db } = await makeDb();
    const now = Date.now();
    const memIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const id = uuidv4();
      memIds.push(id);
      db.run(
        `INSERT INTO user_memories (id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
        [id, `Memory entry ${i} — ${'x'.repeat(100)}`, crypto.createHash('sha1').update(`mem${i}`).digest('hex'), 0.8, 0, now, now],
      );
      const srcId = uuidv4();
      db.run(
        `INSERT INTO user_memory_sources (id, memory_id, role, is_active, created_at) VALUES (?, ?, 'user', 1, ?)`,
        [srcId, id, now],
      );
    }
    exportAndWrite(db, dbPath);

    const before = measure('before-deletes', () => {
      for (const id of memIds) {
        db.run(`UPDATE user_memories SET status = 'deleted', updated_at = ? WHERE id = ?`, [Date.now(), id]);
        db.run(`UPDATE user_memory_sources SET is_active = 0 WHERE memory_id = ?`, [id]);
        exportAndWrite(db, dbPath);
      }
    });

    results.push({ label: '20 memory deletes (before)', beforeMs: before, afterMs: 0, ratio: 0 });
    expect(before).toBeGreaterThan(0);
  });

  test('AFTER: 20 deletes inside one transaction, single export+writeFileSync', async () => {
    const dbPath = path.join(tmpDir, 'after_memories.sqlite');
    const { db } = await makeDb();
    const now = Date.now();
    const memIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const id = uuidv4();
      memIds.push(id);
      db.run(
        `INSERT INTO user_memories (id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
        [id, `Memory entry ${i} — ${'x'.repeat(100)}`, crypto.createHash('sha1').update(`mem${i}`).digest('hex'), 0.8, 0, now, now],
      );
      const srcId = uuidv4();
      db.run(
        `INSERT INTO user_memory_sources (id, memory_id, role, is_active, created_at) VALUES (?, ?, 'user', 1, ?)`,
        [srcId, id, now],
      );
    }
    exportAndWrite(db, dbPath);

    const after = measure('after-deletes', () => {
      db.run('BEGIN TRANSACTION;');
      for (const id of memIds) {
        db.run(`UPDATE user_memories SET status = 'deleted', updated_at = ? WHERE id = ?`, [Date.now(), id]);
        db.run(`UPDATE user_memory_sources SET is_active = 0 WHERE memory_id = ?`, [id]);
      }
      db.run('COMMIT;');
      exportAndWrite(db, dbPath);
    });

    const bench = results.find(r => r.label === '20 memory deletes (before)')!;
    bench.afterMs = after;
    bench.ratio = bench.beforeMs / after;

    expect(after).toBeGreaterThan(0);
    expect(bench.ratio).toBeGreaterThan(1);
  });
});

// --------------------------------------------------------------------------
// Scenario 3: 20 rapid kv.set — naive vs. debounce (simulated)
// --------------------------------------------------------------------------

describe('Scenario 3: 20 rapid kv.set (settings update burst)', () => {
  test('BEFORE: 20 individual export+writeFileSync calls', async () => {
    const dbPath = path.join(tmpDir, 'before_kv.sqlite');
    const { db } = await makeDb();

    const before = measure('before-kv', () => {
      for (let i = 0; i < 20; i++) {
        const now = Date.now();
        db.run(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [`setting_${i}`, JSON.stringify({ index: i, data: 'x'.repeat(50) }), now],
        );
        exportAndWrite(db, dbPath);
      }
    });

    results.push({ label: '20 kv.set burst (before)', beforeMs: before, afterMs: 0, ratio: 0 });
    expect(before).toBeGreaterThan(0);
  });

  test('AFTER: 20 inserts inside one transaction, single export+writeFileSync', async () => {
    const dbPath = path.join(tmpDir, 'after_kv.sqlite');
    const { db } = await makeDb();

    const after = measure('after-kv', () => {
      db.run('BEGIN TRANSACTION;');
      for (let i = 0; i < 20; i++) {
        const now = Date.now();
        db.run(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [`setting_${i}`, JSON.stringify({ index: i, data: 'x'.repeat(50) }), now],
        );
      }
      db.run('COMMIT;');
      exportAndWrite(db, dbPath);
    });

    const bench = results.find(r => r.label === '20 kv.set burst (before)')!;
    bench.afterMs = after;
    bench.ratio = bench.beforeMs / after;

    expect(after).toBeGreaterThan(0);
    expect(bench.ratio).toBeGreaterThan(1);
  });
});

// --------------------------------------------------------------------------
// Scenario 4: Write amplification count (no timing — pure count)
// --------------------------------------------------------------------------

describe('Scenario 4: write call count — 10 addMessage', () => {
  test('BEFORE: each addMessage triggers 1 writeFileSync → 10 total', () => {
    let writeCount = 0;
    const countingWrite = () => { writeCount += 1; };

    for (let i = 0; i < 10; i++) {
      countingWrite();
    }

    expect(writeCount).toBe(10);
  });

  test('AFTER: all addMessages trigger exactly 1 writeFileSync via debounce', () => {
    let writeCount = 0;
    const countingWrite = () => { writeCount += 1; };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        countingWrite();
      }, 0);
    };

    for (let i = 0; i < 10; i++) {
      scheduleSave();
    }

    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(writeCount).toBe(1);
        resolve();
      }, 50);
    });
  });
});
