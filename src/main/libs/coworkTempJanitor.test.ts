import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CoworkTempDirKind } from '../../shared/cowork/constants';
import {
  createCoworkTempJanitor,
  ensureCoworkTempGitignore,
  findCoworkTempRoot,
  getCoworkTempDirPath,
  getLegacySqliteBackupDirs,
  measureCoworkTempDir,
  sweepCoworkTempDir,
} from './coworkTempJanitor';

const DAY_MS = 24 * 60 * 60 * 1000;

let workRoot: string;
let tempDir: string;

const writeFileAged = (relPath: string, ageMs: number, content = 'x'): string => {
  const filePath = path.join(tempDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
};

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-temp-janitor-'));
  tempDir = getCoworkTempDirPath(workRoot);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('sweepCoworkTempDir', () => {
  test('deletes files older than retention and keeps fresh ones', async () => {
    const oldFile = writeFileAged('scripts/build.py', 8 * DAY_MS);
    const freshFile = writeFileAged('scripts/new.py', 1 * DAY_MS);

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 7 * DAY_MS });

    expect(result.deletedFiles).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  test('retention 0 (manual mode) deletes all sweepable files', async () => {
    writeFileAged('a.txt', 0);
    writeFileAged('nested/b.txt', 0);

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 0 });

    expect(result.deletedFiles).toBe(2);
  });

  test('keeps attachments younger than the attachments retention', async () => {
    const attachment = writeFileAged('attachments/manual/img.png', 30 * DAY_MS);
    writeFileAged('old.txt', 30 * DAY_MS);

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 0 });

    expect(fs.existsSync(attachment)).toBe(true);
    expect(result.deletedFiles).toBe(1);
  });

  test('removes attachments older than the attachments retention', async () => {
    const staleAttachment = writeFileAged('attachments/manual/ancient.png', 120 * DAY_MS);
    const freshAttachment = writeFileAged('attachments/manual/recent.png', 30 * DAY_MS);

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 0 });

    expect(fs.existsSync(staleAttachment)).toBe(false);
    expect(fs.existsSync(freshAttachment)).toBe(true);
    expect(result.deletedFiles).toBe(1);
  });

  test('dry run reports would-be deletions without removing anything', async () => {
    const oldFile = writeFileAged('old.txt', 30 * DAY_MS, 'abcd');

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 0, dryRun: true });

    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBe(4);
    expect(result.totalFiles).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  test('preserves the root .gitignore marker', async () => {
    ensureCoworkTempGitignore(tempDir);
    const gitignore = path.join(tempDir, '.gitignore');
    const oldDate = new Date(Date.now() - 30 * DAY_MS);
    fs.utimesSync(gitignore, oldDate, oldDate);

    await sweepCoworkTempDir(tempDir, { retentionMs: 0 });

    expect(fs.existsSync(gitignore)).toBe(true);
  });

  test('removes emptied directories but keeps the root', async () => {
    writeFileAged('deep/nested/old.log', 30 * DAY_MS);

    await sweepCoworkTempDir(tempDir, { retentionMs: 0 });

    expect(fs.existsSync(path.join(tempDir, 'deep'))).toBe(false);
    expect(fs.existsSync(tempDir)).toBe(true);
  });

  test('skips symlinked entries without following them', async () => {
    const outsideDir = path.join(workRoot, 'outside');
    fs.mkdirSync(outsideDir);
    const outsideFile = path.join(outsideDir, 'keep.txt');
    fs.writeFileSync(outsideFile, 'keep');
    const oldDate = new Date(Date.now() - 30 * DAY_MS);
    fs.utimesSync(outsideFile, oldDate, oldDate);

    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideDir, path.join(tempDir, 'link'));
      symlinkCreated = true;
    } catch {
      // Symlink creation may be unavailable (e.g. Windows without privilege).
    }
    if (!symlinkCreated) return;

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 0 });

    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'link'))).toBe(true);
    expect(result.skippedEntries).toBeGreaterThan(0);
  });

  test('returns zero result for missing or non-directory paths', async () => {
    const missing = await sweepCoworkTempDir(path.join(workRoot, 'nope', '.cowork-temp'), { retentionMs: 0 });
    expect(missing.deletedFiles).toBe(0);

    const filePath = path.join(workRoot, 'file-not-dir');
    fs.writeFileSync(filePath, 'x');
    const notDir = await sweepCoworkTempDir(filePath, { retentionMs: 0 });
    expect(notDir.deletedFiles).toBe(0);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test('truncates when entry budget is exhausted', async () => {
    for (let i = 0; i < 10; i++) {
      writeFileAged(`f-${i}.txt`, 30 * DAY_MS);
    }

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 0, maxEntries: 3 });

    expect(result.truncated).toBe(true);
    expect(result.deletedFiles).toBeLessThan(10);
  });

  test('respects the depth limit', async () => {
    const deepFile = writeFileAged('a/b/c/old.txt', 30 * DAY_MS);

    const result = await sweepCoworkTempDir(tempDir, { retentionMs: 0, maxDepth: 2 });

    expect(fs.existsSync(deepFile)).toBe(true);
    expect(result.skippedEntries).toBeGreaterThan(0);
  });
});

describe('ensureCoworkTempGitignore', () => {
  test('creates a * gitignore once and never overwrites', () => {
    ensureCoworkTempGitignore(tempDir);
    const gitignorePath = path.join(tempDir, '.gitignore');
    expect(fs.readFileSync(gitignorePath, 'utf8')).toBe('*\n');

    fs.writeFileSync(gitignorePath, 'custom');
    ensureCoworkTempGitignore(tempDir);
    expect(fs.readFileSync(gitignorePath, 'utf8')).toBe('custom');
  });

  test('does nothing for a missing directory', () => {
    const missing = path.join(workRoot, 'missing', '.cowork-temp');
    ensureCoworkTempGitignore(missing);
    expect(fs.existsSync(path.join(missing, '.gitignore'))).toBe(false);
  });
});

describe('measureCoworkTempDir', () => {
  test('reports totals including attachments and the cleanable subset', async () => {
    writeFileAged('a.txt', 0, 'aaaa');
    writeFileAged('attachments/manual/b.png', 0, 'bbbbbb');
    writeFileAged('attachments/manual/ancient.png', 120 * DAY_MS, 'cc');

    const usage = await measureCoworkTempDir(tempDir);

    expect(usage.files).toBe(3);
    expect(usage.bytes).toBe(12);
    // Scratch is immediately cleanable; only the expired attachment joins it.
    expect(usage.cleanableFiles).toBe(2);
    expect(usage.cleanableBytes).toBe(6);
  });
});

describe('findCoworkTempRoot', () => {
  test('finds the enclosing temp root', () => {
    const child = path.join(tempDir, 'attachments', 'manual', 'img.png');
    expect(findCoworkTempRoot(child)).toBe(path.resolve(tempDir));
  });

  test('returns null outside a temp dir', () => {
    expect(findCoworkTempRoot(path.join(workRoot, 'src', 'index.ts'))).toBeNull();
  });
});

describe('createCoworkTempJanitor', () => {
  test('clean sweeps known cwds but always skips active ones', async () => {
    const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-temp-active-'));
    try {
      const activeTemp = getCoworkTempDirPath(activeRoot);
      fs.mkdirSync(activeTemp, { recursive: true });
      const activeFile = path.join(activeTemp, 'busy.txt');
      fs.writeFileSync(activeFile, 'busy');

      writeFileAged('stale.txt', 30 * DAY_MS);

      const janitor = createCoworkTempJanitor({
        listAllCwds: () => [workRoot, activeRoot],
        listActiveCwds: () => [activeRoot],
      });

      const summary = await janitor.clean();

      expect(summary.sweptDirs).toBe(1);
      expect(summary.deletedFiles).toBe(1);
      expect(fs.existsSync(activeFile)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.gitignore'))).toBe(true);
    } finally {
      fs.rmSync(activeRoot, { recursive: true, force: true });
    }
  });

  test('clean honors the selected cwds and ignores unknown paths', async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-temp-other-'));
    const unknownRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-temp-unknown-'));
    try {
      const otherTemp = getCoworkTempDirPath(otherRoot);
      fs.mkdirSync(otherTemp, { recursive: true });
      const otherFile = path.join(otherTemp, 'other.txt');
      fs.writeFileSync(otherFile, 'other');

      const unknownTemp = getCoworkTempDirPath(unknownRoot);
      fs.mkdirSync(unknownTemp, { recursive: true });
      const unknownFile = path.join(unknownTemp, 'keep.txt');
      fs.writeFileSync(unknownFile, 'keep');

      writeFileAged('scratch.txt', 0);

      const janitor = createCoworkTempJanitor({
        listAllCwds: () => [workRoot, otherRoot],
        listActiveCwds: () => [],
      });

      // Select workRoot plus a path the store does not know about.
      const summary = await janitor.clean([workRoot, unknownRoot]);

      expect(summary.sweptDirs).toBe(1);
      expect(summary.deletedFiles).toBe(1);
      expect(fs.existsSync(otherFile)).toBe(true);
      expect(fs.existsSync(unknownFile)).toBe(true);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
      fs.rmSync(unknownRoot, { recursive: true, force: true });
    }
  });

  test('preview reports per-directory usage without deleting anything', async () => {
    const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-temp-active-'));
    try {
      const activeTemp = getCoworkTempDirPath(activeRoot);
      fs.mkdirSync(activeTemp, { recursive: true });
      fs.writeFileSync(path.join(activeTemp, 'busy.txt'), 'busy!');

      const scratch = writeFileAged('a.txt', 0, '12345');

      const janitor = createCoworkTempJanitor({
        listAllCwds: () => [workRoot, workRoot, activeRoot],
        listActiveCwds: () => [activeRoot],
      });

      const preview = await janitor.preview();

      expect(preview.dirs).toHaveLength(2);
      expect(preview.files).toBe(2);
      expect(preview.bytes).toBe(10);
      expect(preview.cleanableFiles).toBe(1);
      expect(preview.cleanableBytes).toBe(5);
      expect(fs.existsSync(scratch)).toBe(true);

      const activeEntry = preview.dirs.find(dir => dir.cwd === fs.realpathSync(activeRoot) || dir.cwd === activeRoot);
      expect(activeEntry?.isActive).toBe(true);
      expect(activeEntry?.cleanableFiles).toBe(0);
    } finally {
      fs.rmSync(activeRoot, { recursive: true, force: true });
    }
  });

  test('previews and cleans legacy SQLite backup directories alongside session temp dirs', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-temp-legacy-'));
    try {
      const snapshotFile = path.join(userDataDir, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite');
      const manifestFile = path.join(userDataDir, 'backups', 'sqlite', 'manifest.json');
      const oldLegacyFile = path.join(userDataDir, 'sqlite-backups', 'lobsterai-latest.sqlite');
      fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
      fs.mkdirSync(path.dirname(oldLegacyFile), { recursive: true });
      fs.writeFileSync(snapshotFile, '0123456789');
      fs.writeFileSync(manifestFile, '{}');
      fs.writeFileSync(oldLegacyFile, 'abcd');

      writeFileAged('scratch.txt', 0, 'xy');

      const janitor = createCoworkTempJanitor({
        listAllCwds: () => [workRoot],
        listActiveCwds: () => [],
        listLegacyDirs: () => getLegacySqliteBackupDirs(userDataDir),
      });

      const preview = await janitor.preview();
      expect(preview.dirs).toHaveLength(3);
      expect(preview.files).toBe(4);
      expect(preview.bytes).toBe(18);
      expect(preview.cleanableFiles).toBe(4);
      expect(preview.cleanableBytes).toBe(18);

      const legacyEntries = preview.dirs.filter(dir => dir.kind === CoworkTempDirKind.LegacySqliteBackup);
      expect(legacyEntries).toHaveLength(2);
      expect(legacyEntries.every(dir => !dir.isActive)).toBe(true);

      // Select only the modern backups/sqlite directory first.
      const sqliteBackupDir = path.resolve(path.join(userDataDir, 'backups', 'sqlite'));
      const firstClean = await janitor.clean([sqliteBackupDir]);
      expect(firstClean.deletedFiles).toBe(2);
      expect(firstClean.freedBytes).toBe(12);
      expect(fs.existsSync(path.join(userDataDir, 'backups', 'sqlite'))).toBe(false);
      expect(fs.existsSync(path.join(userDataDir, 'backups'))).toBe(false);
      expect(fs.existsSync(oldLegacyFile)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'scratch.txt'))).toBe(true);

      // Clean the remaining legacy sqlite-backups directory.
      const legacyOldDir = path.resolve(path.join(userDataDir, 'sqlite-backups'));
      const secondClean = await janitor.clean([legacyOldDir]);
      expect(secondClean.deletedFiles).toBe(1);
      expect(secondClean.freedBytes).toBe(4);
      expect(fs.existsSync(legacyOldDir)).toBe(false);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
