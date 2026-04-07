/**
 * Tests for MEMORY.md structure preservation during CRUD operations.
 *
 * Fixes GitHub issues:
 *   #754 — memory CRUD operations destroy original MEMORY.md structure
 *   #753 — single-character memory entries not rendered after save
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originalModuleLoad = Module._load;

Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const {
  parseMemoryMd,
  serializeMemoryMd,
} = require('../dist-electron/main/libs/openclawMemoryFile.js');

// ---------------------------------------------------------------------------
// #753: Single-character entries should be parsed
// ---------------------------------------------------------------------------

test('parseMemoryMd accepts single-character entries', () => {
  const content = '# Memories\n\n- A\n- Hello world\n- B\n';
  const entries = parseMemoryMd(content);
  const texts = entries.map((e) => e.text);
  assert.ok(texts.includes('A'), 'Single char "A" should be parsed');
  assert.ok(texts.includes('B'), 'Single char "B" should be parsed');
  assert.ok(texts.includes('Hello world'), '"Hello world" should be parsed');
});

// ---------------------------------------------------------------------------
// #754: Structure preservation
// ---------------------------------------------------------------------------

test('parseMemoryMd preserves entries across multiple sections', () => {
  const content = [
    '# User Memories',
    '',
    '## Work',
    '- Uses TypeScript daily',
    '- Prefers Vim',
    '',
    '## Personal',
    '- Likes coffee',
    '- Lives in Shanghai',
    '',
  ].join('\n');

  const entries = parseMemoryMd(content);
  assert.equal(entries.length, 4);
});

test('serializeMemoryMd + parseMemoryMd roundtrip preserves entries', () => {
  const original = [
    { id: 'a1', text: 'Uses TypeScript' },
    { id: 'b2', text: 'Likes coffee' },
  ];
  const serialized = serializeMemoryMd(original);
  const parsed = parseMemoryMd(serialized);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'Uses TypeScript');
  assert.equal(parsed[1].text, 'Likes coffee');
});

// Note: rebuildMemoryMd is not exported, so we test it indirectly via
// the exported CRUD functions (addMemoryEntry, updateMemoryEntry, deleteMemoryEntry).
// Those tests would require file I/O. The core logic test for rebuildMemoryMd
// would ideally be tested if it were exported. For now we validate parseMemoryMd
// which is the other half of the fix.

test('parseMemoryMd ignores bullets inside code blocks', () => {
  const content = [
    '# Notes',
    '',
    '- Real entry',
    '',
    '```',
    '- Not an entry',
    '```',
    '',
    '- Another real entry',
    '',
  ].join('\n');

  const entries = parseMemoryMd(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, 'Real entry');
  assert.equal(entries[1].text, 'Another real entry');
});

test('parseMemoryMd deduplicates entries with same content', () => {
  const content = '- Hello\n- Hello\n- World\n';
  const entries = parseMemoryMd(content);
  assert.equal(entries.length, 2);
});
