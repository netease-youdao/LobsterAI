import { execFile } from 'child_process';
import { constants } from 'fs';
import { lstat, open, readlink } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';


const exec = promisify(execFile);
const MAX_FILES = 500;
const MAX_DIFF_LENGTH = 500_000;
const MAX_NEW_FILE_BYTES = 512_000;

type LineCounts = { added: number | null; removed: number | null };
interface StatusEntry { path: string; status: string }
export interface EnvironmentSnapshot {
  isGitRepository: boolean; cwd: string; branch: string | null; added: number; removed: number;
  baseRevision?: string | null;
  changedFiles: Array<StatusEntry & LineCounts>;
  /** Logical status entries before the review's file limit; a rename counts once. */
  totalChangedFiles?: number;
  /** At least one file's line counts could not be inspected. Binary counts remain null. */
  statsIncomplete?: boolean;
  diff: string; truncated: boolean;
}

function parseStatus(text: string): StatusEntry[] {
  const fields = text.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index++) {
    if (!fields[index]) continue;
    const status = fields[index].slice(0, 2);
    entries.push({ status, path: fields[index].slice(3) });
    // Porcelain -z emits destination first and a separate source for renames/copies.
    if (status.includes('R') || status.includes('C')) index++;
  }
  return entries;
}

function parseNumstat(text: string): Map<string, LineCounts> {
  const fields = text.split('\0');
  const counts = new Map<string, LineCounts>();
  for (let index = 0; index < fields.length; index++) {
    if (!fields[index]) continue;
    const field = fields[index];
    const first = field.indexOf('\t');
    const second = field.indexOf('\t', first + 1);
    const plus = field.slice(0, first);
    const minus = field.slice(first + 1, second);
    if (first < 0 || second < 0 || !/^(\d+|-)$/.test(plus) || !/^(\d+|-)$/.test(minus)) {
      throw new Error('Invalid Git numstat output');
    }
    let name = field.slice(second + 1);
    // Unlike status, numstat -z emits an empty path followed by source/destination.
    if (!name) { index += 2; name = fields[index]; }
    if (!name) throw new Error('Missing Git numstat path');
    counts.set(name, { added: plus === '-' ? null : Number(plus), removed: minus === '-' ? null : Number(minus) });
  }
  return counts;
}

function quotePatchPath(value: string): string {
  if (!/[\x00-\x20\x7f"\\]/.test(value)) return value;
  // Git uses C quoted paths, not JSON's \u0000 escapes.
  return JSON.stringify(value).replace(/\\u00([0-9a-f]{2})/gi, (_match, hex: string) => `\\${parseInt(hex, 16).toString(8).padStart(3, '0')}`);
}

function newFilePatch(name: string, data: Buffer, mode: string): { counts: LineCounts; diff: string } {
  const before = quotePatchPath(`a/${name}`);
  const after = quotePatchPath(`b/${name}`);
  const header = `diff --git ${before} ${after}\nnew file mode ${mode}\n`;
  if (data.includes(0)) return { counts: { added: null, removed: null }, diff: `${header}Binary files /dev/null and ${after} differ\n` };
  const text = data.toString('utf8');
  const finalNewline = text.endsWith('\n');
  const lines = text ? text.split('\n') : [];
  if (finalNewline) lines.pop();
  const diff = lines.length
    ? `${header}--- /dev/null\n+++ ${after}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join('')}${finalNewline ? '' : '\\ No newline at end of file\n'}`
    : header;
  return { counts: { added: lines.length, removed: 0 }, diff };
}

export async function inspectNewFile(root: string, entry: StatusEntry): Promise<{ counts: LineCounts; diff: string } | null> {
  // Git returns forward slashes on Windows; normalize before the containment check.
  root = path.resolve(root);
  const file = path.resolve(root, entry.path);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  const info = await lstat(file).catch((error: NodeJS.ErrnoException): null | undefined => {
    // A staged addition deleted from an unborn worktree has no content against the empty baseline.
    if (error.code === 'ENOENT' && entry.status !== '??') return undefined;
    return null;
  });
  if (info === undefined) return { counts: { added: 0, removed: 0 }, diff: '' };
  if (!info) return null;
  if (info.isSymbolicLink()) {
    const target = await readlink(file, { encoding: 'buffer' }).catch((): null => null);
    return target ? newFilePatch(entry.path, target, '120000') : null;
  }
  if (!info.isFile() || info.size > MAX_NEW_FILE_BYTES) return null;
  // Do not follow a symlink if the file is replaced between lstat and opening it.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((): null => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    // Bound the read even if the file grows after lstat.
    const buffer = Buffer.alloc(MAX_NEW_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > MAX_NEW_FILE_BYTES ? null : newFilePatch(entry.path, buffer.subarray(0, length), info.mode & 0o111 ? '100755' : '100644');
  } catch { return null; } finally { await handle.close(); }
}

export async function readEnvironmentSnapshot(cwd: string): Promise<EnvironmentSnapshot> {
  const empty: EnvironmentSnapshot = { isGitRepository: false, cwd, branch: null, added: 0, removed: 0, changedFiles: [], totalChangedFiles: 0, statsIncomplete: false, diff: '', truncated: false };
  const git = async (...args: string[]) => (await exec('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' } })).stdout;
  try { if ((await git('rev-parse', '--is-inside-work-tree')).trim() !== 'true') return empty; } catch { return empty; }
  const root = (await git('rev-parse', '--show-toplevel')).trim();
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => git('symbolic-ref', '--short', 'HEAD'))).trim();
  const baseRevision = await git('rev-parse', '--verify', 'HEAD').then(value => value.trim(), (): null => null);
  const hasHead = baseRevision !== null;
  let truncated = false;
  const [statusText, numstat, trackedDiff] = await Promise.all([
    git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--find-renames'),
    baseRevision ? git('diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', baseRevision) : '',
    baseRevision ? git('diff', '--no-ext-diff', '--no-textconv', '--find-renames', baseRevision).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && 'stdout' in error && typeof error.stdout === 'string') {
        truncated = true;
        return error.stdout;
      }
      throw error;
    }) : '',
  ]);
  const counts = parseNumstat(numstat);
  let added = 0; let removed = 0;
  for (const item of counts.values()) { added += item.added ?? 0; removed += item.removed ?? 0; }
  let diff = '';
  const appendDiff = (content: string) => {
    if (content.length > MAX_DIFF_LENGTH - diff.length) truncated = true;
    diff += content.slice(0, MAX_DIFF_LENGTH - diff.length);
  };
  appendDiff(trackedDiff);
  const entries = parseStatus(statusText);
  const changedFiles: EnvironmentSnapshot['changedFiles'] = [];
  let statsIncomplete = false;
  for (const entry of entries) {
    const needsWorktreeRead = !hasHead || entry.status === '??';
    if (changedFiles.length >= MAX_FILES) {
      truncated = true;
      if (needsWorktreeRead) statsIncomplete = true;
      continue;
    }
    let item = counts.get(entry.path) ?? { added: 0, removed: 0 };
    if (needsWorktreeRead) {
      // Without HEAD all current files are additions against an empty baseline. Reading
      // them directly includes unstaged edits without writing an alternate index/tree.
      const inspected = await inspectNewFile(root, entry);
      if (inspected) {
        item = inspected.counts;
        added += item.added ?? 0; removed += item.removed ?? 0;
        appendDiff(inspected.diff);
      } else {
        item = { added: null, removed: null };
        statsIncomplete = true; truncated = true;
      }
    }
    changedFiles.push({ ...entry, ...item });
  }
  return { isGitRepository: true, cwd: root, branch, baseRevision, added, removed, changedFiles, totalChangedFiles: entries.length, statsIncomplete, diff, truncated };
}
