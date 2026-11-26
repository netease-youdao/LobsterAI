// Pure Node.js POSIX ustar `.tar.gz` archive builder & streaming selective
// extractor (zero external `tar` binary dependency, identical behavior on
// macOS and Windows).

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export interface TarEntryInput {
  /** POSIX relative archive path (e.g. `metadata/user_plugins.json`). */
  archivePath: string;
  content: Buffer;
  mtimeMs?: number;
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const str = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  target.write(str.slice(-(length - 1)), offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function createUstarHeader(archivePath: string, size: number, mtimeSec: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const normalized = archivePath.replace(/\\/g, '/').replace(/^\/+/, '');
  let name = normalized;
  let prefix = '';
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      prefix = name.slice(0, slashIdx);
      name = name.slice(slashIdx + 1);
    }
    name = name.slice(-100);
    prefix = prefix.slice(-155);
  }

  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSec);
  header.fill(0x20, 148, 156); // checksum placeholder spaces
  header[156] = 0x30; // '0' regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) {
    header.write(prefix, 345, 155, 'utf8');
  }

  let checksum = 0;
  for (let i = 0; i < 512; i += 1) {
    checksum += header[i];
  }
  const chkStr = checksum.toString(8).padStart(6, '0');
  header.write(chkStr, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function collectDirectoryTarEntries(
  sourceDir: string,
  archivePrefix: string,
  maxSingleFileBytes = 50 * 1024 * 1024,
): TarEntryInput[] {
  const entries: TarEntryInput[] = [];
  if (!fs.existsSync(sourceDir)) return entries;

  const walk = (dir: string, relPrefix: string) => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      const nextRel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(fullPath, nextRel);
      } else if (dirent.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > maxSingleFileBytes) continue;
          entries.push({
            archivePath: archivePrefix ? `${archivePrefix}/${nextRel}` : nextRel,
            content: fs.readFileSync(fullPath),
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // Skip unreadable files without aborting backup.
        }
      }
    }
  };

  walk(sourceDir, '');
  return entries;
}

/**
 * Write a valid gzip-compressed POSIX ustar archive to `destPath` atomically.
 */
export function writeTarGzArchive(destPath: string, entries: TarEntryInput[]): number {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content;
    const mtimeSec = Math.floor((entry.mtimeMs ?? Date.now()) / 1000);
    chunks.push(createUstarHeader(entry.archivePath, content.byteLength, mtimeSec));
    if (content.byteLength > 0) {
      chunks.push(content);
      const remainder = content.byteLength % 512;
      if (remainder !== 0) {
        chunks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  // End-of-archive two 512-byte zero blocks.
  chunks.push(Buffer.alloc(1024, 0));

  const tarBuffer = Buffer.concat(chunks);
  const gzBuffer = zlib.gzipSync(tarBuffer, { level: 6 });

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, gzBuffer);
  fs.renameSync(tmpPath, destPath);
  return gzBuffer.byteLength;
}

function isAllZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function readNullTerminatedUtf8(buf: Buffer, start: number, end: number): string {
  let stop = start;
  while (stop < end && buf[stop] !== 0) {
    stop += 1;
  }
  return buf.subarray(start, stop).toString('utf8');
}

function readTarSize(header: Buffer): number {
  const firstByte = header[124];
  // GNU base-256 binary size encoding (for files >= 8 GiB).
  if ((firstByte & 0x80) !== 0) {
    let size = firstByte & 0x7f;
    for (let i = 125; i < 136; i += 1) {
      size = size * 256 + header[i];
    }
    return size;
  }
  const octal = readNullTerminatedUtf8(header, 124, 136).trim();
  if (!octal) return 0;
  const parsed = parseInt(octal, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parsePaxPath(paxBuffer: Buffer): string | null {
  const text = paxBuffer.toString('utf8');
  let cursor = 0;
  while (cursor < text.length) {
    const spaceIdx = text.indexOf(' ', cursor);
    if (spaceIdx === -1) break;
    const len = parseInt(text.slice(cursor, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(spaceIdx + 1, cursor + len).replace(/\n$/, '');
    cursor += len;
    if (record.startsWith('path=')) {
      return record.slice('path='.length);
    }
  }
  return null;
}

function normalizeArchiveEntryPath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function resolveSafeExtractionPath(resolvedDestDir: string, archivePath: string): string | null {
  const segments = archivePath.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((seg) => seg === '.' || seg === '..')) {
    return null;
  }
  const candidate = path.resolve(resolvedDestDir, ...segments);
  const relative = path.relative(resolvedDestDir, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

/**
 * Stream a `.tar.gz` archive and extract only regular file entries whose
 * normalized POSIX archive path matches `shouldExtract`.
 *
 * Uses constant O(64 KiB) memory so multi-gigabyte legacy backups can be
 * selectively read without external `tar` binaries or buffering in RAM.
 */
export function extractMatchingEntriesFromTarGz(
  archivePath: string,
  destDir: string,
  shouldExtract: (archivePath: string) => boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const resolvedDestDir = path.resolve(destDir);
    fs.mkdirSync(resolvedDestDir, { recursive: true });

    const extractedPaths: string[] = [];
    const headerBuf = Buffer.alloc(512);
    let headerFilled = 0;
    let mode: 'header' | 'data' | 'padding' | 'done' = 'header';
    let remainingData = 0;
    let remainingPadding = 0;
    let currentFd: number | null = null;
    let currentMetaType: 'L' | 'x' | null = null;
    let currentMetaChunks: Buffer[] | null = null;
    let pendingLongName: string | null = null;
    let pendingPaxPath: string | null = null;
    let settled = false;

    const closeCurrentFd = () => {
      if (currentFd !== null) {
        try {
          fs.closeSync(currentFd);
        } catch {
          // ignore close error
        }
        currentFd = null;
      }
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      closeCurrentFd();
      readStream.destroy();
      gunzip.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      closeCurrentFd();
      resolve(extractedPaths);
    };

    const readStream = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();

    readStream.on('error', fail);
    gunzip.on('error', fail);

    gunzip.on('data', (chunk: Buffer) => {
      if (settled || mode === 'done') return;
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (mode === 'header') {
            const need = 512 - headerFilled;
            const take = Math.min(need, chunk.length - offset);
            chunk.copy(headerBuf, headerFilled, offset, offset + take);
            headerFilled += take;
            offset += take;

            if (headerFilled === 512) {
              headerFilled = 0;
              if (isAllZeroBlock(headerBuf)) {
                mode = 'done';
                break;
              }

              const rawName = readNullTerminatedUtf8(headerBuf, 0, 100);
              const prefix = readNullTerminatedUtf8(headerBuf, 345, 500);
              const typeflag = headerBuf[156];
              const size = readTarSize(headerBuf);
              const pad = (512 - (size % 512)) % 512;

              if (typeflag === 0x4c || typeflag === 0x78) {
                currentMetaType = typeflag === 0x4c ? 'L' : 'x';
                currentMetaChunks = [];
                remainingData = size;
                remainingPadding = pad;
                mode = remainingData > 0 ? 'data' : (remainingPadding > 0 ? 'padding' : 'header');
                continue;
              }

              const fallbackName = prefix ? `${prefix}/${rawName}` : rawName;
              const entryPath = normalizeArchiveEntryPath(
                pendingPaxPath ?? pendingLongName ?? fallbackName,
              );
              if (typeflag !== 0x67) {
                pendingPaxPath = null;
                pendingLongName = null;
              }

              const isRegularFile = typeflag === 0x30 || typeflag === 0x00;
              if (isRegularFile && entryPath && shouldExtract(entryPath)) {
                const targetPath = resolveSafeExtractionPath(resolvedDestDir, entryPath);
                if (targetPath) {
                  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                  if (size === 0) {
                    fs.writeFileSync(targetPath, Buffer.alloc(0));
                  } else {
                    currentFd = fs.openSync(targetPath, 'w');
                  }
                  extractedPaths.push(entryPath);
                }
              }

              remainingData = size;
              remainingPadding = pad;
              mode = remainingData > 0 ? 'data' : (remainingPadding > 0 ? 'padding' : 'header');
            }
          } else if (mode === 'data') {
            const take = Math.min(remainingData, chunk.length - offset);
            if (currentFd !== null) {
              fs.writeSync(currentFd, chunk, offset, take);
            } else if (currentMetaChunks !== null) {
              currentMetaChunks.push(Buffer.from(chunk.subarray(offset, offset + take)));
            }
            offset += take;
            remainingData -= take;

            if (remainingData === 0) {
              closeCurrentFd();
              if (currentMetaChunks !== null) {
                const metaBuf = Buffer.concat(currentMetaChunks);
                if (currentMetaType === 'L') {
                  pendingLongName = readNullTerminatedUtf8(metaBuf, 0, metaBuf.length);
                } else if (currentMetaType === 'x') {
                  pendingPaxPath = parsePaxPath(metaBuf);
                }
                currentMetaChunks = null;
                currentMetaType = null;
              }
              mode = remainingPadding > 0 ? 'padding' : 'header';
            }
          } else if (mode === 'padding') {
            const skip = Math.min(remainingPadding, chunk.length - offset);
            offset += skip;
            remainingPadding -= skip;
            if (remainingPadding === 0) {
              mode = 'header';
            }
          }
        }
      } catch (err) {
        fail(err);
      }
    });

    gunzip.on('end', finish);
    readStream.pipe(gunzip);
  });
}
