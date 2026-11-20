// Pure Node.js POSIX ustar `.tar.gz` archive builder (zero external `tar`
// binary dependency, identical behavior on macOS and Windows).

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
