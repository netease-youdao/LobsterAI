import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

import { remoteFileLocalLimit } from '../../shared/remote/files';

const MAX_DIRECTORY_ENTRIES = 256;
const MAX_ROOTS = 2;
const BASELINE_BUDGET_MS = 80;
const MAX_DELIVERED_FILES = 20;
const IMAGE_DELIVERY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const fileIdentity = (stat: fs.Stats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const directoryIdentity = (stat: fs.Stats): string => `${stat.dev}:${stat.ino}`;
const permitted = (current: () => boolean): boolean => {
  try { return current(); } catch { return false; }
};

interface DeliveryDirectory {
  path: string;
  identity: string;
  files: Readonly<Record<string, string | null>>;
}

export interface DeliveryBaseline {
  readonly directories: readonly DeliveryDirectory[];
  /** Captures the original account epoch and run, including across A -> B -> A switches. */
  readonly current: () => boolean;
}

/** Only complete, stable directory scans may establish that an output did not exist. */
export async function captureDeliveryBaseline(roots: string[], current: () => boolean): Promise<DeliveryBaseline> {
  const directories: DeliveryDirectory[] = [];
  const deadline = performance.now() + BASELINE_BUDGET_MS;
  let accepting = true;
  const active = (): boolean => accepting && performance.now() < deadline && permitted(current);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scan = async (): Promise<void> => {
    for (const root of new Set(roots.slice(0, MAX_ROOTS).filter(value => path.isAbsolute(value)).map(value => path.resolve(value)))) {
      if (!active()) break;
      try {
        const before = await fs.promises.lstat(root);
        if (!active() || !before.isDirectory() || before.isSymbolicLink()) continue;
        if (await fs.promises.realpath(root) !== root || !active()) continue;
        const files: Record<string, string | null> = Object.create(null);
        const directory = await fs.promises.opendir(root, { bufferSize: 32 });
        let count = 0;
        let complete = true;
        for await (const entry of directory) {
          if (!active() || ++count > MAX_DIRECTORY_ENTRIES) { complete = false; break; }
          if (remoteFileLocalLimit(entry.name, true) === null) continue;
          const stat = await fs.promises.lstat(path.join(root, entry.name));
          if (!active()) { complete = false; break; }
          files[entry.name] = stat.isFile() && !stat.isSymbolicLink() ? fileIdentity(stat) : null;
        }
        if (!complete || !active()) continue;
        const after = await fs.promises.lstat(root);
        if (!active() || !after.isDirectory() || after.isSymbolicLink()
          || fileIdentity(before) !== fileIdentity(after) || await fs.promises.realpath(root) !== root || !active()) continue;
        directories.push({ path: root, identity: directoryIdentity(after), files });
      } catch { /* Missing, inaccessible, or changing directories provide no discovery authority. */ }
    }
  };
  try {
    await Promise.race([scan(), new Promise<void>(resolve => { timer = setTimeout(resolve, BASELINE_BUDGET_MS); })]);
  } finally {
    accepting = false;
    if (timer) clearTimeout(timer);
  }
  return { directories: permitted(current) ? directories.slice() : [], current };
}

/** A receipt proves a changed, explicitly delivered current file, never historical terminal bytes. */
export async function changedDeliveredFile(baseline: DeliveryBaseline, filePath: string, finishedAt: number,
  current: () => boolean): Promise<{ filePath: string; identity: string; sizeBytes: string } | null> {
  const active = (): boolean => permitted(baseline.current) && permitted(current);
  if (!active() || !path.isAbsolute(filePath) || !Number.isFinite(finishedAt) || finishedAt <= 0) return null;
  const resolved = path.resolve(filePath), root = path.dirname(resolved), name = path.basename(resolved);
  const directory = baseline.directories.find(item => item.path === root);
  const limit = remoteFileLocalLimit(name, true);
  if (!directory || !limit) return null;
  try {
    const before = await fs.promises.lstat(root);
    if (!active() || !before.isDirectory() || before.isSymbolicLink() || directoryIdentity(before) !== directory.identity
      || await fs.promises.realpath(root) !== root || !active()) return null;
    const stat = await fs.promises.lstat(resolved);
    if (!active() || !stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size)
      || stat.size < 1 || stat.size > limit || stat.mtimeMs > finishedAt || stat.ctimeMs > finishedAt) return null;
    const identity = fileIdentity(stat);
    if (Object.prototype.hasOwnProperty.call(directory.files, name)
      && (directory.files[name] === null || directory.files[name] === identity)) return null;
    const after = await fs.promises.lstat(root);
    if (!active() || !after.isDirectory() || after.isSymbolicLink() || directoryIdentity(after) !== directory.identity
      || await fs.promises.realpath(resolved) !== resolved || !active()
      || fileIdentity(await fs.promises.lstat(resolved)) !== identity || !active()) return null;
    return { filePath: resolved, identity, sizeBytes: String(stat.size) };
  } catch { return null; }
}

/** Conservatively omit code examples; an unclosed fence or code span cannot declare a delivery. */
function withoutCode(content: string): string {
  let fence: string | undefined;
  const prose = content.split(/\r?\n/u).map(line => {
    const unquoted = line.replace(/^(?: {0,3}>[ \t]?)+/u, '');
    if (fence) {
      const closing = unquoted.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = undefined;
      return '';
    }
    const opening = unquoted.match(/^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})/u)?.[1];
    if (opening) { fence = opening; return ''; }
    return /^(?: {4}|\t)/u.test(unquoted) ? '' : line;
  }).join('\n');
  let result = '', cursor = 0;
  while (cursor < prose.length) {
    const start = prose.indexOf('`', cursor);
    if (start < 0) return result + prose.slice(cursor);
    result += prose.slice(cursor, start);
    let end = start + 1;
    while (prose[end] === '`') end++;
    const delimiter = prose.slice(start, end);
    let closing = prose.indexOf(delimiter, end);
    while (closing >= 0 && (prose[closing - 1] === '`' || prose[closing + delimiter.length] === '`')) {
      closing = prose.indexOf(delimiter, closing + delimiter.length);
    }
    if (closing < 0) return result;
    result += ' ';
    cursor = closing + delimiter.length;
  }
  return result;
}

/** Explicit file/image delivery links only; image syntax also requires an allowed local image extension. */
export function deliveredFileLinks(content: string): string[] {
  const links = new Set<string>();
  const markdownLink = /(?<![!\\])(!?)\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^"'\r\n]*["'])?\s*\)/gu;
  for (const match of withoutCode(content).matchAll(markdownLink)) {
    const target = match[2] || match[3];
    try {
      let filePath: string;
      if (/^file:/iu.test(target)) {
        const url = new URL(target);
        if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost') continue;
        filePath = fileURLToPath(url);
      } else {
        if (!path.isAbsolute(target) || target.startsWith('//') || /%2f|%5c/iu.test(target)) continue;
        filePath = decodeURIComponent(target);
      }
      if (!path.isAbsolute(filePath) || /[\u0000-\u001f\u007f]/u.test(filePath)) continue;
      if (match[1] && !IMAGE_DELIVERY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
      links.add(path.resolve(filePath));
      if (links.size >= MAX_DELIVERED_FILES) break;
    } catch { /* Invalid escapes and non-local file URLs cannot authorize a delivery. */ }
  }
  return [...links];
}
