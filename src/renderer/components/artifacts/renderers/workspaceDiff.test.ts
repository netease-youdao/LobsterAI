import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { readEnvironmentSnapshot } from '../../../../main/conversation/environmentSnapshot';
import { parseWorkspaceDiff } from './workspaceDiff';

const patch = (name: string, body: string) => `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n${body}`;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('maps several hunks to exact old/new line numbers and counts only real additions/deletions', () => {
  const parsed = parseWorkspaceDiff(` M notes.md\nRequested changes\n${patch('notes.md', '@@ -2,3 +2,4 @@ heading\n unchanged\n-before\n+after\n+extra\n end\n@@ -20 +21 @@\n-old tail\n+new tail\n')}`);
  expect(parsed).toMatchObject({ added: 3, removed: 2 });
  expect(parsed.files).toHaveLength(1);
  const file = parsed.files[0];
  expect(file).toMatchObject({ path: 'notes.md', status: 'modified', binary: false, added: 3, removed: 2 });
  expect(file.hunks).toHaveLength(2);
  expect(file.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 3, newStart: 2, newLines: 4, section: 'heading' });
  expect(file.hunks[0].lines.map(({ type, content, oldNumber, newNumber }) => ({ type, content, oldNumber, newNumber }))).toEqual([
    { type: 'context', content: 'unchanged', oldNumber: 2, newNumber: 2 },
    { type: 'remove', content: 'before', oldNumber: 3, newNumber: null },
    { type: 'add', content: 'after', oldNumber: null, newNumber: 3 },
    { type: 'add', content: 'extra', oldNumber: null, newNumber: 4 },
    { type: 'context', content: 'end', oldNumber: 4, newNumber: 5 },
  ]);
  expect(file.hunks[1].lines[0].oldNumber).toBe(20);
  expect(file.hunks[1].lines[1].newNumber).toBe(21);
});

test('new, deleted and empty files retain their paths, modes and zero-based empty ranges', () => {
  const parsed = parseWorkspaceDiff('diff --git a/new file.md b/new file.md\nnew file mode 100644\n--- /dev/null\n+++ b/new file.md\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n'
    + 'diff --git a/gone.md b/gone.md\ndeleted file mode 100755\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n'
    + 'diff --git a/empty.md b/empty.md\nnew file mode 100644\n');
  expect(parsed.files.map(file => ({ path: file.path, status: file.status, added: file.added, removed: file.removed }))).toEqual([
    { path: 'new file.md', status: 'added', added: 2, removed: 0 }, { path: 'gone.md', status: 'deleted', added: 0, removed: 1 }, { path: 'empty.md', status: 'added', added: 0, removed: 0 },
  ]);
  expect(parsed.files[0].hunks[0].lines[1]).toMatchObject({ type: 'add', content: 'two', oldNumber: null, newNumber: 2, noNewline: true });
  expect(parsed.files[1].oldMode).toBe('100755');
  expect(parsed.files[2].hunks).toEqual([]);
});

test('recognizes pure rename, copy and mode changes even when there are no text hunks', () => {
  const parsed = parseWorkspaceDiff('diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\n'
    + 'diff --git a/original b/copy\nsimilarity index 100%\ncopy from original\ncopy to copy\n'
    + 'diff --git a/path b/inside b/path b/inside\nold mode 100644\nnew mode 100755\n');
  expect(parsed.files[0]).toMatchObject({ oldPath: 'old name', path: 'new name', status: 'renamed', added: 0, removed: 0, hunks: [] });
  expect(parsed.files[1]).toMatchObject({ oldPath: 'original', path: 'copy', status: 'copied' });
  expect(parsed.files[2]).toMatchObject({ path: 'path b/inside', status: 'mode', oldMode: '100644', newMode: '100755', hunks: [] });
  expect(parsed.added + parsed.removed).toBe(0);
});

test('decodes Git C-quoted UTF-8 octal paths and preserves literal a/ prefixes in rename metadata', () => {
  const parsed = parseWorkspaceDiff(String.raw`diff --git "a/\344\270\255\346\226\207\t\"file\".md" "b/a/next\nname.md"
similarity index 100%
rename from "\344\270\255\346\226\207\t\"file\".md"
rename to "a/next\nname.md"
`);
  expect(parsed.files[0]).toMatchObject({ oldPath: '中文\t"file".md', path: 'a/next\nname.md', status: 'renamed' });
  expect(parseWorkspaceDiff('diff --git a/normal "b/spaced\\tname"\nold mode 100644\nnew mode 100755\n').files[0].path).toBe('spaced\tname');
});

test('binary changes do not turn encoded payloads into text additions or deletions', () => {
  const parsed = parseWorkspaceDiff('diff --git a/photo.png b/photo.png\nindex 111..222 100644\nBinary files a/photo.png and b/photo.png differ\n'
    + 'diff --git a/blob.bin b/blob.bin\nnew file mode 100644\nGIT binary patch\nliteral 3\nKcmZQzU|?Vb0006$\n\nliteral 0\nHcmV?d00001\n');
  expect(parsed.files.map(file => ({ binary: file.binary, status: file.status, hunks: file.hunks }))).toEqual([
    { binary: true, status: 'modified', hunks: [] }, { binary: true, status: 'added', hunks: [] },
  ]);
  expect(parsed.added).toBe(0); expect(parsed.removed).toBe(0);
});

test('header-looking file content and both no-newline markers stay attached to the correct data lines', () => {
  const file = parseWorkspaceDiff(patch('headers.txt', '@@ -1,2 +1,2 @@\n--- old marker\n-old end\n\\ No newline at end of file\n+++ new marker\n+new end\n\\ No newline at end of file\n')).files[0];
  expect(file.hunks[0].lines.map(line => line.content)).toEqual(['-- old marker', 'old end', '++ new marker', 'new end']);
  expect(file.hunks[0].lines.map(line => Boolean(line.noNewline))).toEqual([false, true, false, true]);
  expect(file.added).toBe(2); expect(file.removed).toBe(2);
});

test('traditional unified patches with tab-separated timestamps can contain several files', () => {
  const parsed = parseWorkspaceDiff('--- before name.txt\t2026-09-15 10:00:00\n+++ after name.txt\t2026-09-15 10:01:00\n@@ -1 +1 @@\n-old\n+new\n'
    + '--- /dev/null\n+++ second.txt\t2026-09-15\n@@ -0,0 +1 @@\n+second\n');
  expect(parsed.files).toHaveLength(2);
  expect(parsed.files[0]).toMatchObject({ path: 'after name.txt', oldPath: 'before name.txt' });
  expect(parsed.files[1]).toMatchObject({ path: 'second.txt', status: 'added' });
});

test('stable file/hunk/line IDs survive appended files and duplicate paths remain independently addressable', () => {
  const one = patch('same.txt', '@@ -1 +1 @@\n-before\n+after\n');
  const before = parseWorkspaceDiff(one).files[0];
  const after = parseWorkspaceDiff(one + one).files;
  expect(after[0].id).toBe(before.id);
  expect(after[0].hunks[0].lines.map(line => line.id)).toEqual(before.hunks[0].lines.map(line => line.id));
  expect(after[1].id).not.toBe(after[0].id);
});
test('every parsed code line retains its absolute physical patch line across preamble, markers and files', () => {
  const source = ['Summary', '', 'diff --git a/one b/one', '--- a/one', '+++ b/one', '@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new',
    'diff --git a/two b/two', '--- a/two', '+++ b/two', '@@ -1 +1 @@', '--- looks like a header', '+++ also looks like a header'].join('\n');
  const lines = parseWorkspaceDiff(source).files.flatMap(file => file.hunks.flatMap(hunk => hunk.lines));
  expect(lines.map(line => line.sourceLine)).toEqual([7, 9, 14, 15]);
  expect(lines.map(line => source.split('\n')[line.sourceLine! - 1].slice(1))).toEqual(lines.map(line => line.content));
});

test('truncated hunks report only observed line counts and unrelated logs cannot become phantom files', () => {
  const parsed = parseWorkspaceDiff(patch('partial.txt', '@@ -1,4 +1,5 @@\n same\n-before\n+partial'));
  expect(parsed.files[0].hunks[0].incomplete).toBe(true);
  expect(parsed).toMatchObject({ added: 1, removed: 1 });
  expect(parseWorkspaceDiff(' M known.ts\n+output is a log\n--- explanation only\nNothing to compare').files).toEqual([]);
});

test('real Git environment snapshots preserve renamed, untracked, binary and mode-only files without mutating the index', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'workspace-diff-parser-')); directories.push(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const write = (name: string, content: string | Buffer) => writeFileSync(path.join(cwd, name), content);
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.quotepath', 'true');
  write('old name.txt', 'unchanged rename\n'); write('changed.txt', 'old\n'); write('deleted.txt', 'delete\n'); write('mode.sh', 'echo hi\n'); write('binary.bin', Buffer.from([0, 1]));
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  mkdirSync(path.join(cwd, '目录')); const renamed = '目录/新 "name"\t.txt';
  renameSync(path.join(cwd, 'old name.txt'), path.join(cwd, renamed)); git('add', '--', 'old name.txt', renamed);
  write('changed.txt', 'new\nextra\n'); unlinkSync(path.join(cwd, 'deleted.txt')); chmodSync(path.join(cwd, 'mode.sh'), 0o755); write('binary.bin', Buffer.from([0, 2]));
  write('草稿 a b\t.md', 'first\nsecond'); write('empty.txt', '');
  const indexBefore = git('ls-files', '--stage');
  const snapshot = await readEnvironmentSnapshot(cwd);
  const parsed = parseWorkspaceDiff(snapshot.diff);
  expect(parsed.files).toHaveLength(7);
  expect(parsed.added).toBe(snapshot.added); expect(parsed.removed).toBe(snapshot.removed);
  expect(parsed.files.find(file => file.path === renamed)).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', hunks: [] });
  expect(parsed.files.find(file => file.path === 'mode.sh')).toMatchObject({ status: 'mode', oldMode: '100644', newMode: '100755' });
  expect(parsed.files.find(file => file.path === 'binary.bin')).toMatchObject({ binary: true, added: 0, removed: 0 });
  const draft = parsed.files.find(file => file.path === '草稿 a b\t.md')!;
  expect(draft).toMatchObject({ status: 'added', added: 2 });
  expect(draft.hunks[0].lines[1]).toMatchObject({ content: 'second', noNewline: true, newNumber: 2 });
  expect(parsed.files.find(file => file.path === 'empty.txt')).toMatchObject({ status: 'added', hunks: [], added: 0 });
  expect(git('ls-files', '--stage')).toBe(indexBefore);
});
