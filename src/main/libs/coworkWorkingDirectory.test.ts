import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkCoworkWorkingDirectory, CoworkWorkingDirectoryIssue } from './coworkWorkingDirectory';

describe('checkCoworkWorkingDirectory', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-working-directory-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('accepts an existing folder and resolves it', () => {
    const relative = path.relative(process.cwd(), root);

    expect(checkCoworkWorkingDirectory(relative)).toEqual({ ok: true, directory: root });
  });

  test('reports a missing user folder without creating it', () => {
    const unplugged = path.join(root, 'Volumes', 'Elements');

    expect(checkCoworkWorkingDirectory(unplugged)).toEqual({
      ok: false,
      issue: CoworkWorkingDirectoryIssue.Missing,
      directory: unplugged,
    });
    expect(fs.existsSync(path.join(root, 'Volumes'))).toBe(false);
  });

  test('reports a path below a file as missing', () => {
    const file = path.join(root, 'notes.txt');
    fs.writeFileSync(file, 'x');

    expect(checkCoworkWorkingDirectory(path.join(file, 'child'))).toMatchObject({
      ok: false,
      issue: CoworkWorkingDirectoryIssue.Missing,
    });
  });

  test('recreates an app-managed folder when it is missing', () => {
    const managed = path.join(root, 'lobsterai', 'project');

    expect(checkCoworkWorkingDirectory(managed, { recreatableDirectories: [managed] }))
      .toEqual({ ok: true, directory: managed });
    expect(fs.statSync(managed).isDirectory()).toBe(true);
  });

  test('rejects a file', () => {
    const file = path.join(root, 'notes.txt');
    fs.writeFileSync(file, 'x');

    expect(checkCoworkWorkingDirectory(file)).toEqual({
      ok: false,
      issue: CoworkWorkingDirectoryIssue.NotDirectory,
      directory: file,
    });
  });

  test('rejects a Windows drive root before touching the disk', () => {
    expect(checkCoworkWorkingDirectory('D:\\', { platform: 'win32' })).toEqual({
      ok: false,
      issue: CoworkWorkingDirectoryIssue.DriveRoot,
      directory: 'D:\\',
    });
  });
});
