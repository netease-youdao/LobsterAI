/**
 * Unit tests for openclawMemoryFile.ts
 *
 * Tests the MEMORY.md file-based memory CRUD layer that OpenClaw's
 * memory_search/memory_get tools index automatically.
 *
 * Key behaviours under test:
 *   - parseMemoryMd: bullet-line extraction, deduplication, code-block skipping
 *   - serializeMemoryMd: canonical serialisation format
 *   - resolveMemoryFilePath: path resolution (custom dir, default fallback)
 *   - addMemoryEntry: append + duplicate guard
 *   - updateMemoryEntry: in-place update, not-found null return
 *   - deleteMemoryEntry: removal, not-found false return
 *   - searchMemoryEntries: substring filter
 *   - migrateSqliteToMemoryMd: idempotency, merge-dedup, empty source
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseMemoryMd,
  serializeMemoryMd,
  resolveMemoryFilePath,
  addMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  searchMemoryEntries,
  migrateSqliteToMemoryMd,
} = require('../dist-electron/main/libs/openclawMemoryFile.js');

// ---- helpers ----------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-memoryfile-test-'));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function memFilePath(dir) {
  return path.join(dir, 'MEMORY.md');
}

// ==================== parseMemoryMd ====================

test('parseMemoryMd: extracts top-level bullet lines', () => {
  const md = `# User Memories\n\n- I am a software engineer\n- I prefer dark mode\n`;
  const entries = parseMemoryMd(md);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, 'I am a software engineer');
  assert.equal(entries[1].text, 'I prefer dark mode');
});

test('parseMemoryMd: each entry has a stable SHA-1 id', () => {
  const md = `- Hello world\n`;
  const entries = parseMemoryMd(md);
  assert.equal(entries.length, 1);
  assert.match(entries[0].id, /^[0-9a-f]{40}$/);
});

test('parseMemoryMd: deduplications identical entries (same fingerprint)', () => {
  const md = `- same entry\n- same entry\n- same entry\n`;
  const entries = parseMemoryMd(md);
  assert.equal(entries.length, 1);
});

test('parseMemoryMd: fingerprint is case-insensitive and punctuation-agnostic', () => {
  const md = `- Hello, World!\n- hello world\n`;
  const entries = parseMemoryMd(md);
  assert.equal(entries.length, 1, 'should deduplicate case-different/punct-different entries');
});

test('parseMemoryMd: ignores non-bullet lines (headings, prose)', () => {
  const md = `# User Memories\n\nSome prose paragraph.\n\n## Section\n\n- only this is a bullet\n`;
  const entries = parseMemoryMd(md);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'only this is a bullet');
});

test('parseMemoryMd: skips bullets inside fenced code blocks', () => {
  const md = `- real entry\n\`\`\`\n- fake bullet inside code\n\`\`\`\n- another real entry\n`;
  const entries = parseMemoryMd(md);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => !e.text.includes('fake')));
});

test('parseMemoryMd: empty string returns empty array', () => {
  assert.deepEqual(parseMemoryMd(''), []);
});

test('parseMemoryMd: normalises internal whitespace in entry text', () => {
  const md = `- text  with   extra   spaces\n`;
  const entries = parseMemoryMd(md);
  assert.equal(entries[0].text, 'text with extra spaces');
});

// ==================== serializeMemoryMd ====================

test('serializeMemoryMd: produces header + bullet lines', () => {
  const entries = [
    { id: 'abc', text: 'I am an engineer' },
    { id: 'def', text: 'I prefer TypeScript' },
  ];
  const md = serializeMemoryMd(entries);
  assert.match(md, /^# User Memories\n/);
  assert.match(md, /- I am an engineer\n/);
  assert.match(md, /- I prefer TypeScript\n/);
});

test('serializeMemoryMd: empty entries produces header only', () => {
  const md = serializeMemoryMd([]);
  assert.equal(md.trim(), '# User Memories');
});

test('serializeMemoryMd: output is parseable round-trip', () => {
  const original = [
    { id: 'a1', text: 'I live in Shanghai' },
    { id: 'b2', text: 'I prefer dark mode' },
  ];
  const md = serializeMemoryMd(original);
  const parsed = parseMemoryMd(md);
  assert.equal(parsed.length, 2);
  assert.ok(parsed.some((e) => e.text === 'I live in Shanghai'));
  assert.ok(parsed.some((e) => e.text === 'I prefer dark mode'));
});

// ==================== resolveMemoryFilePath ====================

test('resolveMemoryFilePath: uses provided directory', () => {
  const p = resolveMemoryFilePath('/my/workspace');
  assert.equal(p, path.join('/my/workspace', 'MEMORY.md'));
});

test('resolveMemoryFilePath: falls back to ~/.openclaw/workspace when empty', () => {
  const p = resolveMemoryFilePath('');
  assert.match(p, /\.openclaw[/\\]workspace[/\\]MEMORY\.md$/);
});

test('resolveMemoryFilePath: falls back when undefined', () => {
  const p = resolveMemoryFilePath(undefined);
  assert.match(p, /MEMORY\.md$/);
});

// ==================== addMemoryEntry ====================

test('addMemoryEntry: adds a new entry to an empty file', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const entry = addMemoryEntry(filePath, 'I am a backend developer');
    assert.equal(entry.text, 'I am a backend developer');
    assert.match(entry.id, /^[0-9a-f]{40}$/);

    const contents = fs.readFileSync(filePath, 'utf-8');
    assert.match(contents, /- I am a backend developer/);
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: skips duplicate (same fingerprint)', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'I prefer Python');
    addMemoryEntry(filePath, 'I prefer Python');  // duplicate

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(entries.length, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: deduplication is case-insensitive', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'I love coffee');
    addMemoryEntry(filePath, 'i love coffee');  // same fingerprint

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(entries.length, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: creates parent directories if missing', () => {
  const dir = makeTmpDir();
  try {
    const deepPath = path.join(dir, 'subdir', 'nested', 'MEMORY.md');
    addMemoryEntry(deepPath, 'test entry');
    assert.ok(fs.existsSync(deepPath));
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: throws for empty text', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    assert.throws(() => addMemoryEntry(filePath, ''), /required/i);
  } finally {
    cleanupDir(dir);
  }
});

// ==================== updateMemoryEntry ====================

test('updateMemoryEntry: updates text of an existing entry', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const original = addMemoryEntry(filePath, 'I work in Beijing');
    const updated = updateMemoryEntry(filePath, original.id, 'I work in Shanghai');

    assert.notEqual(updated, null);
    assert.equal(updated.text, 'I work in Shanghai');

    const contents = fs.readFileSync(filePath, 'utf-8');
    assert.match(contents, /I work in Shanghai/);
    assert.doesNotMatch(contents, /I work in Beijing/);
  } finally {
    cleanupDir(dir);
  }
});

test('updateMemoryEntry: new id is fingerprint of new text (content-based)', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const e1 = addMemoryEntry(filePath, 'old text');
    const e2 = updateMemoryEntry(filePath, e1.id, 'new text');

    assert.notEqual(e2.id, e1.id, 'id should change when text changes');
  } finally {
    cleanupDir(dir);
  }
});

test('updateMemoryEntry: returns null for non-existent id', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'some entry');
    const result = updateMemoryEntry(filePath, 'nonexistent-id-0000', 'new text');
    assert.equal(result, null);
  } finally {
    cleanupDir(dir);
  }
});

// ==================== deleteMemoryEntry ====================

test('deleteMemoryEntry: removes an existing entry', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const e = addMemoryEntry(filePath, 'to be deleted');
    const removed = deleteMemoryEntry(filePath, e.id);
    assert.equal(removed, true);

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(entries.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test('deleteMemoryEntry: returns false for non-existent id', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'keep this');
    const result = deleteMemoryEntry(filePath, 'does-not-exist');
    assert.equal(result, false);

    // Remaining entry untouched
    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(entries.length, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('deleteMemoryEntry: preserves other entries when deleting one', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'keep entry A');
    const target = addMemoryEntry(filePath, 'delete me');
    addMemoryEntry(filePath, 'keep entry B');

    deleteMemoryEntry(filePath, target.id);

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.text === 'keep entry A'));
    assert.ok(entries.some((e) => e.text === 'keep entry B'));
  } finally {
    cleanupDir(dir);
  }
});

// ==================== searchMemoryEntries ====================

test('searchMemoryEntries: returns all entries for empty query', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'I love TypeScript');
    addMemoryEntry(filePath, 'I live in Tokyo');
    addMemoryEntry(filePath, 'I prefer vim keybindings');

    const results = searchMemoryEntries(filePath, '');
    assert.equal(results.length, 3);
  } finally {
    cleanupDir(dir);
  }
});

test('searchMemoryEntries: filters by case-insensitive substring', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'I love TypeScript');
    addMemoryEntry(filePath, 'I live in Tokyo');
    addMemoryEntry(filePath, 'I prefer vim keybindings');

    const results = searchMemoryEntries(filePath, 'tokyo');
    assert.equal(results.length, 1);
    assert.equal(results[0].text, 'I live in Tokyo');
  } finally {
    cleanupDir(dir);
  }
});

test('searchMemoryEntries: returns empty array when no match', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'I prefer Python');

    const results = searchMemoryEntries(filePath, 'javascript');
    assert.deepEqual(results, []);
  } finally {
    cleanupDir(dir);
  }
});

// ==================== migrateSqliteToMemoryMd ====================

test('migrateSqliteToMemoryMd: is idempotent — returns 0 if already done', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const source = {
      isMigrationDone: () => true,
      markMigrationDone: () => {},
      getActiveMemoryTexts: () => ['text A', 'text B'],
    };

    const count = migrateSqliteToMemoryMd(filePath, source);
    assert.equal(count, 0);
    assert.ok(!fs.existsSync(filePath), 'should not write file if already migrated');
  } finally {
    cleanupDir(dir);
  }
});

test('migrateSqliteToMemoryMd: migrates texts to MEMORY.md and marks done', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    let done = false;
    const source = {
      isMigrationDone: () => false,
      markMigrationDone: () => { done = true; },
      getActiveMemoryTexts: () => ['I live in Beijing', 'I prefer dark mode'],
    };

    const count = migrateSqliteToMemoryMd(filePath, source);
    assert.equal(count, 2);
    assert.equal(done, true);

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.text === 'I live in Beijing'));
  } finally {
    cleanupDir(dir);
  }
});

test('migrateSqliteToMemoryMd: skips duplicates that already exist in MEMORY.md', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    // Pre-populate with one entry
    addMemoryEntry(filePath, 'I live in Beijing');

    let done = false;
    const source = {
      isMigrationDone: () => false,
      markMigrationDone: () => { done = true; },
      getActiveMemoryTexts: () => ['I live in Beijing', 'I prefer Python'],
    };

    const count = migrateSqliteToMemoryMd(filePath, source);
    assert.equal(count, 1, 'only 1 new entry should be added');
    assert.equal(done, true);

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(entries.length, 2);
  } finally {
    cleanupDir(dir);
  }
});

test('migrateSqliteToMemoryMd: empty source marks done without writing file', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    let done = false;
    const source = {
      isMigrationDone: () => false,
      markMigrationDone: () => { done = true; },
      getActiveMemoryTexts: () => [],
    };

    const count = migrateSqliteToMemoryMd(filePath, source);
    assert.equal(count, 0);
    assert.equal(done, true);
  } finally {
    cleanupDir(dir);
  }
});
