import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { probeGitWorkspaceDirectory } from './gitProbe';
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
