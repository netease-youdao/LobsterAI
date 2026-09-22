import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { ReviewScope } from '../../shared/artifactPreview/reviewScopes';
import { ReviewSourceReason, ReviewSourceStatus } from '../../shared/artifactPreview/reviewSource';
import { artifactContentRevision } from '../../shared/artifactPreview/workspace';
import { parseWorkspaceDiff } from '../../shared/artifactPreview/workspaceDiff';
import { ScopedReviewStore } from './scopedReview';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cowork-scopes-')); dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.test'); git('config', 'user.name', 'QA');
  writeFileSync(path.join(cwd, 'code.ts'), 'const value = 1;\n'); git('add', '.'); git('commit', '-qm', 'initial');
  return { cwd, git, store: new ScopedReviewStore(id => id === 's' ? cwd : undefined) };
}
test('unstaged, staged, commit and branch retain exact matching dual-side source without mutating the index', async () => {
  const { cwd, git, store } = setup();
  writeFileSync(path.join(cwd, 'code.ts'), 'const value = 2;\n'); git('add', '.');
  writeFileSync(path.join(cwd, 'code.ts'), 'const value = 3;\n'); writeFileSync(path.join(cwd, 'fresh.html'), '<main>new</main>\n');
  const indexBefore = git('ls-files', '--stage');
  const unstaged = await store.create({ sessionId: 's', scope: ReviewScope.Unstaged });
  const staged = await store.create({ sessionId: 's', scope: ReviewScope.Staged });
  const source = async (artifact: typeof unstaged) => store.readSource({ sessionId: 's', artifactId: artifact.id, revision: artifactContentRevision(artifact), fileId: parseWorkspaceDiff(artifact.content).files.find(file => file.path === 'code.ts')!.id });
  expect(await source(unstaged)).toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: 'const value = 2;\n', newSource: 'const value = 3;\n' });
  expect(unstaged.workspaceChanges?.files.map(file => file.path)).toEqual(['code.ts', 'fresh.html']);
  expect(await source(staged)).toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: 'const value = 1;\n', newSource: 'const value = 2;\n' });
  expect(git('ls-files', '--stage')).toBe(indexBefore);
  git('commit', '-qm', 'second');
  const commit = await store.create({ sessionId: 's', scope: ReviewScope.Commit, reference: 'HEAD' });
  expect(await source(commit)).toMatchObject({ status: ReviewSourceStatus.Ready, oldSource: 'const value = 1;\n', newSource: 'const value = 2;\n' });
  const branch = await store.create({ sessionId: 's', scope: ReviewScope.Branch, reference: 'HEAD^' });
  expect(branch.content).toBe(commit.content);
  await expect(store.create({ sessionId: 's', scope: ReviewScope.Commit, reference: '--output=/tmp/foo' })).rejects.toThrow('Invalid');
});
test('a changed workspace rejects a stale source request; immutable commit reads remain valid', async () => {
  const { cwd, store } = setup();
  writeFileSync(path.join(cwd, 'code.ts'), 'const value = 4;\n');
  const artifact = await store.create({ sessionId: 's', scope: ReviewScope.Unstaged });
  const input = { sessionId: 's', artifactId: artifact.id, revision: artifactContentRevision(artifact), fileId: parseWorkspaceDiff(artifact.content).files[0].id };
  writeFileSync(path.join(cwd, 'code.ts'), 'const value = 5;\n');
  expect(await store.readSource(input)).toMatchObject({ status: ReviewSourceStatus.Unavailable, reason: ReviewSourceReason.RevisionMismatch });
  expect(await store.readSource({ ...input, sessionId: 'other' })).toMatchObject({ status: ReviewSourceStatus.Unavailable });
});
test('reopening a persisted scope after restart reloads explicitly and commits stay pinned to their SHA', async () => {
  const { cwd, git, store } = setup();
  const commit = await store.create({ sessionId: 's', scope: ReviewScope.Commit, reference: 'HEAD' });
  writeFileSync(path.join(cwd, 'code.ts'), 'const value = 8;\n'); git('add', '.'); git('commit', '-qm', 'later');
  const restarted = new ScopedReviewStore(id => id === 's' ? cwd : undefined);
  const restored = await restarted.resolve('s', commit.id);
  expect(restored?.id).toBe(commit.id); expect(restored?.content).toBe(commit.content); expect(restored?.contentVersion).toBe(commit.contentVersion);
  expect(restored?.workspaceChanges?.review?.refreshedOnRestore).toBe(true);
  const scope = await store.create({ sessionId: 's', scope: ReviewScope.Unstaged });
  writeFileSync(path.join(cwd, 'code.ts'), 'const value = 9;\n');
  const live = await restarted.resolve('s', scope.id);
  expect(live?.content).toContain('const value = 9;');
  expect(live?.workspaceChanges?.review?.refreshedOnRestore).toBe(true);
});
