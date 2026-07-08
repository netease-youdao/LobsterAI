import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/tmp' },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addMemoryEntry,
  deleteMemoryEntry,
  migrateSqliteToMemoryMd,
  parseMemoryMd,
  readMemoryFileRaw,
  resolveMemoryFilePath,
  searchMemoryEntries,
  serializeMemoryMd,
  updateMemoryEntry,
  writeMemoryFileRaw,
} from './openclawMemoryFile';

// ---- helpers ----------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-memoryfile-test-'));
}

function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function memFilePath(dir: string) {
  return path.join(dir, 'MEMORY.md');
}

// ==================== parseMemoryMd ====================

test('parseMemoryMd: extracts top-level bullet lines', () => {
  const md = `# User Memories\n\n- I am a software engineer\n- I prefer dark mode\n`;
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(2);
  expect(entries[0].text).toBe('I am a software engineer');
  expect(entries[1].text).toBe('I prefer dark mode');
});

test('parseMemoryMd: each entry has a stable SHA-1 id', () => {
  const md = `- Hello world\n`;
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(1);
  expect(entries[0].id).toMatch(/^[0-9a-f]{40}$/);
});

test('parseMemoryMd: deduplications identical entries (same fingerprint)', () => {
  const md = `- same entry\n- same entry\n- same entry\n`;
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(1);
});

test('parseMemoryMd: fingerprint is case-insensitive and punctuation-agnostic', () => {
  const md = `- Hello, World!\n- hello world\n`;
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(1);
});

test('parseMemoryMd: headings are not entries; prose paragraphs are', () => {
  const md = `# User Memories\n\nSome prose paragraph.\n\n## Section\n\n- a bullet entry\n`;
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(2);
  expect(entries[0].text).toBe('Some prose paragraph.');
  expect(entries[0].section).toBeUndefined();
  expect(entries[1].text).toBe('a bullet entry');
  expect(entries[1].section).toBe('Section');
});

test('parseMemoryMd: skips bullets inside fenced code blocks', () => {
  const md = `- real entry\n\`\`\`\n- fake bullet inside code\n\`\`\`\n- another real entry\n`;
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(2);
  expect(entries.every((e: { text: string }) => !e.text.includes('fake'))).toBeTruthy();
});

test('parseMemoryMd: empty string returns empty array', () => {
  expect(parseMemoryMd('')).toEqual([]);
});

test('parseMemoryMd: preserves entry text verbatim; fingerprint ignores extra whitespace', () => {
  const md = `- text  with   extra   spaces\n- text with extra spaces\n`;
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(1);
  expect(entries[0].text).toBe('text  with   extra   spaces');
});

test('parseMemoryMd: legacy flat files keep the same content-addressed ids', () => {
  // The pre-block parser produced sha1(normalized single-line text).
  // sha1('hello world') pins that the id scheme is unchanged for flat files.
  const entries = parseMemoryMd('- Hello world\n');
  expect(entries[0].id).toBe('2aae6c35c94fcfb415dbe95f408b9ce91ee846ed');
});

// ==================== serializeMemoryMd ====================

test('serializeMemoryMd: produces header + bullet lines', () => {
  const entries = [
    { id: 'abc', text: 'I am an engineer' },
    { id: 'def', text: 'I prefer TypeScript' },
  ];
  const md = serializeMemoryMd(entries);
  expect(md).toMatch(/^# User Memories\n/);
  expect(md).toMatch(/- I am an engineer\n/);
  expect(md).toMatch(/- I prefer TypeScript\n/);
});

test('serializeMemoryMd: empty entries produces header only', () => {
  const md = serializeMemoryMd([]);
  expect(md.trim()).toBe('# User Memories');
});

test('serializeMemoryMd: output is parseable round-trip', () => {
  const original = [
    { id: 'a1', text: 'I live in Shanghai' },
    { id: 'b2', text: 'I prefer dark mode' },
  ];
  const md = serializeMemoryMd(original);
  const parsed = parseMemoryMd(md);
  expect(parsed.length).toBe(2);
  expect(parsed.some((e: { text: string }) => e.text === 'I live in Shanghai')).toBeTruthy();
  expect(parsed.some((e: { text: string }) => e.text === 'I prefer dark mode')).toBeTruthy();
});

// ==================== resolveMemoryFilePath ====================

test('resolveMemoryFilePath: uses provided directory', () => {
  const p = resolveMemoryFilePath('/my/workspace');
  expect(p).toBe(path.join('/my/workspace', 'MEMORY.md'));
});

test('resolveMemoryFilePath: falls back to ~/.openclaw/workspace when empty', () => {
  const p = resolveMemoryFilePath('');
  expect(p).toMatch(/\.openclaw[/\\]workspace[/\\]MEMORY\.md$/);
});

test('resolveMemoryFilePath: falls back when undefined', () => {
  const p = resolveMemoryFilePath(undefined);
  expect(p).toMatch(/MEMORY\.md$/);
});

// ==================== addMemoryEntry ====================

test('addMemoryEntry: adds a new entry to an empty file', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const entry = addMemoryEntry(filePath, 'I am a backend developer');
    expect(entry.text).toBe('I am a backend developer');
    expect(entry.id).toMatch(/^[0-9a-f]{40}$/);

    const contents = fs.readFileSync(filePath, 'utf-8');
    expect(contents).toMatch(/- I am a backend developer/);
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
    expect(entries.length).toBe(1);
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
    expect(entries.length).toBe(1);
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: creates parent directories if missing', () => {
  const dir = makeTmpDir();
  try {
    const deepPath = path.join(dir, 'subdir', 'nested', 'MEMORY.md');
    addMemoryEntry(deepPath, 'test entry');
    expect(fs.existsSync(deepPath)).toBeTruthy();
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: throws for empty text', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    expect(() => addMemoryEntry(filePath, '')).toThrow(/required/i);
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

    expect(updated).not.toBe(null);
    expect(updated.text).toBe('I work in Shanghai');

    const contents = fs.readFileSync(filePath, 'utf-8');
    expect(contents).toMatch(/I work in Shanghai/);
    expect(contents).not.toMatch(/I work in Beijing/);
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

    expect(e2.id).not.toBe(e1.id);
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
    expect(result).toBe(null);
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
    expect(removed).toBe(true);

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    expect(entries.length).toBe(0);
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
    expect(result).toBe(false);

    // Remaining entry untouched
    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    expect(entries.length).toBe(1);
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
    expect(entries.length).toBe(2);
    expect(entries.some((e: { text: string }) => e.text === 'keep entry A')).toBeTruthy();
    expect(entries.some((e: { text: string }) => e.text === 'keep entry B')).toBeTruthy();
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
    expect(results.length).toBe(3);
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
    expect(results.length).toBe(1);
    expect(results[0].text).toBe('I live in Tokyo');
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
    expect(results).toEqual([]);
  } finally {
    cleanupDir(dir);
  }
});

// ==================== migrateSqliteToMemoryMd ====================

test('migrateSqliteToMemoryMd: is idempotent - returns 0 if already done', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const source = {
      isMigrationDone: () => true,
      markMigrationDone: () => {},
      getActiveMemoryTexts: () => ['text A', 'text B'],
    };

    const count = migrateSqliteToMemoryMd(filePath, source);
    expect(count).toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
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
    expect(count).toBe(2);
    expect(done).toBe(true);

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    expect(entries.length).toBe(2);
    expect(entries.some((e: { text: string }) => e.text === 'I live in Beijing')).toBeTruthy();
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
    expect(count).toBe(1);
    expect(done).toBe(true);

    const entries = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    expect(entries.length).toBe(2);
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
    expect(count).toBe(0);
    expect(done).toBe(true);
  } finally {
    cleanupDir(dir);
  }
});

test('migrateSqliteToMemoryMd: skips texts that already exist as lines inside a block', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    fs.writeFileSync(filePath, '# User Memories\n\n- parent fact:\n  - child detail A\n', 'utf-8');

    const source = {
      isMigrationDone: () => false,
      markMigrationDone: () => {},
      getActiveMemoryTexts: () => ['child detail A', 'brand new fact'],
    };

    const count = migrateSqliteToMemoryMd(filePath, source);
    expect(count).toBe(1);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toMatch(/brand new fact/);
    expect(content.match(/child detail A/g)?.length).toBe(1);
  } finally {
    cleanupDir(dir);
  }
});

// ==================== block-level parsing ====================

const NESTED_MD = [
  '# User Memories',
  '',
  'Intro prose kept as an entry.',
  '',
  '## Projects',
  '',
  '- release flow:',
  '  - bump the version first',
  '  - run dist to verify the installer',
  '',
  '- commit style uses conventional commits',
  '',
  '```',
  '- not an entry, inside a fence',
  '```',
  '',
].join('\n');

test('parseMemoryMd: nested bullets form a single block entry', () => {
  const entries = parseMemoryMd(NESTED_MD);
  expect(entries.length).toBe(3);
  expect(entries[1].text).toBe(
    'release flow:\n  - bump the version first\n  - run dist to verify the installer',
  );
  expect(entries[1].section).toBe('Projects');
  expect(entries[2].section).toBe('Projects');
  expect(entries.every((e) => !e.text.includes('fence'))).toBeTruthy();
});

test('parseMemoryMd: lazy continuation lines stay in the block', () => {
  const md = '- first line\nsecond line without indent\n\n- separate entry\n';
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(2);
  expect(entries[0].text).toBe('first line\nsecond line without indent');
});

test('parseMemoryMd: top-level HTML comments are metadata, not entries', () => {
  const md = [
    '## Promoted From Short-Term Memory (2026-06-28)',
    '',
    '<!-- openclaw-memory-promotion:memory:memory/2026-06-23.md:74:74 -->',
    '- promoted fact; confidence: 0.79',
    '',
    '<!-- multi-line comment',
    'still inside the comment -->',
    '- another fact',
    '',
  ].join('\n');
  const entries = parseMemoryMd(md);
  expect(entries.length).toBe(2);
  expect(entries[0].text).toBe('promoted fact; confidence: 0.79');
  expect(entries[0].section).toBe('Promoted From Short-Term Memory (2026-06-28)');
  expect(entries[1].text).toBe('another fact');
});

test('updateMemoryEntry: HTML comment markers survive edits verbatim', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const md = '<!-- marker -->\n- promoted fact\n';
    fs.writeFileSync(filePath, md, 'utf-8');

    const entries = parseMemoryMd(md);
    updateMemoryEntry(filePath, entries[0].id, 'edited fact');

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe('<!-- marker -->\n- edited fact\n');
  } finally {
    cleanupDir(dir);
  }
});

test('parseMemoryMd: level-1 heading resets the section', () => {
  const md = '- a\n\n## Sec\n\n- b\n\n# Top\n\n- c\n';
  const entries = parseMemoryMd(md);
  expect(entries[0].section).toBeUndefined();
  expect(entries[1].section).toBe('Sec');
  expect(entries[2].section).toBeUndefined();
});

// ==================== surgical writes ====================

test('updateMemoryEntry: replaces the block in place and keeps other lines verbatim', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    fs.writeFileSync(filePath, NESTED_MD, 'utf-8');

    const entries = parseMemoryMd(NESTED_MD);
    const updated = updateMemoryEntry(filePath, entries[2].id, 'commit style: cc only');
    expect(updated?.section).toBe('Projects');

    const content = fs.readFileSync(filePath, 'utf-8');
    const expected = NESTED_MD.replace(
      '- commit style uses conventional commits',
      '- commit style: cc only',
    );
    expect(content).toBe(expected);
  } finally {
    cleanupDir(dir);
  }
});

test('updateMemoryEntry: no-op when text is unchanged (no write, no backup)', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const entry = addMemoryEntry(filePath, 'stable fact');
    const before = fs.readFileSync(filePath, 'utf-8');

    const result = updateMemoryEntry(filePath, entry.id, 'stable fact');
    expect(result?.id).toBe(entry.id);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test('deleteMemoryEntry: removes the whole block and collapses the separator', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    fs.writeFileSync(filePath, NESTED_MD, 'utf-8');

    const entries = parseMemoryMd(NESTED_MD);
    expect(deleteMemoryEntry(filePath, entries[1].id)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toMatch(/bump the version/);
    expect(content).not.toMatch(/\n\n\n/);
    expect(content).toMatch(/- not an entry, inside a fence/);
    expect(content).toMatch(/Intro prose kept as an entry\./);
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: appends after existing content and inherits the trailing section', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    fs.writeFileSync(filePath, NESTED_MD, 'utf-8');

    const entry = addMemoryEntry(filePath, 'a fresh fact');
    expect(entry.section).toBe('Projects');

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.startsWith(NESTED_MD.replace(/\s+$/, ''))).toBe(true);
    expect(content).toMatch(/\n\n- a fresh fact\n$/);
  } finally {
    cleanupDir(dir);
  }
});

test('addMemoryEntry: multi-line input becomes one bullet block', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    const entry = addMemoryEntry(filePath, 'release flow:\n- bump version\n\n- run dist\n');
    expect(entry.text).toBe('release flow:\n  - bump version\n  - run dist');

    const reread = parseMemoryMd(fs.readFileSync(filePath, 'utf-8'));
    expect(reread.length).toBe(1);
    expect(reread[0].id).toBe(entry.id);
    expect(reread[0].text).toBe(entry.text);
  } finally {
    cleanupDir(dir);
  }
});

test('mutations create MEMORY.md.bak once and never overwrite it', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    addMemoryEntry(filePath, 'entry A');
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);

    const beforeB = fs.readFileSync(filePath, 'utf-8');
    addMemoryEntry(filePath, 'entry B');
    expect(fs.readFileSync(`${filePath}.bak`, 'utf-8')).toBe(beforeB);

    addMemoryEntry(filePath, 'entry C');
    expect(fs.readFileSync(`${filePath}.bak`, 'utf-8')).toBe(beforeB);
  } finally {
    cleanupDir(dir);
  }
});

// ==================== raw file access ====================

test('writeMemoryFileRaw/readMemoryFileRaw: round-trips and stays parseable', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    writeMemoryFileRaw(filePath, '# User Memories\n\n- raw entry');
    expect(readMemoryFileRaw(filePath)).toBe('# User Memories\n\n- raw entry\n');

    const entries = parseMemoryMd(readMemoryFileRaw(filePath));
    expect(entries.length).toBe(1);
    expect(entries[0].text).toBe('raw entry');
  } finally {
    cleanupDir(dir);
  }
});

test('searchMemoryEntries: matches section names too', () => {
  const dir = makeTmpDir();
  try {
    const filePath = memFilePath(dir);
    writeMemoryFileRaw(filePath, '## Projects\n\n- ship the release\n\n## Habits\n\n- morning runs\n');

    const results = searchMemoryEntries(filePath, 'projects');
    expect(results.length).toBe(1);
    expect(results[0].text).toBe('ship the release');
  } finally {
    cleanupDir(dir);
  }
});
