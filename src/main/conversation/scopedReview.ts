import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { ReviewScope, type ReviewScopeRequest,SCOPED_REVIEW_PREFIX } from '../../shared/artifactPreview/reviewScopes';
import { ReviewSourceReason, type ReviewSourceRequest, type ReviewSourceResponse,ReviewSourceStatus } from '../../shared/artifactPreview/reviewSource';
import { artifactContentRevision, type ResolvedArtifactOutput } from '../../shared/artifactPreview/workspace';
import { parseWorkspaceDiff } from '../../shared/artifactPreview/workspaceDiff';
import { inspectNewFile } from './environmentSnapshot';
import { matchesPatch, readGitFile, readWorktreeFile } from './reviewSource';
const exec = promisify(execFile);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_REVIEWS = 24;
const MAX_SOURCE_CACHE = 16_000_000;
type Capture = { artifact: ResolvedArtifactOutput; cwd: string; sessionCwd: string; guard: string; oldRef: string | null; newRef: string | null; request: ReviewScopeRequest };
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
export function isScopedReview(id: string): boolean { return id.startsWith(SCOPED_REVIEW_PREFIX); }
export class ScopedReviewStore {
  private captures = new Map<string, Capture>();
  private sourceCache = new Map<string, Extract<ReviewSourceResponse, { status: 'ready' }>>();
  constructor(private getCwd: (sessionId: string) => string | undefined) {}
  private git(cwd: string, args: string[]) {
    return exec('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: 8000, maxBuffer: 2_100_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' } }).then(value => value.stdout);
  }
  private async resolveRef(cwd: string, ref: string): Promise<string> {
    if (!ref || ref.length > 256 || ref.startsWith('-') || /[\x00-\x20]/.test(ref)) throw new Error('Invalid review reference');
    return (await this.git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  }
  private key(sessionId: string, id: string) { return JSON.stringify([sessionId, id]); }
  async create(input: ReviewScopeRequest): Promise<ResolvedArtifactOutput> {
    const cwd = this.getCwd(input.sessionId); if (!cwd) throw new Error('Review session is unavailable');
    if (![ReviewScope.Unstaged, ReviewScope.Staged, ReviewScope.Branch, ReviewScope.Commit].includes(input.scope as never)) throw new Error('Unsupported review scope');
    const reference = input.reference?.trim();
    const root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const head = await this.resolveRef(root, 'HEAD').catch((): null => null);
    let oldRef: string | null = head; let newRef: string | null = null; let refs: string[] = [];
    if (input.scope === ReviewScope.Unstaged) { oldRef = ''; refs = []; }
    if (input.scope === ReviewScope.Staged) { newRef = ''; refs = ['--cached', head ?? EMPTY_TREE]; }
    if (input.scope === ReviewScope.Commit) {
      newRef = await this.resolveRef(root, reference || 'HEAD');
      oldRef = await this.resolveRef(root, `${newRef}^`).catch((): null => null); refs = [oldRef ?? EMPTY_TREE, newRef];
    }
    if (input.scope === ReviewScope.Branch) {
      if (!head) throw new Error('Branch review requires a commit');
      const baseName = reference || (await this.git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
      if (!baseName) throw new Error('Choose a base branch for review');
      const base = await this.resolveRef(root, baseName);
      oldRef = (await this.git(root, ['merge-base', base, head])).trim(); newRef = head; refs = [oldRef, newRef];
    }
    const index = oldRef === '' || newRef === '' ? await this.git(root, ['ls-files', '--stage', '-z']) : '';
    let diff = await this.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', ...refs, '--']);
    if (input.scope === ReviewScope.Unstaged) {
      const untracked = (await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      if (untracked.length > 500) throw new Error('Review is too large; choose a narrower scope');
      for (const name of untracked) { const entry = await inspectNewFile(root, { path: name, status: '??' }); if (!entry) throw new Error('Untracked file cannot be read safely'); diff += entry.diff; }
    }
    if ((oldRef === '' || newRef === '') && index !== await this.git(root, ['ls-files', '--stage', '-z'])) throw new Error('Review changed while reading; refresh');
    const parsed = parseWorkspaceDiff(diff); if (parsed.files.length > 500 || diff.length > 500_000) throw new Error('Review is too large; choose a narrower scope');
    const id = `${SCOPED_REVIEW_PREFIX}${input.scope}:${encodeURIComponent(input.scope === ReviewScope.Commit ? newRef || '' : reference || '')}`;
    const review = { scope: input.scope, reference: input.scope === ReviewScope.Commit ? newRef || reference : reference, baseRevision: oldRef, targetRevision: newRef };
    const signature = fingerprint(JSON.stringify(review) + index + diff);
    const artifact: ResolvedArtifactOutput = { id, sessionId: input.sessionId, messageId: id, type: 'code', language: 'diff', title: input.scope,
      createdAt: Date.now(), content: diff, contentVersion: Number.parseInt(signature.slice(0, 12), 16),
      workspaceChanges: { cwd: root, branch: (await this.git(root, ['branch', '--show-current'])).trim() || null, review,
        baseRevision: oldRef, added: parsed.added, removed: parsed.removed, totalChangedFiles: parsed.files.length, truncated: false, statsIncomplete: false,
        files: parsed.files.map(file => ({ path: file.path, status: file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M', added: file.binary ? null : file.added, removed: file.binary ? null : file.removed })) } };
    const key = this.key(input.sessionId, id); this.captures.delete(key); this.captures.set(key, { artifact, cwd: root, sessionCwd: cwd, guard: fingerprint(index + diff), oldRef, newRef, request: { ...input, reference } });
    while (this.captures.size > MAX_REVIEWS) this.captures.delete(this.captures.keys().next().value!);
    return artifact;
  }
  async resolve(sessionId: string, id: string): Promise<ResolvedArtifactOutput | null> {
    if (!isScopedReview(id)) return null;
    const cached = this.captures.get(this.key(sessionId, id)); if (cached) return cached.artifact;
    const match = id.slice(SCOPED_REVIEW_PREFIX.length).match(/^([^:]+):(.*)$/); if (!match) return null;
    try {
      const restored = await this.create({ sessionId, scope: match[1] as ReviewScope, reference: decodeURIComponent(match[2]) });
      if (restored.workspaceChanges?.review) restored.workspaceChanges.review.refreshedOnRestore = true;
      return restored;
    } catch { return null; }
  }
  async readSource(input: ReviewSourceRequest): Promise<ReviewSourceResponse> {
    const unavailable = (reason: typeof ReviewSourceReason[keyof typeof ReviewSourceReason]): ReviewSourceResponse => ({ ...input, status: ReviewSourceStatus.Unavailable, reason });
    const key = this.key(input.sessionId, input.artifactId); const capture = this.captures.get(key);
    if (!capture || this.getCwd(input.sessionId) !== capture.sessionCwd) return unavailable(ReviewSourceReason.NotFound);
    if (artifactContentRevision(capture.artifact) !== input.revision) return unavailable(ReviewSourceReason.RevisionMismatch);
    const cacheKey = JSON.stringify(input); const cached = this.sourceCache.get(cacheKey); if (cached) return cached;
    const file = parseWorkspaceDiff(capture.artifact.content).files.find(item => item.id === input.fileId);
    if (!file) return unavailable(ReviewSourceReason.NotFound); if (file.binary) return unavailable(ReviewSourceReason.Binary);
    try {
      const oldPath = file.oldPath ?? file.path; const newPath = file.path;
      const [oldSource, newSource] = await Promise.all([
        file.status === 'added' || capture.oldRef === null ? '' : readGitFile(capture.cwd, capture.oldRef, oldPath),
        file.status === 'deleted' ? '' : capture.newRef === null ? readWorktreeFile(capture.cwd, newPath) : readGitFile(capture.cwd, capture.newRef, newPath),
      ]);
      if (!matchesPatch(file, oldSource, newSource)) return unavailable(ReviewSourceReason.RevisionMismatch);
      if (capture.oldRef === '' || capture.newRef === '' || capture.newRef === null) {
        const current = await this.create(capture.request);
        if (artifactContentRevision(current) !== input.revision) return unavailable(ReviewSourceReason.RevisionMismatch);
      }
      const value: Extract<ReviewSourceResponse, { status: 'ready' }> = { ...input, status: ReviewSourceStatus.Ready, path: file.path, oldPath, newPath, oldSource, newSource };
      this.sourceCache.set(cacheKey, value);
      let bytes = [...this.sourceCache.values()].reduce((sum, item) => sum + Buffer.byteLength(item.oldSource) + Buffer.byteLength(item.newSource), 0);
      while (bytes > MAX_SOURCE_CACHE || this.sourceCache.size > 32) { const oldest = this.sourceCache.keys().next().value!; const value = this.sourceCache.get(oldest)!; bytes -= Buffer.byteLength(value.oldSource) + Buffer.byteLength(value.newSource); this.sourceCache.delete(oldest); }
      return value;
    } catch { return unavailable(ReviewSourceReason.RevisionMismatch); }
  }
}
