export interface WorkspaceDiffLine {
  id: string;
  type: 'context' | 'add' | 'remove';
  content: string;
  oldNumber: number | null;
  newNumber: number | null;
  noNewline?: boolean;
  /** One-based physical line in the original patch, including metadata/preamble. */
  sourceLine?: number;
}

export interface WorkspaceDiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: WorkspaceDiffLine[];
  /** The available patch ended before all lines declared by this hunk arrived. */
  incomplete?: boolean;
}

export interface WorkspaceDiffFile {
  id: string;
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'mode';
  binary: boolean;
  hunks: WorkspaceDiffHunk[];
  /** Counts describe parsed text lines only; binary changes have no text line count. */
  added: number;
  removed: number;
  oldMode?: string;
  newMode?: string;
}

export interface WorkspaceDiffDocument {
  files: WorkspaceDiffFile[];
  added: number;
  removed: number;
}

interface PendingFile extends Omit<WorkspaceDiffFile, 'id' | 'path' | 'oldPath'> {
  before: string | null;
  after: string | null;
  hasOldHeader: boolean;
  hasNewHeader: boolean;
  fromGitHeader: boolean;
}

/** Git octal escapes encode UTF-8 bytes, not JavaScript character code points. */
function decodeQuotedPath(quoted: string): string {
  const bytes: number[] = [];
  let plain = '';
  const flush = () => { if (plain) { for (const byte of new TextEncoder().encode(plain)) bytes.push(byte); plain = ''; } };
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let index = 1; index < quoted.length - 1; index++) {
    if (quoted[index] !== '\\') { plain += quoted[index]; continue; }
    const next = quoted[++index];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      flush();
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(quoted[index + 1] ?? '')) octal += quoted[++index];
      bytes.push(parseInt(octal, 8) & 255);
    } else if (escapes[next] !== undefined) { flush(); bytes.push(escapes[next]); }
    else plain += `\\${next}`;
  }
  flush();
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function quotedToken(value: string): { value: string; length: number } | null {
  if (!value.startsWith('"')) return null;
  for (let index = 1; index < value.length; index++) {
    if (value[index] === '\\') { index++; continue; }
    if (value[index] === '"') return { value: decodeQuotedPath(value.slice(0, index + 1)), length: index + 1 };
  }
  return null;
}

function pathValue(value: string, stripPrefix: boolean, timestamp = false): string | null {
  const quoted = quotedToken(value);
  const decoded = quoted?.value ?? (timestamp ? value.split('\t')[0] : value);
  if (decoded === '/dev/null') return null;
  return stripPrefix ? decoded.replace(/^[ab]\//, '') : decoded;
}

function gitHeaderPaths(value: string): [string | null, string | null] {
  const first = quotedToken(value);
  if (first) return [pathValue(first.value, true), pathValue(value.slice(first.length).trimStart(), true)];
  // If only the destination is quoted, its opening quote is an unambiguous boundary.
  const quotedDestination = value.indexOf(' "');
  if (quotedDestination >= 0) return [pathValue(value.slice(0, quotedDestination), true), pathValue(value.slice(quotedDestination + 1), true)];
  // Git leaves ordinary spaces unquoted. Prefer the exact repeated path before
  // falling back to a/b prefixes; rename/copy headers subsequently refine both.
  const candidates = Array.from(value.matchAll(/ b\//g), match => match.index!);
  for (const index of candidates) {
    const before = pathValue(value.slice(0, index), true);
    const after = pathValue(value.slice(index + 1), true);
    if (before === after) return [before, after];
  }
  if (candidates.length) {
    const index = candidates[candidates.length - 1];
    return [pathValue(value.slice(0, index), true), pathValue(value.slice(index + 1), true)];
  }
  const middle = (value.length - 1) / 2;
  if (Number.isInteger(middle) && value[middle] === ' ' && value.slice(0, middle) === value.slice(middle + 1)) {
    return [value.slice(0, middle), value.slice(middle + 1)];
  }
  const space = value.indexOf(' ');
  return space < 0 ? [pathValue(value, true), pathValue(value, true)] : [pathValue(value.slice(0, space), true), pathValue(value.slice(space + 1), true)];
}

function stablePathId(path: string): string {
  try { return encodeURIComponent(path); }
  catch { return `utf16-${Array.from(path, char => char.codePointAt(0)!.toString(16)).join('-')}`; }
}

/** Read-only parser for Git/unified patches. Preamble, raw logs and binary payloads are not code lines. */
export function parseWorkspaceDiff(source: string): WorkspaceDiffDocument {
  const files: WorkspaceDiffFile[] = [];
  const occurrences = new Map<string, number>();
  let file: PendingFile | null = null;
  let hunk: WorkspaceDiffHunk | null = null;
  let oldNumber = 0; let newNumber = 0; let oldRemaining = 0; let newRemaining = 0;
  const finishHunk = () => {
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) hunk.incomplete = true;
    hunk = null;
  };
  const finishFile = () => {
    finishHunk();
    if (!file) return;
    const path = file.after ?? file.before;
    if (path !== null && path !== '' && (file.fromGitHeader || file.hasNewHeader)) {
      const identity = stablePathId(path);
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      const id = `diff:${identity}${occurrence > 1 ? `:${occurrence}` : ''}`;
      const status = file.status === 'modified' && !file.hunks.length && file.oldMode && file.newMode && file.oldMode !== file.newMode ? 'mode' : file.status;
      const item: WorkspaceDiffFile = { id, path, status, binary: file.binary, hunks: file.hunks, added: file.added, removed: file.removed,
        ...(file.before && file.before !== path ? { oldPath: file.before } : {}), ...(file.oldMode ? { oldMode: file.oldMode } : {}), ...(file.newMode ? { newMode: file.newMode } : {}) };
      const hunkOccurrences = new Map<string, number>();
      for (const block of item.hunks) {
        const range = `${block.oldStart}:${block.newStart}`;
        const nth = (hunkOccurrences.get(range) ?? 0) + 1;
        hunkOccurrences.set(range, nth);
        block.id = `${id}:hunk:${range}:${nth}`;
        block.lines.forEach((line, index) => { line.id = `${block.id}:line:${index}`; });
      }
      files.push(item);
    }
    file = null;
  };
  const createFile = (before: string | null, after: string | null, fromGitHeader = false): PendingFile => ({ before, after, hasOldHeader: false, hasNewHeader: false, fromGitHeader, status: 'modified', binary: false, hunks: [], added: 0, removed: 0 });

  for (const [sourceIndex, raw] of source.split('\n').entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) { finishFile(); file = createFile(...gitHeaderPaths(line.slice(11)), true); continue; }
    if (line === '\\ No newline at end of file') {
      const previous = hunk?.lines[hunk.lines.length - 1];
      if (previous) previous.noNewline = true;
      continue;
    }
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const prefix = raw[0];
      if ((prefix === ' ' && oldRemaining > 0 && newRemaining > 0) || (prefix === '-' && oldRemaining > 0) || (prefix === '+' && newRemaining > 0)) {
        const type = prefix === '+' ? 'add' : prefix === '-' ? 'remove' : 'context';
        hunk.lines.push({ id: '', type, content: raw.slice(1), oldNumber: type === 'add' ? null : oldNumber++, newNumber: type === 'remove' ? null : newNumber++, sourceLine: sourceIndex + 1 });
        if (type !== 'add') oldRemaining--;
        if (type !== 'remove') newRemaining--;
        if (type === 'add') file!.added++;
        if (type === 'remove') file!.removed++;
        continue;
      }
      finishHunk();
    }
    if (line.startsWith('--- ')) {
      if (file && (file.hasOldHeader || file.hunks.length)) finishFile();
      file ??= createFile(null, null);
      file.before = pathValue(line.slice(4), true, true); file.hasOldHeader = true;
      if (file.before === null) file.status = 'added';
      continue;
    }
    if (line.startsWith('+++ ') && file?.hasOldHeader) {
      file.after = pathValue(line.slice(4), true, true);
      file.hasNewHeader = true;
      if (file.after === null) file.status = 'deleted';
      continue;
    }
    if (!file) continue;
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/.exec(line);
    if (range) {
      finishHunk();
      const numbers = [Number(range[1]), range[2] === undefined ? 1 : Number(range[2]), Number(range[3]), range[4] === undefined ? 1 : Number(range[4])];
      if (!numbers.every(Number.isSafeInteger)) continue;
      [oldNumber, oldRemaining, newNumber, newRemaining] = numbers;
      hunk = { id: '', header: line, oldStart: oldNumber, oldLines: oldRemaining, newStart: newNumber, newLines: newRemaining, section: range[5] ?? '', lines: [] };
      file.hunks.push(hunk);
    } else if (line.startsWith('rename from ')) { file.before = pathValue(line.slice(12), false); file.status = 'renamed'; }
    else if (line.startsWith('rename to ')) { file.after = pathValue(line.slice(10), false); file.status = 'renamed'; }
    else if (line.startsWith('copy from ')) { file.before = pathValue(line.slice(10), false); file.status = 'copied'; }
    else if (line.startsWith('copy to ')) { file.after = pathValue(line.slice(8), false); file.status = 'copied'; }
    else if (/^new file mode \d+$/.test(line)) { file.newMode = line.slice(14); file.before = null; file.status = 'added'; }
    else if (/^deleted file mode \d+$/.test(line)) { file.oldMode = line.slice(18); file.after = null; file.status = 'deleted'; }
    else if (/^old mode \d+$/.test(line)) file.oldMode = line.slice(9);
    else if (/^new mode \d+$/.test(line)) file.newMode = line.slice(9);
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
  }
  finishFile();
  return { files, added: files.reduce((total, item) => total + item.added, 0), removed: files.reduce((total, item) => total + item.removed, 0) };
}
