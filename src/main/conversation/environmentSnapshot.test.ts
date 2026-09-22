import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { readEnvironmentSnapshot } from './environmentSnapshot';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function repository(commit = true) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cowork-environment-'));
  directories.push(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  const write = (name: string, content: string | Buffer) => writeFileSync(path.join(cwd, name), content);
  if (commit) { write('file.txt', 'old\n'); git('add', '.'); git('commit', '-m', 'test'); }
  return { cwd, git, write };
}

test('reports staged and unstaged worktree content and includes an applicable untracked patch', async () => {
  const { cwd, git, write } = repository();
  write('file.txt', 'staged\n'); git('add', '.'); write('file.txt', 'new\nnext\n'); write('draft.txt', 'draft\n');
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.branch).toBe('main'); expect(snapshot.added).toBe(3); expect(snapshot.removed).toBe(1);
  expect(snapshot.changedFiles).toHaveLength(2); expect(snapshot.totalChangedFiles).toBe(2);
  expect(snapshot.diff).toContain('+next'); expect(snapshot.diff).toContain('+++ b/draft.txt\n');
  expect(snapshot.diff).toContain('+draft\n'); expect(snapshot.statsIncomplete).toBe(false); expect(snapshot.truncated).toBe(false);
  execFileSync('git', ['-C', cwd, 'apply', '--reverse', '--check'], { input: snapshot.diff, stdio: 'pipe' });
});

test('emits a valid new-file patch for unusual names, empty files and missing final newlines', async () => {
  const { cwd, write } = repository();
  write('a\tb\nquote".txt', 'one\ntwo'); write('empty.txt', '');
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.added).toBe(2); expect(snapshot.removed).toBe(0);
  expect(snapshot.diff).toContain('\\ No newline at end of file\n'); expect(snapshot.diff).toContain('new file mode 100644');
  expect(snapshot.changedFiles.find(file => file.path === 'empty.txt')).toMatchObject({ added: 0, removed: 0 });
  execFileSync('git', ['-C', cwd, 'apply', '--reverse', '--check'], { input: snapshot.diff, stdio: 'pipe' });
});

test('counts a pure rename once with zero changed lines, including paths requiring -z parsing', async () => {
  const { cwd, git } = repository();
  git('mv', 'file.txt', 'renamed\tnew\nname.txt');
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.totalChangedFiles).toBe(1); expect(snapshot.changedFiles).toHaveLength(1);
  expect(snapshot.changedFiles[0]).toMatchObject({ path: 'renamed\tnew\nname.txt', added: 0, removed: 0 });
  expect(snapshot.added).toBe(0); expect(snapshot.removed).toBe(0);
  expect(snapshot.diff).toContain('similarity index 100%'); expect(snapshot.diff).toContain('rename from file.txt');
  expect(snapshot.truncated).toBe(false);
});

test('does not count rename source records against the 500-file limit', async () => {
  const { cwd, git, write } = repository(false);
  for (let i = 0; i < 251; i++) write(`old-${i}.txt`, `unique ${i}\n`);
  git('add', '.'); git('commit', '-m', 'initial'); mkdirSync(path.join(cwd, 'renamed'));
  for (let i = 0; i < 251; i++) renameSync(path.join(cwd, `old-${i}.txt`), path.join(cwd, 'renamed', `old-${i}.txt`));
  git('add', '-A');
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.totalChangedFiles).toBe(251); expect(snapshot.changedFiles).toHaveLength(251);
  expect(snapshot.added).toBe(0); expect(snapshot.removed).toBe(0); expect(snapshot.truncated).toBe(false);
});

test('uses latest worktree content in an unborn repository without altering its index', async () => {
  const { cwd, git, write } = repository(false);
  write('first.txt', 'staged\n'); git('add', '.'); write('first.txt', 'current\nsecond\n'); write('draft.txt', 'draft\n');
  const indexBefore = git('ls-files', '--stage');
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.branch).toBe('main'); expect(snapshot.totalChangedFiles).toBe(2);
  expect(snapshot.added).toBe(3); expect(snapshot.removed).toBe(0);
  expect(snapshot.diff).toContain('+current\n+second\n'); expect(snapshot.diff).not.toContain('+staged\n');
  expect(snapshot.statsIncomplete).toBe(false); expect(snapshot.truncated).toBe(false);
  expect(git('ls-files', '--stage')).toBe(indexBefore);
  execFileSync('git', ['-C', cwd, 'apply', '--reverse', '--check'], { input: snapshot.diff, stdio: 'pipe' });
});

test('represents tracked and untracked binary files without inventing line counts', async () => {
  const { cwd, git, write } = repository();
  write('tracked.bin', Buffer.from([0, 1, 2])); git('add', '.'); git('commit', '-m', 'binary');
  write('tracked.bin', Buffer.from([0, 3, 4])); write('new.bin', Buffer.from([0, 5, 6]));
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.totalChangedFiles).toBe(2); expect(snapshot.added).toBe(0); expect(snapshot.removed).toBe(0);
  expect(snapshot.changedFiles.every(file => file.added === null && file.removed === null)).toBe(true);
  expect(snapshot.diff).toContain('Binary files /dev/null and b/new.bin differ');
  expect(snapshot.statsIncomplete).toBe(false); expect(snapshot.truncated).toBe(false);
});

test('reviews a new symlink target without reading the file it points to', async () => {
  const { cwd } = repository();
  const outside = mkdtempSync(path.join(tmpdir(), 'cowork-environment-outside-')); directories.push(outside);
  writeFileSync(path.join(outside, 'private.txt'), 'must not appear in the review');
  symlinkSync(path.join(outside, 'private.txt'), path.join(cwd, 'link'));
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.diff).toContain('new file mode 120000'); expect(snapshot.diff).toContain(`+${path.join(outside, 'private.txt')}`);
  expect(snapshot.diff).not.toContain('must not appear in the review'); expect(snapshot.added).toBe(1);
  expect(snapshot.statsIncomplete).toBe(false);
});

test('reports full file count and incomplete statistics when the review file limit is exceeded', async () => {
  const { cwd, write } = repository();
  for (let i = 0; i < 501; i++) write(`new-${i}.txt`, 'line\n');
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.changedFiles).toHaveLength(500); expect(snapshot.totalChangedFiles).toBe(501);
  expect(snapshot.added).toBe(500); expect(snapshot.truncated).toBe(true); expect(snapshot.statsIncomplete).toBe(true);
});

test('marks oversized untracked files as unreviewed and their statistics as incomplete', async () => {
  const { cwd, write } = repository();
  write('large.txt', 'line\n'.repeat(103_000));
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.totalChangedFiles).toBe(1); expect(snapshot.changedFiles[0]).toMatchObject({ added: null, removed: null });
  expect(snapshot.truncated).toBe(true); expect(snapshot.statsIncomplete).toBe(true);
});

test('marks capped tracked diffs as truncated while retaining complete Git line statistics', async () => {
  const { cwd, write } = repository();
  write('file.txt', 'line\n'.repeat(110_000));
  const snapshot = await readEnvironmentSnapshot(cwd);
  expect(snapshot.diff.length).toBeLessThanOrEqual(500_000); expect(snapshot.added).toBe(110_000); expect(snapshot.removed).toBe(1);
  expect(snapshot.truncated).toBe(true); expect(snapshot.statsIncomplete).toBe(false);
});
