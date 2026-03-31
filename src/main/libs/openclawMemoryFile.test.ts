import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  addMemoryEntry,
  deleteMemoryEntry,
  migrateSqliteToMemoryMd,
  parseMemoryMd,
  readMemoryEntries,
  resolveBootstrapFilePath,
  resolveMemoryFilePath,
  searchMemoryEntries,
  serializeMemoryMd,
  syncMemoryFileOnWorkspaceChange,
  updateMemoryEntry,
  writeMemoryEntries,
  type MigrationDataSource,
  type OpenClawMemoryEntry,
} from './openclawMemoryFile';

// ---------------------------------------------------------------------------
// Mock electron so the module can be imported outside Electron
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: {
    getLocale: () => 'zh-CN',
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1(text: string): string {
  const normalised = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha1').update(normalised).digest('hex');
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmpFile(name = 'MEMORY.md'): string {
  return path.join(tmpDir, name);
}

// ---------------------------------------------------------------------------
// resolveMemoryFilePath
// ---------------------------------------------------------------------------

describe('resolveMemoryFilePath', () => {
  test('returns path inside provided directory', () => {
    const result = resolveMemoryFilePath('/some/dir');
    expect(result).toBe(path.join('/some/dir', 'MEMORY.md'));
  });

  test('falls back to ~/.openclaw/workspace when empty string', () => {
    const result = resolveMemoryFilePath('');
    expect(result).toContain('MEMORY.md');
    expect(result).toContain('.openclaw');
  });

  test('falls back to default when undefined', () => {
    const result = resolveMemoryFilePath(undefined);
    expect(result).toContain('MEMORY.md');
    expect(result).toContain('.openclaw');
  });

  test('trims whitespace from directory', () => {
    const result = resolveMemoryFilePath('  /my/workspace  ');
    expect(result).toBe(path.join('/my/workspace', 'MEMORY.md'));
  });
});

// ---------------------------------------------------------------------------
// resolveBootstrapFilePath
// ---------------------------------------------------------------------------

describe('resolveBootstrapFilePath', () => {
  test('resolves IDENTITY.md path inside working directory', () => {
    const result = resolveBootstrapFilePath('/ws', 'IDENTITY.md');
    expect(result).toBe(path.join('/ws', 'IDENTITY.md'));
  });

  test('resolves USER.md and SOUL.md', () => {
    expect(resolveBootstrapFilePath('/ws', 'USER.md')).toBe(path.join('/ws', 'USER.md'));
    expect(resolveBootstrapFilePath('/ws', 'SOUL.md')).toBe(path.join('/ws', 'SOUL.md'));
  });

  test('throws on disallowed filename', () => {
    expect(() => resolveBootstrapFilePath('/ws', 'EVIL.md')).toThrow('Invalid bootstrap filename');
  });

  test('throws on path traversal attempt', () => {
    expect(() => resolveBootstrapFilePath('/ws', '../etc/passwd')).toThrow('Invalid bootstrap filename');
  });
});

// ---------------------------------------------------------------------------
// parseMemoryMd
// ---------------------------------------------------------------------------

describe('parseMemoryMd', () => {
  test('returns empty array for empty string', () => {
    expect(parseMemoryMd('')).toEqual([]);
  });

  test('parses simple bullet lines', () => {
    const content = '# User Memories\n\n- I like cats\n- I prefer dark mode\n';
    const entries = parseMemoryMd(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('I like cats');
    expect(entries[1].text).toBe('I prefer dark mode');
  });

  test('assigns stable SHA-1 id based on normalised text', () => {
    const entries = parseMemoryMd('- Hello World\n');
    expect(entries[0].id).toBe(sha1('Hello World'));
  });

  test('deduplicates entries with identical normalised text', () => {
    const content = '- I like cats\n- I like cats\n- I LIKE CATS\n';
    const entries = parseMemoryMd(content);
    expect(entries).toHaveLength(1);
  });

  test('ignores non-bullet lines', () => {
    const content = '# Heading\nSome paragraph text.\n* star bullet (ignored)\n- valid bullet\n';
    const entries = parseMemoryMd(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('valid bullet');
  });

  test('strips code blocks before parsing', () => {
    const content = '```\n- this should be ignored\n```\n- real bullet\n';
    const entries = parseMemoryMd(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('real bullet');
  });

  test('skips lines shorter than 2 characters after trimming', () => {
    const content = '- a\n- valid entry\n';
    const entries = parseMemoryMd(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('valid entry');
  });

  test('normalises internal whitespace in bullet text', () => {
    // parseMemoryMd collapses consecutive spaces to a single space
    const entries = parseMemoryMd('- hello   world\n');
    expect(entries[0].text).toBe('hello world');
  });

  test('handles Windows-style CRLF line endings', () => {
    const content = '- first\r\n- second\r\n';
    const entries = parseMemoryMd(content);
    expect(entries).toHaveLength(2);
  });

  test('handles multiple code blocks', () => {
    const content = '```\n- fake1\n```\n- real\n```\n- fake2\n```\n';
    const entries = parseMemoryMd(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('real');
  });
});

// ---------------------------------------------------------------------------
// serializeMemoryMd
// ---------------------------------------------------------------------------

describe('serializeMemoryMd', () => {
  test('returns header-only string for empty entries', () => {
    expect(serializeMemoryMd([])).toBe('# User Memories\n');
  });

  test('formats entries as bullet list under header', () => {
    const entries: OpenClawMemoryEntry[] = [
      { id: sha1('a'), text: 'entry a' },
      { id: sha1('b'), text: 'entry b' },
    ];
    const result = serializeMemoryMd(entries);
    expect(result).toBe('# User Memories\n\n- entry a\n- entry b\n');
  });

  test('round-trips through parseMemoryMd', () => {
    const entries: OpenClawMemoryEntry[] = [
      { id: sha1('cats'), text: 'I like cats' },
      { id: sha1('dark'), text: 'I prefer dark mode' },
    ];
    const serialised = serializeMemoryMd(entries);
    const parsed = parseMemoryMd(serialised);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('I like cats');
    expect(parsed[1].text).toBe('I prefer dark mode');
  });
});

// ---------------------------------------------------------------------------
// writeMemoryEntries / readMemoryEntries
// ---------------------------------------------------------------------------

describe('writeMemoryEntries / readMemoryEntries', () => {
  test('writes and reads back entries correctly', () => {
    const filePath = tmpFile();
    const entries: OpenClawMemoryEntry[] = [
      { id: sha1('cats'), text: 'I like cats' },
    ];
    writeMemoryEntries(filePath, entries);
    const read = readMemoryEntries(filePath);
    expect(read).toHaveLength(1);
    expect(read[0].text).toBe('I like cats');
  });

  test('readMemoryEntries returns empty array for nonexistent file', () => {
    const result = readMemoryEntries(path.join(tmpDir, 'nonexistent.md'));
    expect(result).toEqual([]);
  });

  test('creates parent directories automatically', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c', 'MEMORY.md');
    writeMemoryEntries(nested, [{ id: sha1('x'), text: 'x' }]);
    expect(fs.existsSync(nested)).toBe(true);
  });

  test('preserves non-bullet content when overwriting', () => {
    const filePath = tmpFile();
    // Write initial file with headings and a bullet
    fs.writeFileSync(filePath, '# Custom Section\n\nSome prose.\n\n- old entry\n', 'utf8');
    writeMemoryEntries(filePath, [{ id: sha1('new'), text: 'new entry' }]);
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('# Custom Section');
    expect(raw).toContain('Some prose.');
    expect(raw).toContain('- new entry');
    expect(raw).not.toContain('- old entry');
  });

  test('appends entries when file has no existing bullets', () => {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, '# Header\n\nJust prose.\n', 'utf8');
    writeMemoryEntries(filePath, [{ id: sha1('x'), text: 'appended' }]);
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('- appended');
    expect(raw).toContain('# Header');
  });
});

// ---------------------------------------------------------------------------
// addMemoryEntry
// ---------------------------------------------------------------------------

describe('addMemoryEntry', () => {
  test('adds a new entry and returns it', () => {
    const filePath = tmpFile();
    const entry = addMemoryEntry(filePath, 'I like cats');
    expect(entry.text).toBe('I like cats');
    expect(entry.id).toBe(sha1('I like cats'));
  });

  test('persists the added entry to disk', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'I like cats');
    const entries = readMemoryEntries(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('I like cats');
  });

  test('skips duplicate (same normalised text)', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'I like cats');
    addMemoryEntry(filePath, 'I LIKE CATS');
    const entries = readMemoryEntries(filePath);
    expect(entries).toHaveLength(1);
  });

  test('throws when text is empty', () => {
    expect(() => addMemoryEntry(tmpFile(), '')).toThrow('Memory text is required');
  });

  test('throws when text is only whitespace', () => {
    expect(() => addMemoryEntry(tmpFile(), '   ')).toThrow('Memory text is required');
  });

  test('accumulates multiple distinct entries', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'entry one');
    addMemoryEntry(filePath, 'entry two');
    addMemoryEntry(filePath, 'entry three');
    const entries = readMemoryEntries(filePath);
    expect(entries).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// updateMemoryEntry
// ---------------------------------------------------------------------------

describe('updateMemoryEntry', () => {
  test('updates existing entry and returns updated entry', () => {
    const filePath = tmpFile();
    const { id } = addMemoryEntry(filePath, 'old text');
    const updated = updateMemoryEntry(filePath, id, 'new text');
    expect(updated).not.toBeNull();
    expect(updated!.text).toBe('new text');
    expect(updated!.id).toBe(sha1('new text'));
  });

  test('persists the update to disk', () => {
    const filePath = tmpFile();
    const { id } = addMemoryEntry(filePath, 'old text');
    updateMemoryEntry(filePath, id, 'new text');
    const entries = readMemoryEntries(filePath);
    expect(entries[0].text).toBe('new text');
  });

  test('returns null for nonexistent id', () => {
    const filePath = tmpFile();
    const result = updateMemoryEntry(filePath, 'nonexistent-id', 'new text');
    expect(result).toBeNull();
  });

  test('throws when new text is empty', () => {
    const filePath = tmpFile();
    const { id } = addMemoryEntry(filePath, 'valid entry');
    expect(() => updateMemoryEntry(filePath, id, '')).toThrow('Memory text is required');
  });

  test('id changes after update because it is content-based', () => {
    const filePath = tmpFile();
    const { id: oldId } = addMemoryEntry(filePath, 'old text');
    const updated = updateMemoryEntry(filePath, oldId, 'new text');
    expect(updated!.id).not.toBe(oldId);
  });
});

// ---------------------------------------------------------------------------
// deleteMemoryEntry
// ---------------------------------------------------------------------------

describe('deleteMemoryEntry', () => {
  test('deletes existing entry and returns true', () => {
    const filePath = tmpFile();
    const { id } = addMemoryEntry(filePath, 'to delete');
    const result = deleteMemoryEntry(filePath, id);
    expect(result).toBe(true);
  });

  test('entry is removed from disk after deletion', () => {
    const filePath = tmpFile();
    const { id } = addMemoryEntry(filePath, 'to delete');
    deleteMemoryEntry(filePath, id);
    const entries = readMemoryEntries(filePath);
    expect(entries).toHaveLength(0);
  });

  test('returns false for nonexistent id', () => {
    const filePath = tmpFile();
    const result = deleteMemoryEntry(filePath, 'no-such-id');
    expect(result).toBe(false);
  });

  test('leaves other entries intact', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'keep me');
    const { id } = addMemoryEntry(filePath, 'delete me');
    deleteMemoryEntry(filePath, id);
    const entries = readMemoryEntries(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('keep me');
  });
});

// ---------------------------------------------------------------------------
// searchMemoryEntries
// ---------------------------------------------------------------------------

describe('searchMemoryEntries', () => {
  test('returns all entries for empty query', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'cats');
    addMemoryEntry(filePath, 'dogs');
    const results = searchMemoryEntries(filePath, '');
    expect(results).toHaveLength(2);
  });

  test('filters entries by substring (case-insensitive)', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'I like cats');
    addMemoryEntry(filePath, 'I prefer dogs');
    const results = searchMemoryEntries(filePath, 'CATS');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('I like cats');
  });

  test('returns empty array when no match', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'cats');
    expect(searchMemoryEntries(filePath, 'fish')).toHaveLength(0);
  });

  test('returns empty array on whitespace-only query that becomes empty after trim', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'cats');
    addMemoryEntry(filePath, 'dogs');
    // '  ' trims to '' → returns all
    const results = searchMemoryEntries(filePath, '  ');
    expect(results).toHaveLength(2);
  });

  test('matches multiple entries', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'prefer dark mode');
    addMemoryEntry(filePath, 'dark theme in editors');
    addMemoryEntry(filePath, 'light mode for presentations');
    const results = searchMemoryEntries(filePath, 'dark');
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// migrateSqliteToMemoryMd
// ---------------------------------------------------------------------------

describe('migrateSqliteToMemoryMd', () => {
  function makeSource(opts: {
    done?: boolean;
    texts?: string[];
  }): MigrationDataSource & { doneCalled: boolean } {
    let done = opts.done ?? false;
    return {
      doneCalled: false,
      isMigrationDone: () => done,
      markMigrationDone() {
        done = true;
        this.doneCalled = true;
      },
      getActiveMemoryTexts: () => opts.texts ?? [],
    };
  }

  test('returns 0 immediately when migration is already done', () => {
    const source = makeSource({ done: true });
    const count = migrateSqliteToMemoryMd(tmpFile(), source);
    expect(count).toBe(0);
    expect(source.doneCalled).toBe(false);
  });

  test('returns 0 and marks done when no SQLite memories', () => {
    const source = makeSource({ texts: [] });
    const count = migrateSqliteToMemoryMd(tmpFile(), source);
    expect(count).toBe(0);
    expect(source.doneCalled).toBe(true);
  });

  test('migrates texts to MEMORY.md and returns count', () => {
    const filePath = tmpFile();
    const source = makeSource({ texts: ['I like cats', 'I prefer dark mode'] });
    const count = migrateSqliteToMemoryMd(filePath, source);
    expect(count).toBe(2);
    const entries = readMemoryEntries(filePath);
    expect(entries).toHaveLength(2);
  });

  test('marks migration done after successful migrate', () => {
    const source = makeSource({ texts: ['entry'] });
    migrateSqliteToMemoryMd(tmpFile(), source);
    expect(source.doneCalled).toBe(true);
  });

  test('skips duplicates already in MEMORY.md', () => {
    const filePath = tmpFile();
    addMemoryEntry(filePath, 'already here');
    const source = makeSource({ texts: ['already here', 'new entry'] });
    const count = migrateSqliteToMemoryMd(filePath, source);
    expect(count).toBe(1);
    const entries = readMemoryEntries(filePath);
    expect(entries).toHaveLength(2);
  });

  test('skips texts that are too short after trim', () => {
    const source = makeSource({ texts: ['a', '', '  ', 'valid entry'] });
    const count = migrateSqliteToMemoryMd(tmpFile(), source);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// syncMemoryFileOnWorkspaceChange
// ---------------------------------------------------------------------------

describe('syncMemoryFileOnWorkspaceChange', () => {
  test('returns synced=false when old and new paths are the same', () => {
    const result = syncMemoryFileOnWorkspaceChange('/same', '/same');
    expect(result.synced).toBe(false);
  });

  test('returns synced=false when old MEMORY.md is empty', () => {
    const oldDir = path.join(tmpDir, 'old');
    const newDir = path.join(tmpDir, 'new');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    // Don't write anything to oldDir
    const result = syncMemoryFileOnWorkspaceChange(oldDir, newDir);
    expect(result.synced).toBe(false);
  });

  test('copies entries from old to new workspace', () => {
    const oldDir = path.join(tmpDir, 'old');
    const newDir = path.join(tmpDir, 'new');
    fs.mkdirSync(oldDir, { recursive: true });
    addMemoryEntry(path.join(oldDir, 'MEMORY.md'), 'entry from old');

    const result = syncMemoryFileOnWorkspaceChange(oldDir, newDir);
    expect(result.synced).toBe(true);

    const newEntries = readMemoryEntries(path.join(newDir, 'MEMORY.md'));
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0].text).toBe('entry from old');
  });

  test('deduplicates entries already in new workspace', () => {
    const oldDir = path.join(tmpDir, 'old');
    const newDir = path.join(tmpDir, 'new');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });

    addMemoryEntry(path.join(oldDir, 'MEMORY.md'), 'shared entry');
    addMemoryEntry(path.join(oldDir, 'MEMORY.md'), 'old only entry');
    addMemoryEntry(path.join(newDir, 'MEMORY.md'), 'shared entry');

    syncMemoryFileOnWorkspaceChange(oldDir, newDir);

    const newEntries = readMemoryEntries(path.join(newDir, 'MEMORY.md'));
    const texts = newEntries.map((e) => e.text);
    expect(texts.filter((t) => t === 'shared entry')).toHaveLength(1);
    expect(texts).toContain('old only entry');
  });

  test('returns synced=false when old MEMORY.md has no bullet entries', () => {
    const oldDir = path.join(tmpDir, 'old');
    const newDir = path.join(tmpDir, 'new');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'MEMORY.md'), '# Header\n\nJust prose.\n', 'utf8');

    const result = syncMemoryFileOnWorkspaceChange(oldDir, newDir);
    expect(result.synced).toBe(false);
  });
});
