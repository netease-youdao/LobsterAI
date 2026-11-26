import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

import { remoteFileLocalLimit } from '../../shared/remote/files';
import { type DeliveryRejectionDiagnostic, reportDeliveryRejection } from './remoteFileDiagnostics';

const MAX_DIRECTORY_ENTRIES = 256;
const MAX_ROOTS = 2;
const MAX_DELIVERY_DEPTH = 32;
export const REMOTE_DELIVERY_BASELINE_BUDGET_MS = 1000;
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
export async function captureDeliveryBaseline(roots: string[], current: () => boolean, observedBefore?: number, diagnostic?: DeliveryRejectionDiagnostic): Promise<DeliveryBaseline> {
  const directories: Array<DeliveryDirectory | undefined> = [];
  const deadline = performance.now() + REMOTE_DELIVERY_BASELINE_BUDGET_MS;
  let accepting = true;
  const active = (): boolean => accepting && performance.now() < deadline && permitted(current);
  const predatesDispatch = (stat: fs.Stats): boolean => observedBefore === undefined || stat.mtimeMs <= observedBefore && stat.ctimeMs <= observedBefore;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Each root makes independent progress: a slow cwd must not starve Desktop.
  // Keep one bounded deadline and accept only complete, unchanged directory scans.
  const scan = async (root: string, index: number): Promise<void> => {
    if (!active()) { reportDeliveryRejection(diagnostic, 'BASELINE_BUDGET_OR_CONTEXT_EXPIRED'); return; }
    try {
      const before = await fs.promises.lstat(root);
      if (!active() || !before.isDirectory() || before.isSymbolicLink() || !predatesDispatch(before)) {
        reportDeliveryRejection(diagnostic, !active() ? 'BASELINE_BUDGET_OR_CONTEXT_EXPIRED' : !predatesDispatch(before) ? 'ROOT_CHANGED_AFTER_DISPATCH' : 'ROOT_NOT_PLAIN_DIRECTORY'); return;
      }
      if (await fs.promises.realpath(root) !== root || !active()) { reportDeliveryRejection(diagnostic, 'ROOT_NOT_CANONICAL_OR_CONTEXT_EXPIRED'); return; }
      const files: Record<string, string | null> = Object.create(null);
      const directory = await fs.promises.opendir(root, { bufferSize: 32 });
      let count = 0;
      let complete = true;
      for await (const entry of directory) {
        if (!active() || ++count > MAX_DIRECTORY_ENTRIES) {
          reportDeliveryRejection(diagnostic, count > MAX_DIRECTORY_ENTRIES ? 'BASELINE_ENTRY_LIMIT' : 'BASELINE_BUDGET_OR_CONTEXT_EXPIRED'); complete = false; break;
        }
        if (remoteFileLocalLimit(entry.name, true) === null) continue;
        const stat = await fs.promises.lstat(path.join(root, entry.name));
        if (!active() || !predatesDispatch(stat)) {
          reportDeliveryRejection(diagnostic, !active() ? 'BASELINE_BUDGET_OR_CONTEXT_EXPIRED' : 'BASELINE_FILE_CHANGED_AFTER_DISPATCH'); complete = false; break;
        }
        files[entry.name] = stat.isFile() && !stat.isSymbolicLink() ? fileIdentity(stat) : null;
      }
      if (!complete || !active()) return;
      const after = await fs.promises.lstat(root);
      if (!active() || !after.isDirectory() || after.isSymbolicLink() || !predatesDispatch(after)
        || fileIdentity(before) !== fileIdentity(after) || await fs.promises.realpath(root) !== root || !active()) {
        reportDeliveryRejection(diagnostic, 'BASELINE_ROOT_CHANGED_OR_CONTEXT_EXPIRED'); return;
      }
      directories[index] = { path: root, identity: directoryIdentity(after), files };
    } catch { reportDeliveryRejection(diagnostic, 'BASELINE_IO_FAILED'); }
  };
  try {
    const selected = [...new Set(roots.slice(0, MAX_ROOTS).filter(value => path.isAbsolute(value)).map(value => path.resolve(value)))];
    await Promise.race([Promise.all(selected.map(scan)), new Promise<void>(resolve => { timer = setTimeout(resolve, REMOTE_DELIVERY_BASELINE_BUDGET_MS); })]);
  } finally {
    accepting = false;
    if (timer) clearTimeout(timer);
  }
  return { directories: permitted(current) ? directories.filter((value): value is DeliveryDirectory => value !== undefined) : [], current };
}

/** A receipt proves current stable bytes, never historical terminal bytes. Only an explicit MEDIA declaration may retain an unchanged baseline file. */
export async function changedDeliveredFile(baseline: DeliveryBaseline, filePath: string, finishedAt: number,
  current: () => boolean, allowUnchanged = false, diagnostic?: DeliveryRejectionDiagnostic): Promise<{
    filePath: string; identity: string; sizeBytes: string; directories: Array<{ path: string; identity: string }>;
  } | null> {
  const active = (): boolean => permitted(baseline.current) && permitted(current);
  if (!active() || !path.isAbsolute(filePath) || !Number.isFinite(finishedAt) || finishedAt <= 0)
    return reportDeliveryRejection(diagnostic, 'RECEIPT_CONTEXT_OR_ARGUMENT_INVALID');
  const resolved = path.resolve(filePath), root = path.dirname(resolved), name = path.basename(resolved);
  const directory = baseline.directories.find(item => item.path === root)
    ?? (allowUnchanged ? baseline.directories.find(item => {
      const relative = path.relative(item.path, root);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }) : undefined);
  const limit = remoteFileLocalLimit(name, true);
  if (!directory || !limit) return reportDeliveryRejection(diagnostic, !limit ? 'FILE_TYPE_NOT_ALLOWED' : 'FILE_OUTSIDE_CAPTURED_BASELINE');
  try {
    // Explicit MEDIA names one file; inspect only its ancestor chain, never scan a subtree.
    // Ordinary links still need the original direct-file baseline as producer evidence.
    const relative = path.relative(directory.path, root);
    const parts = relative ? relative.split(path.sep) : [];
    if (parts.length > MAX_DELIVERY_DEPTH) return reportDeliveryRejection(diagnostic, 'DIRECTORY_DEPTH_LIMIT');
    const directories: Array<{ path: string; identity: string }> = [];
    let parent = directory.path;
    for (let index = 0; index <= parts.length; index++) {
      if (index) parent = path.join(parent, parts[index - 1]);
      const stat = await fs.promises.lstat(parent);
      if (!active() || !stat.isDirectory() || stat.isSymbolicLink()
        || index === 0 && directoryIdentity(stat) !== directory.identity
        || await fs.promises.realpath(parent) !== parent || !active()) return reportDeliveryRejection(diagnostic, 'ANCESTOR_CHANGED_OR_CONTEXT_EXPIRED');
      directories.push({ path: parent, identity: directoryIdentity(stat) });
    }
    const stat = await fs.promises.lstat(resolved);
    if (!active() || !stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size)
      || stat.size < 1 || stat.size > limit || stat.mtimeMs > finishedAt || stat.ctimeMs > finishedAt)
      return reportDeliveryRejection(diagnostic, !active() ? 'RECEIPT_CONTEXT_EXPIRED' : stat.size < 1 || stat.size > limit ? 'FILE_SIZE_INVALID'
        : stat.mtimeMs > finishedAt || stat.ctimeMs > finishedAt ? 'FILE_CHANGED_AFTER_FINISH' : 'FILE_NOT_PLAIN_REGULAR');
    const identity = fileIdentity(stat);
    if (directory.path === root && Object.prototype.hasOwnProperty.call(directory.files, name)
      && (directory.files[name] === null || !allowUnchanged && directory.files[name] === identity))
      return reportDeliveryRejection(diagnostic, directory.files[name] === null ? 'BASELINE_FILE_NOT_REGULAR' : 'LINK_FILE_UNCHANGED');
    for (const parent of directories) {
      const after = await fs.promises.lstat(parent.path);
      if (!active() || !after.isDirectory() || after.isSymbolicLink() || directoryIdentity(after) !== parent.identity)
        return reportDeliveryRejection(diagnostic, 'ANCESTOR_RECHECK_FAILED');
    }
    if (await fs.promises.realpath(resolved) !== resolved || !active()
      || fileIdentity(await fs.promises.lstat(resolved)) !== identity || !active()) return reportDeliveryRejection(diagnostic, 'FILE_RECHECK_FAILED');
    return { filePath: resolved, identity, sizeBytes: String(stat.size), directories };
  } catch { return reportDeliveryRejection(diagnostic, 'RECEIPT_IO_FAILED'); }
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

/** Relative links gain authority only from visible, unquoted final-reply text. */
function relativeDeliveryText(content: string): string {
  const hiddenTags: string[] = [];
  let comment = false, quoted = false;
  return withoutCode(content).split(/\r?\n/u).map(line => {
    if (/^[ \t]*>/u.test(line)) { quoted = true; return ''; }
    if (!line.trim()) quoted = false;
    if (quoted) return '';
    const visible = !comment && !hiddenTags.length;
    let hasHiddenMarkup = false;
    for (const token of line.matchAll(/<!--|-->|<\/?(think|thinking|pre|code|blockquote)\b[^>]*>/giu)) {
      if (comment) { if (token[0] === '-->') comment = false; continue; }
      hasHiddenMarkup = true;
      if (token[0] === '<!--') { comment = true; continue; }
      if (token[0] === '-->') continue;
      const name = token[1].toLowerCase();
      if (!token[0].startsWith('</')) hiddenTags.push(name);
      else if (hiddenTags.at(-1) === name) hiddenTags.pop();
    }
    return visible && !comment && !hiddenTags.length && !hasHiddenMarkup ? line : '';
  }).join('\n');
}

export const RemoteFileDeliveryKind = { Link: 'link', Media: 'media' } as const;
export interface RemoteFileDelivery { filePath: string; kind: typeof RemoteFileDeliveryKind[keyof typeof RemoteFileDeliveryKind] }

function localDeliveryPath(target: string, markdown: boolean, cwd?: string): string | null {
  try {
    if (markdown && /%2f|%5c/iu.test(target)) return null;
    let filePath: string;
    if (/^file:/iu.test(target)) {
      const url = new URL(target);
      if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost') return null;
      filePath = fileURLToPath(url);
    } else {
      // MEDIA holds a literal filesystem path; percent escapes are meaningful only in a file URL/Markdown href.
      filePath = markdown ? decodeURIComponent(target) : target;
      if (/^(?:\/\/|\\\\|#)/u.test(filePath)) return null;
      if (!path.isAbsolute(filePath)) {
        if (!markdown || !cwd || !path.isAbsolute(cwd) || /^(?:\/\/|\\\\)/u.test(cwd) || /^[a-z][a-z0-9+.-]*:/iu.test(filePath)) return null;
        filePath = path.resolve(cwd, filePath);
      }
    }
    if (!path.isAbsolute(filePath) || /^(?:\/\/|\\\\)/u.test(filePath) || /[\u0000-\u001f\u007f]/u.test(filePath)) return null;
    return path.resolve(filePath);
  } catch { return null; }
}

/** Accept explicit standalone or sentence-final MEDIA directives outside examples, code and thinking. */
function mediaDeliveries(content: string): string[] {
  const files: string[] = [];
  let fence: string | undefined, code: string | undefined;
  const hiddenTags: string[] = [];
  let comment = false, quotedParagraph = false, blockquoteDepth = 0;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) quotedParagraph = false;
    else if (/^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t])/u.test(line)) quotedParagraph = true;
    const unquoted = line.replace(/^(?: {0,3}>[ \t]?)+/u, '');
    if (fence) {
      const closing = unquoted.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = unquoted.match(/^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})/u)?.[1];
    if (opening) { fence = opening; continue; }
    if (/^(?: {4}|\t)/u.test(unquoted)) continue;
    const visible = !code && !hiddenTags.length && !comment;
    let hasHiddenMarkup = false, hasBlockquote = blockquoteDepth > 0;
    for (const token of line.matchAll(/<!--|-->|`+|<\/?(think|thinking|pre|code|blockquote)\b[^>]*>/giu)) {
      if (comment) { if (token[0] === '-->') comment = false; continue; }
      if (token[0] === '<!--' && !code) { comment = true; hasHiddenMarkup = true; continue; }
      if (token[0] === '-->') continue;
      if (token[0][0] === '`') {
        if (hiddenTags.length) continue;
        if (code === token[0]) code = undefined;
        else if (!code) code = token[0];
      } else if (!code) {
        const name = token[1].toLowerCase();
        if (name === 'blockquote') {
          hasBlockquote = true;
          blockquoteDepth = token[0].startsWith('</') ? Math.max(0, blockquoteDepth - 1) : blockquoteDepth + 1;
          continue;
        }
        hasHiddenMarkup = true;
        if (!token[0].startsWith('</')) hiddenTags.push(name);
        else if (hiddenTags.at(-1) === name) hiddenTags.pop();
      }
    }
    if (!visible || code || hiddenTags.length || comment || hasHiddenMarkup) continue;
    if ((line.match(/MEDIA:/giu) || []).length !== 1) continue;
    let target = /^ {0,3}MEDIA:[ \t]*(.+?)[ \t]*$/iu.exec(line)?.[1];
    if (!target) {
      const inline = /^ {0,3}(.+[.!。！])[ \t]*MEDIA:[ \t]*(.+?)[ \t]*$/iu.exec(line);
      if (!inline || quotedParagraph || hasBlockquote || /^ {0,3}(?:\t|#{1,6}[ \t])/u.test(line)
        || !/[\p{L}\p{N}]/u.test(inline[1]) || /`|示例|例如|举例|\b(?:example|sample)\b/iu.test(inline[1])) continue;
      target = inline[2];
    }
    const quote = target[0], closing = quote === '<' ? '>' : quote;
    if (['`', '"', "'", '<'].includes(quote)) {
      if (target.length < 3 || !target.endsWith(closing)) continue;
      target = target.slice(1, -1);
    }
    if (target.includes('`')) continue;
    const filePath = localDeliveryPath(target, false);
    if (filePath && !files.includes(filePath)) files.push(filePath);
    if (files.length >= MAX_DELIVERED_FILES) break;
  }
  return files;
}

/** Explicit file/image links retain their changed-file policy; MEDIA additionally declares delivery of existing bytes. */
export function deliveredFileDeclarations(content: string, cwd?: string): RemoteFileDelivery[] {
  const declarations = new Map<string, RemoteFileDelivery>();
  for (const filePath of mediaDeliveries(content)) declarations.set(filePath, { filePath, kind: RemoteFileDeliveryKind.Media });
  const markdownLink = /(?<![!\\])(!?)\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^"'\r\n]*["'])?\s*\)/gu;
  const visibleRelativeLinks = new Set(cwd
    ? [...relativeDeliveryText(content).matchAll(markdownLink)].map(match => match[0]) : []);
  for (const match of withoutCode(content).matchAll(markdownLink)) {
    if (declarations.size >= MAX_DELIVERED_FILES) break;
    const target = match[2] || match[3];
    const filePath = localDeliveryPath(target, true, visibleRelativeLinks.has(match[0]) ? cwd : undefined);
    if (!filePath || match[1] && !IMAGE_DELIVERY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
    if (!declarations.has(filePath)) declarations.set(filePath, { filePath, kind: RemoteFileDeliveryKind.Link });
  }
  return [...declarations.values()];
}

export function deliveredFileLinks(content: string, cwd?: string): string[] {
  return deliveredFileDeclarations(content, cwd).map(value => value.filePath);
}
