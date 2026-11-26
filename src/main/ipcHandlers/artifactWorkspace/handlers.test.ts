import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { WorkspaceDirectoryEntryKind } from '../../../shared/artifactPreview/blankDocument';
import { probeGitWorkspaceDirectory } from './gitProbe';
import { listWorkspaceDirectoryEntries } from './listDirectory';
import { renameLocalFileInPlace, sanitizeRenamedBaseName } from './renameFile';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('probeGitWorkspaceDirectory', () => {
  test('returns non-git state for plain folders', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-plain-dir-'));
    tempDirs.push(dir);

    const result = await probeGitWorkspaceDirectory(dir);
    expect(result).toEqual({
      isGitRepository: false,
      changedFileCount: 0,
      branch: null,
    });
  });

  test('detects git repository, branch, and changed file count', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-git-dir-'));
    tempDirs.push(dir);

    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    await fs.writeFile(path.join(dir, 'README.md'), '# hello\n', 'utf8');
    await fs.writeFile(path.join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');

    const result = await probeGitWorkspaceDirectory(dir);
    expect(result.isGitRepository).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.changedFileCount).toBe(2);
  });
});

describe('renameLocalFileInPlace', () => {
  test('sanitizes filenames and strips duplicated extension', () => {
    expect(sanitizeRenamedBaseName('  项目方案.docx  ', '.docx')).toBe('项目方案');
    expect(sanitizeRenamedBaseName('a/b:c*d?', '.docx')).toBe('a b c d');
  });

  test('renames file in place preserving extension and rejects collisions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-rename-'));
    tempDirs.push(dir);

    const firstPath = path.join(dir, '未命名文档.docx');
    const occupiedPath = path.join(dir, '已存在.docx');
    await fs.writeFile(firstPath, 'hello', 'utf8');
    await fs.writeFile(occupiedPath, 'world', 'utf8');

    const conflict = await renameLocalFileInPlace(firstPath, '已存在');
    expect(conflict.success).toBe(false);

    const renamed = await renameLocalFileInPlace(firstPath, '产品规划.docx');
    expect(renamed).toEqual({
      success: true,
      filePath: path.join(dir, '产品规划.docx'),
      fileName: '产品规划.docx',
    });
    expect(await fs.readFile(path.join(dir, '产品规划.docx'), 'utf8')).toBe('hello');
  });
});

describe('listWorkspaceDirectoryEntries', () => {
  test('lists directories first then files in natural order, hiding dotfiles by default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-list-dir-'));
    tempDirs.push(dir);

    await fs.mkdir(path.join(dir, 'x-browser'));
    await fs.mkdir(path.join(dir, 'ai-news-workbench'));
    await fs.mkdir(path.join(dir, '.hidden-dir'));
    await fs.writeFile(path.join(dir, 'scrape10.mjs'), '', 'utf8');
    await fs.writeFile(path.join(dir, 'scrape2.mjs'), '', 'utf8');
    await fs.writeFile(path.join(dir, 'create_docx.py'), '', 'utf8');
    await fs.writeFile(path.join(dir, '.DS_Store'), '', 'utf8');
    await fs.writeFile(path.join(dir, '.env'), 'KEY=1\n', 'utf8');

    const defaultResult = await listWorkspaceDirectoryEntries(dir);
    expect(defaultResult.success).toBe(true);
    if (!defaultResult.success) return;

    expect(defaultResult.rootPath).toBe(path.resolve(dir));
    expect(defaultResult.directoryPath).toBe(path.resolve(dir));
    expect(defaultResult.truncated).toBe(false);
    expect(defaultResult.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['ai-news-workbench', WorkspaceDirectoryEntryKind.Directory],
      ['x-browser', WorkspaceDirectoryEntryKind.Directory],
      ['create_docx.py', WorkspaceDirectoryEntryKind.File],
      ['scrape2.mjs', WorkspaceDirectoryEntryKind.File],
      ['scrape10.mjs', WorkspaceDirectoryEntryKind.File],
    ]);

    const withHidden = await listWorkspaceDirectoryEntries(dir, { includeHidden: true });
    expect(withHidden.success).toBe(true);
    if (!withHidden.success) return;
    expect(withHidden.entries.map(entry => entry.name)).toContain('.hidden-dir');
    expect(withHidden.entries.map(entry => entry.name)).toContain('.env');
    expect(withHidden.entries.map(entry => entry.name)).not.toContain('.DS_Store');
  });

  test('lists nested subdirectories and blocks escaping outside workspace root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-nested-dir-'));
    tempDirs.push(dir);

    const sub = path.join(dir, 'x-browser');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 'open-headed.mjs'), 'console.log(1);\n', 'utf8');

    const subResult = await listWorkspaceDirectoryEntries(dir, { targetPath: sub });
    expect(subResult.success).toBe(true);
    if (subResult.success) {
      expect(subResult.entries).toEqual([
        {
          name: 'open-headed.mjs',
          path: path.join(path.resolve(dir), 'x-browser', 'open-headed.mjs'),
          kind: WorkspaceDirectoryEntryKind.File,
        },
      ]);
    }

    const escaped = await listWorkspaceDirectoryEntries(dir, { targetPath: path.dirname(dir) });
    expect(escaped.success).toBe(false);
  });

  test('truncates cleanly after sorting when directory exceeds maxEntries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-trunc-dir-'));
    tempDirs.push(dir);

    await fs.mkdir(path.join(dir, 'folder-a'));
    await fs.writeFile(path.join(dir, 'file-1.txt'), '', 'utf8');
    await fs.writeFile(path.join(dir, 'file-2.txt'), '', 'utf8');

    const result = await listWorkspaceDirectoryEntries(dir, { maxEntries: 2 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.truncated).toBe(true);
    expect(result.totalCount).toBe(3);
    expect(result.entries.map(entry => entry.name)).toEqual(['folder-a', 'file-1.txt']);
  });
});
