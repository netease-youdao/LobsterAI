import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync,rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { ReviewSourceReason, ReviewSourceStatus } from '../../shared/artifactPreview/reviewSource';
import { artifactContentRevision } from '../../shared/artifactPreview/workspace';
import { buildWorkspaceChangesArtifact } from '../../shared/artifactPreview/workspaceChanges';
import { parseWorkspaceDiff } from '../../shared/artifactPreview/workspaceDiff';
import { readEnvironmentSnapshot } from './environmentSnapshot';
import { WorkspaceReviewSourceStore } from './reviewSource';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const directories: string[] = [];
afterEach(() => { for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true }); });
function repo() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cowork-review-source-')); directories.push(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const write = (name: string, content: string | Buffer) => writeFileSync(path.join(cwd, name), content);
  git('init', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA');
  const commit = () => { git('add', '.'); git('commit', '-m', 'fixture'); };
  const request = async (name: string) => {
    const snapshot = await readEnvironmentSnapshot(cwd);
    const artifact = buildWorkspaceChangesArtifact('qa', '', snapshot);
    return { sessionId: 'qa', artifactId: artifact.id, revision: artifactContentRevision(artifact), fileId: parseWorkspaceDiff(snapshot.diff).files.find(file => file.path === name)!.id };
  };
  return { cwd, git, write, commit, request, store: new WorkspaceReviewSourceStore(id => id === 'qa' ? cwd : undefined) };
}

test('reads complete old/new HTML around disjoint hunks and leaves the index untouched', async () => {
  const r = repo();
  const before = '<html>\n<style>\n/* block start\n' + Array.from({ length: 50 }, (_, i) => `context ${i}\n`).join('') + '*/\n</style>\n<script>const s = `hello\nworld`;</script>\n</html>\n';
  const after = before.replace('context 3\n', 'changed 3\n').replace('context 42\n', 'changed 42\n');
  r.write('index.html', before); r.commit(); r.write('index.html', after);
  const index = r.git('ls-files', '--stage'); const value = await r.store.read(await r.request('index.html'));
  expect(value).toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: before, newSource: after, oldPath: 'index.html', newPath: 'index.html' });
  expect(r.git('ls-files', '--stage')).toBe(index);
});
test('binds both rename extensions and preserves CRLF and BOM exactly', async () => {
  const r = repo(); const before = '\ufefflet n = 1;\r\n// keep\r\n';
  r.write('before.js', before); r.commit(); r.git('mv', 'before.js', 'after.ts');
  expect(await r.store.read(await r.request('after.ts'))).toMatchObject({ status: ReviewSourceStatus.Ready, oldPath: 'before.js', newPath: 'after.ts', oldSource: before, newSource: before });
});
test('uses empty absent sides for new and deleted files and does not follow symlinks', async () => {
  const r = repo(); r.write('deleted.txt', 'old\n'); r.commit(); r.git('rm', 'deleted.txt'); r.write('new.html', '<script>window.PWNED=1</script>\n');
  symlinkSync('/etc/hosts', path.join(r.cwd, 'link'));
  expect(await r.store.read(await r.request('deleted.txt'))).toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: 'old\n', newSource: '' });
  expect(await r.store.read(await r.request('new.html'))).toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: '', newSource: '<script>window.PWNED=1</script>\n' });
  expect(await r.store.read(await r.request('link'))).toMatchObject({ status: ReviewSourceStatus.Ready, newSource: '/etc/hosts' });
});
test('rejects wrong sessions, file IDs and uncached stale revisions; cached data remains the exact old revision', async () => {
  const r = repo(); r.write('a.txt', 'old\n'); r.commit(); r.write('a.txt', 'one\n');
  const request = await r.request('a.txt'); const accepted = await r.store.read(request);
  r.write('a.txt', 'two\n');
  expect(await r.store.read(request)).toEqual(accepted);
  expect(await new WorkspaceReviewSourceStore(() => r.cwd).read(request)).toMatchObject({ status: ReviewSourceStatus.Unavailable, reason: ReviewSourceReason.RevisionMismatch });
  expect(await r.store.read({ ...request, sessionId: 'other' })).toMatchObject({ status: ReviewSourceStatus.Unavailable });
  expect(await r.store.read({ ...await r.request('a.txt'), fileId: '../../etc/passwd' })).toMatchObject({ reason: ReviewSourceReason.NotFound });
});
test('detects a file changed during reading and refuses truncated source revisions', async () => {
  const r = repo(); r.write('a.txt', 'old\n'); r.commit(); r.write('a.txt', 'one\n'); const request = await r.request('a.txt');
  let calls = 0;
  const racing = new WorkspaceReviewSourceStore(() => r.cwd, async cwd => {
    if (++calls === 2) r.write('a.txt', 'two\n');
    return readEnvironmentSnapshot(cwd);
  });
  expect(await racing.read(request)).toMatchObject({ reason: ReviewSourceReason.RevisionMismatch });
  const truncated = new WorkspaceReviewSourceStore(() => r.cwd, async cwd => ({ ...await readEnvironmentSnapshot(cwd), truncated: true }));
  expect(await truncated.read(await r.request('a.txt'))).toMatchObject({ reason: ReviewSourceReason.TooLarge });
});
test('returns plain-text fallbacks for binary and full-source limit without parsing partial hunks', async () => {
  const r = repo(); r.write('large.txt', 'line\n'.repeat(410_000)); r.write('a.bin', Buffer.from([0, 1])); r.commit();
  r.write('large.txt', 'LINE\n' + 'line\n'.repeat(409_999)); r.write('a.bin', Buffer.from([0, 2]));
  expect(await r.store.read(await r.request('large.txt'))).toMatchObject({ reason: ReviewSourceReason.TooLarge });
  expect(await r.store.read(await r.request('a.bin'))).toMatchObject({ reason: ReviewSourceReason.Binary });
});

test('a file read after another file starts its verification cannot reuse that older in-flight snapshot', async () => {
  const r = repo();
  mkdirSync(path.join(r.cwd, 'slow'));
  const before = Array.from({ length: 100 }, (_, index) => `// context ${index}`);
  before[0] = '/* comment starts'; before[20] = '*/'; before[70] = 'const value = 1;';
  r.write('slow/a.ts', before.join('\n')); r.write('b.ts', 'const fast = 1;\n'); r.commit();
  const reviewed = [...before]; reviewed[70] = 'const value = 2;';
  r.write('slow/a.ts', reviewed.join('\n')); r.write('b.ts', 'const fast = 2;\n');
  const baseline = await readEnvironmentSnapshot(r.cwd);
  const requests = await Promise.all([r.request('b.ts'), r.request('slow/a.ts')]);
  const slowDirectory = realpathSync(path.join(r.cwd, 'slow'));
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let releaseSlow!: () => void;
  let slowHasPaused!: () => void;
  const paused = new Promise<void>(resolve => { slowHasPaused = resolve; });
  let wasPaused = false;
  vi.mocked(realpath).mockImplementation(async (file, options) => {
    if (file === slowDirectory && !wasPaused) {
      wasPaused = true;
      await new Promise<void>(resolve => { releaseSlow = resolve; slowHasPaused(); });
    }
    return actual.realpath(file, options);
  });
  let releaseOlderSnapshot!: (snapshot: typeof baseline) => void;
  let snapshots = 0;
  const store = new WorkspaceReviewSourceStore(() => r.cwd, async cwd => {
    snapshots += 1;
    if (snapshots === 1) return baseline;
    if (snapshots === 2) {
      // Fast file B captured its verification before A's complete worktree read.
      const older = new Promise<typeof baseline>(resolve => { releaseOlderSnapshot = resolve; });
      await paused;
      const changed = [...reviewed]; changed[20] = '// comment no longer closes';
      r.write('slow/a.ts', changed.join('\n'));
      releaseSlow();
      return older;
    }
    const fresh = await readEnvironmentSnapshot(cwd);
    releaseOlderSnapshot(baseline);
    return fresh;
  });
  const snapshotReader = store as unknown as { readSnapshot(cwd: string): Promise<typeof baseline> };
  const originalRead = snapshotReader.readSnapshot.bind(store);
  let snapshotReads = 0;
  const reader = vi.spyOn(snapshotReader, 'readSnapshot').mockImplementation(cwd => {
    snapshotReads += 1;
    const snapshot = originalRead(cwd);
    // The former implementation enters this path and reuses B's stale in-flight
    // verification. Release it only after A has finished reading its new source.
    if (snapshotReads === 4) releaseOlderSnapshot(baseline);
    return snapshot;
  });
  try {
    const [fast, slow] = await Promise.all(requests.map(request => store.read(request)));
    expect(fast.status).toBe(ReviewSourceStatus.Ready);
    expect(slow).toMatchObject({ status: ReviewSourceStatus.Unavailable, reason: ReviewSourceReason.RevisionMismatch });
    expect(snapshotReads).toBe(2); // Only the initial reads are coalesced.
  } finally {
    reader.mockRestore();
    vi.mocked(realpath).mockImplementation(actual.realpath);
  }
});
