#!/usr/bin/env node

/**
 * Windows post-install resource tar extractor.
 *
 * Invoked by NSIS scripts/nsis-installer.nsh customInstall via LobsterAI.exe
 * with ELECTRON_RUN_AS_NODE=1 when system bsdtar is unavailable or fails.
 *
 * Usage: LobsterAI.exe unpack-dsh-resources.cjs <tarPath> <destDir> [installLogPath]
 *
 * Extracts:
 *   - dsh-runtime/  (DeepSeek Harness bundled runtime)
 *   - dsh-bundles/  (@lobsterai/dsh-host + @lobsterai/dsh-channels)
 *   - SKILLs/       (bundled skills)
 *   - python-win/   (portable Python runtime)
 *
 * Writes <destDir>/.unpack-dsh-ok sentinel only after all required directories
 * and runtime entry files are verified present on disk.
 */

const fs = require('fs');
const path = require('path');

const TAR_BLOCK_SIZE = 512;
const TAR_READ_BUFFER_SIZE = 256 * 1024;

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function stringifyError(error) {
  if (!error) return 'unknown error';
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function isAllZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function readNullTerminatedUtf8(buf, start, end) {
  let stop = start;
  while (stop < end && buf[stop] !== 0) {
    stop += 1;
  }
  return buf.subarray(start, stop).toString('utf8');
}

function readNullTerminatedAscii(buf, start, end) {
  let stop = start;
  while (stop < end && buf[stop] !== 0) {
    stop += 1;
  }
  return buf.subarray(start, stop).toString('ascii');
}

function readTarOctal(header, start, end) {
  const raw = readNullTerminatedAscii(header, start, end).trim();
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function readTarSize(header) {
  const firstByte = header[124];
  // GNU base-256 binary encoding (high bit set) for files >= 8 GiB.
  if ((firstByte & 0x80) !== 0) {
    let size = firstByte & 0x7f;
    for (let i = 125; i < 136; i += 1) {
      size = size * 256 + header[i];
    }
    return size;
  }
  return readTarOctal(header, 124, 136);
}

function verifyTarChecksum(header) {
  const storedRaw = readNullTerminatedAscii(header, 148, 156).trim();
  if (!storedRaw) return false;
  const stored = parseInt(storedRaw, 8);
  if (!Number.isFinite(stored)) return false;

  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    const byte = (i >= 148 && i < 156) ? 0x20 : header[i];
    unsignedSum += byte;
    signedSum += byte < 128 ? byte : byte - 256;
  }
  return stored === unsignedSum || stored === signedSum;
}

/**
 * Parse POSIX.1-2001 PAX extended header records (`<byteLen> <key>=<value>\n`)
 * using raw UTF-8 byte offsets so multi-byte filenames never misalign.
 */
function parsePaxRecords(buf) {
  const records = {};
  let offset = 0;
  while (offset < buf.length) {
    const spaceIdx = buf.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const recordLen = parseInt(buf.subarray(offset, spaceIdx).toString('ascii'), 10);
    if (!Number.isFinite(recordLen) || recordLen <= 0 || offset + recordLen > buf.length) {
      break;
    }
    let end = offset + recordLen;
    if (end > spaceIdx + 1 && buf[end - 1] === 0x0a) {
      end -= 1;
    }
    const eqIdx = buf.indexOf(0x3d, spaceIdx + 1);
    if (eqIdx !== -1 && eqIdx < end) {
      const key = buf.subarray(spaceIdx + 1, eqIdx).toString('utf8');
      const value = buf.subarray(eqIdx + 1, end).toString('utf8');
      records[key] = value;
    }
    offset += recordLen;
  }
  return records;
}

function normalizeArchiveEntryPath(rawPath) {
  const unified = String(rawPath || '').replace(/\\/g, '/');
  const rawSegments = unified.split('/');
  const cleanSegments = [];
  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new Error(`Refusing to extract archive path with parent traversal: ${rawPath}`);
    }
    cleanSegments.push(segment);
  }
  return cleanSegments.join('/');
}

function resolveSafeExtractionPath(resolvedDestDir, normalizedPath) {
  if (!normalizedPath) return null;
  const candidate = path.resolve(resolvedDestDir, ...normalizedPath.split('/'));
  const relative = path.relative(resolvedDestDir, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to extract path outside destination: ${normalizedPath}`);
  }
  return candidate;
}

function createBufferedTarReader(tarPath) {
  const fd = fs.openSync(tarPath, 'r');
  const buf = Buffer.allocUnsafe(TAR_READ_BUFFER_SIZE);
  let bufStart = 0;
  let bufEnd = 0;
  let bytesReadTotal = 0;

  const refill = () => {
    bufStart = 0;
    bufEnd = fs.readSync(fd, buf, 0, buf.length, null);
    return bufEnd > 0;
  };

  return {
    getOffset() {
      return bytesReadTotal;
    },
    readBlock(target) {
      let filled = 0;
      while (filled < TAR_BLOCK_SIZE) {
        if (bufStart === bufEnd && !refill()) {
          break;
        }
        const take = Math.min(TAR_BLOCK_SIZE - filled, bufEnd - bufStart);
        buf.copy(target, filled, bufStart, bufStart + take);
        bufStart += take;
        filled += take;
        bytesReadTotal += take;
      }
      return filled;
    },
    readBytes(length) {
      const out = Buffer.allocUnsafe(length);
      let written = 0;
      while (written < length) {
        if (bufStart === bufEnd && !refill()) {
          throw new Error(`Unexpected end of tar archive while reading ${length} bytes`);
        }
        const take = Math.min(length - written, bufEnd - bufStart);
        buf.copy(out, written, bufStart, bufStart + take);
        bufStart += take;
        written += take;
        bytesReadTotal += take;
      }
      return out;
    },
    copyToFd(outFd, length) {
      let remaining = length;
      while (remaining > 0) {
        if (bufStart === bufEnd && !refill()) {
          throw new Error(`Unexpected end of tar archive (${remaining} bytes remaining)`);
        }
        const take = Math.min(remaining, bufEnd - bufStart);
        let written = 0;
        while (written < take) {
          written += fs.writeSync(outFd, buf, bufStart + written, take - written);
        }
        bufStart += take;
        remaining -= take;
        bytesReadTotal += take;
      }
    },
    skipBytes(length) {
      let remaining = length;
      while (remaining > 0) {
        if (bufStart === bufEnd && !refill()) {
          throw new Error(`Unexpected end of tar archive while skipping ${remaining} bytes`);
        }
        const take = Math.min(remaining, bufEnd - bufStart);
        bufStart += take;
        remaining -= take;
        bytesReadTotal += take;
      }
    },
    close() {
      try {
        fs.closeSync(fd);
      } catch {}
    },
  };
}

function removeExistingSymlinkOrFile(targetPath) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(targetPath);
    }
  } catch {}
}

/**
 * Self-contained synchronous uncompressed POSIX ustar / PAX / GNU-LongName tar
 * extractor using only Node built-ins (`fs`, `path`) with O(256 KiB) memory.
 * Matches the subset of `tar.extract({ file, cwd, sync, onReadEntry })` used
 * by this installer fallback.
 */
function extractTarPureNode(options) {
  const tarFile = options.file;
  const resolvedDestDir = path.resolve(options.cwd);
  const onEntry = typeof options.onReadEntry === 'function'
    ? options.onReadEntry
    : (typeof options.onentry === 'function' ? options.onentry : null);

  fs.mkdirSync(resolvedDestDir, { recursive: true });

  const reader = createBufferedTarReader(tarFile);
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  let consecutiveZeroBlocks = 0;
  let globalPax = {};
  let nextPax = null;
  let pendingLongName = null;
  let pendingLongLink = null;
  let checkedFirstBlock = false;

  try {
    while (true) {
      const headerOffset = reader.getOffset();
      const got = reader.readBlock(header);
      if (got === 0) break;
      if (got < TAR_BLOCK_SIZE) {
        throw new Error(`Truncated tar header at byte offset ${headerOffset} (${got} bytes)`);
      }

      if (!checkedFirstBlock) {
        checkedFirstBlock = true;
        if (header[0] === 0x1f && header[1] === 0x8b) {
          throw new Error('Gzip-compressed tar archives are not supported by the uncompressed pure-Node fallback');
        }
      }

      if (isAllZeroBlock(header)) {
        consecutiveZeroBlocks += 1;
        if (consecutiveZeroBlocks >= 2) break;
        continue;
      }
      consecutiveZeroBlocks = 0;

      if (!verifyTarChecksum(header)) {
        throw new Error(`Invalid tar header checksum at byte offset ${headerOffset}`);
      }

      const rawName = readNullTerminatedUtf8(header, 0, 100);
      const mode = readTarOctal(header, 100, 108);
      const headerSize = readTarSize(header);
      const typeflag = header[156];
      const rawLinkName = readNullTerminatedUtf8(header, 157, 257);
      const magic = header.subarray(257, 263).toString('ascii');
      const prefix = magic.startsWith('ustar') ? readNullTerminatedUtf8(header, 345, 500) : '';
      const headerPad = (TAR_BLOCK_SIZE - (headerSize % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;

      // PAX extended headers ('x' per-entry, 'g' global).
      if (typeflag === 0x78 || typeflag === 0x67) {
        const paxBuf = headerSize > 0 ? reader.readBytes(headerSize) : Buffer.alloc(0);
        if (headerPad > 0) reader.skipBytes(headerPad);
        const parsed = parsePaxRecords(paxBuf);
        if (typeflag === 0x67) {
          globalPax = { ...globalPax, ...parsed };
        } else {
          nextPax = nextPax ? { ...nextPax, ...parsed } : parsed;
        }
        continue;
      }

      // GNU LongName ('L') and LongLink ('K').
      if (typeflag === 0x4c || typeflag === 0x4b) {
        const metaBuf = headerSize > 0 ? reader.readBytes(headerSize) : Buffer.alloc(0);
        if (headerPad > 0) reader.skipBytes(headerPad);
        const value = readNullTerminatedUtf8(metaBuf, 0, metaBuf.length);
        if (typeflag === 0x4c) {
          pendingLongName = value;
        } else {
          pendingLongLink = value;
        }
        continue;
      }

      const pax = nextPax ? { ...globalPax, ...nextPax } : globalPax;
      const effectiveRawPath = pax.path !== undefined
        ? pax.path
        : (pendingLongName !== null ? pendingLongName : (prefix ? `${prefix}/${rawName}` : rawName));
      const effectiveLinkPath = pax.linkpath !== undefined
        ? pax.linkpath
        : (pendingLongLink !== null ? pendingLongLink : rawLinkName);
      let entrySize = headerSize;
      if (pax.size !== undefined) {
        const parsedPaxSize = Number(pax.size);
        if (Number.isFinite(parsedPaxSize) && parsedPaxSize >= 0) {
          entrySize = parsedPaxSize;
        }
      }

      nextPax = null;
      pendingLongName = null;
      pendingLongLink = null;

      const entryPad = (TAR_BLOCK_SIZE - (entrySize % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;

      // Directory ('5' or legacy NUL type ending with '/').
      if (typeflag === 0x35 || (typeflag === 0x00 && effectiveRawPath.endsWith('/'))) {
        const entryPath = normalizeArchiveEntryPath(effectiveRawPath);
        if (entryPath) {
          const targetPath = resolveSafeExtractionPath(resolvedDestDir, entryPath);
          if (targetPath) {
            fs.mkdirSync(targetPath, { recursive: true });
          }
          if (onEntry) {
            onEntry({ path: entryPath, size: 0, type: 'Directory' });
          }
        }
        if (entrySize + entryPad > 0) reader.skipBytes(entrySize + entryPad);
        continue;
      }

      // Regular file ('0' or NUL).
      if (typeflag === 0x30 || typeflag === 0x00) {
        const entryPath = normalizeArchiveEntryPath(effectiveRawPath);
        const targetPath = resolveSafeExtractionPath(resolvedDestDir, entryPath);
        if (!targetPath) {
          if (entrySize + entryPad > 0) reader.skipBytes(entrySize + entryPad);
          continue;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        removeExistingSymlinkOrFile(targetPath);

        const fileMode = (mode & 0o777) || 0o666;
        const outFd = fs.openSync(targetPath, 'w', fileMode);
        try {
          if (entrySize > 0) {
            reader.copyToFd(outFd, entrySize);
          }
        } finally {
          fs.closeSync(outFd);
        }
        if (process.platform !== 'win32' && (mode & 0o777) !== 0) {
          try {
            fs.chmodSync(targetPath, mode & 0o777);
          } catch {}
        }
        if (entryPad > 0) reader.skipBytes(entryPad);
        if (onEntry) {
          onEntry({ path: entryPath, size: entrySize, type: 'File' });
        }
        continue;
      }

      // Symbolic link ('2').
      if (typeflag === 0x32) {
        const entryPath = normalizeArchiveEntryPath(effectiveRawPath);
        const targetPath = resolveSafeExtractionPath(resolvedDestDir, entryPath);
        if (targetPath && effectiveLinkPath) {
          const resolvedLink = path.resolve(path.dirname(targetPath), effectiveLinkPath);
          const relLink = path.relative(resolvedDestDir, resolvedLink);
          if (relLink.startsWith('..') || path.isAbsolute(relLink)) {
            throw new Error(`Refusing to extract symlink pointing outside destination: ${entryPath} -> ${effectiveLinkPath}`);
          }
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          removeExistingSymlinkOrFile(targetPath);
          fs.symlinkSync(effectiveLinkPath, targetPath);
          if (onEntry) {
            onEntry({ path: entryPath, size: 0, type: 'SymbolicLink' });
          }
        }
        if (entrySize + entryPad > 0) reader.skipBytes(entrySize + entryPad);
        continue;
      }

      // Hard link ('1').
      if (typeflag === 0x31) {
        const entryPath = normalizeArchiveEntryPath(effectiveRawPath);
        const linkPath = normalizeArchiveEntryPath(effectiveLinkPath);
        const targetPath = resolveSafeExtractionPath(resolvedDestDir, entryPath);
        const linkTargetPath = resolveSafeExtractionPath(resolvedDestDir, linkPath);
        if (targetPath && linkTargetPath) {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          removeExistingSymlinkOrFile(targetPath);
          try {
            fs.linkSync(linkTargetPath, targetPath);
          } catch {
            fs.copyFileSync(linkTargetPath, targetPath);
          }
          if (onEntry) {
            onEntry({ path: entryPath, size: 0, type: 'Link' });
          }
        }
        if (entrySize + entryPad > 0) reader.skipBytes(entrySize + entryPad);
        continue;
      }

      // Skip other metadata / unsupported entry types cleanly.
      if (entrySize + entryPad > 0) {
        reader.skipBytes(entrySize + entryPad);
      }
    }
  } finally {
    reader.close();
  }
}

function loadTarModule(resourcesDir, logFn = () => {}) {
  const candidates = [
    {
      label: 'npm-unpacked',
      modulePath: path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'npm', 'node_modules', 'tar'),
    },
    {
      label: 'asar',
      modulePath: path.join(resourcesDir, 'app.asar', 'node_modules', 'tar'),
    },
    {
      label: 'node-resolve',
      modulePath: 'tar',
    },
  ];

  for (const candidate of candidates) {
    try {
      const mod = require(candidate.modulePath);
      if (mod && typeof mod.extract === 'function') {
        logFn(`[unpack-dsh-resources] phase=load-tar-ok source=${candidate.label}`);
        return mod;
      }
    } catch (e) {
      logFn(`[unpack-dsh-resources] phase=load-tar-miss source=${candidate.label} error=${stringifyError(e)}`);
    }
  }

  logFn('[unpack-dsh-resources] phase=load-tar-fallback source=builtin-pure-node');
  return {
    extract: extractTarPureNode,
  };
}

function main() {
  try {
    const heartbeat = `${new Date().toISOString()} [unpack-dsh-resources] phase=script-started pid=${process.pid} node=${process.version} electron_run_as_node=${process.env.ELECTRON_RUN_AS_NODE || 'NOT_SET'}`;
    console.log(heartbeat);
    if (process.argv[4]) {
      fs.mkdirSync(path.dirname(process.argv[4]), { recursive: true });
      fs.appendFileSync(process.argv[4], heartbeat + '\n');
    }
  } catch {}

  const tarPath = process.argv[2];
  const destDir = process.argv[3];
  const installLogPath = process.argv[4];

  if (!tarPath || !destDir) {
    console.error('[unpack-dsh-resources] Usage: LobsterAI.exe unpack-dsh-resources.cjs <tarPath> <destDir>');
    process.exit(1);
  }

  if (!fs.existsSync(tarPath)) {
    console.error(`[unpack-dsh-resources] tar file not found: ${tarPath}`);
    process.exit(1);
  }

  let logFd = null;
  if (installLogPath) {
    try {
      fs.mkdirSync(path.dirname(installLogPath), { recursive: true });
      logFd = fs.openSync(installLogPath, 'a');
    } catch (error) {
      console.error(`[unpack-dsh-resources] Failed to open install log: ${stringifyError(error)}`);
    }
  }

  function logLine(message) {
    const line = `${formatTimestamp()} ${message}`;
    console.log(line);
    if (logFd !== null) {
      try {
        fs.writeSync(logFd, `${line}\n`);
      } catch (error) {
        console.error(`${formatTimestamp()} [unpack-dsh-resources] Failed to write install log: ${stringifyError(error)}`);
        logFd = null;
      }
    }
  }

  function closeLogFile() {
    if (logFd === null) return;
    try {
      fs.closeSync(logFd);
    } catch {}
    logFd = null;
  }

  process.on('uncaughtException', (err) => {
    logLine(`[unpack-dsh-resources] phase=uncaught-exception error=${stringifyError(err)}`);
    closeLogFile();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logLine(`[unpack-dsh-resources] phase=unhandled-rejection error=${stringifyError(reason)}`);
    closeLogFile();
    process.exit(1);
  });

  try {
    logLine(`[unpack-dsh-resources] phase=extract-open tar=${tarPath}`);
    logLine(`[unpack-dsh-resources] phase=extract-destination dir=${destDir}`);

    const tar = loadTarModule(path.dirname(tarPath), logLine);
    const t0 = Date.now();
    let extractedEntries = 0;
    let extractedBytes = 0;
    let currentRoot = '';
    let nextGlobalProgressBytes = 25 * 1024 * 1024;
    let nextRootProgressBytes = 25 * 1024 * 1024;
    const rootStats = new Map();

    const handleEntry = (entry) => {
      const entryPath = String(entry?.path || '');
      const root = entryPath.split(/[\\/]/)[0] || '(root)';
      const size = Number(entry?.size || 0);
      extractedEntries += 1;
      extractedBytes += size;

      const stats = rootStats.get(root) || {
        entries: 0,
        bytes: 0,
        startedAtMs: Date.now(),
      };
      stats.entries += 1;
      stats.bytes += size;
      rootStats.set(root, stats);

      if (root !== currentRoot) {
        currentRoot = root;
        nextRootProgressBytes = stats.bytes + (25 * 1024 * 1024);
        logLine(`[unpack-dsh-resources] phase=root-start root=${root} entry=${entryPath}`);
      }

      if (extractedEntries <= 20 || extractedBytes >= nextGlobalProgressBytes) {
        const elapsedMs = Date.now() - t0;
        logLine(
          `[unpack-dsh-resources] phase=extract-progress entries=${extractedEntries} bytes=${extractedBytes} mb=${formatMegabytes(extractedBytes)} elapsed_ms=${elapsedMs} current=${entryPath}`,
        );
        while (extractedBytes >= nextGlobalProgressBytes) {
          nextGlobalProgressBytes += 25 * 1024 * 1024;
        }
      }

      if (stats.bytes >= nextRootProgressBytes) {
        const elapsedMs = Date.now() - stats.startedAtMs;
        logLine(
          `[unpack-dsh-resources] phase=root-progress root=${root} entries=${stats.entries} bytes=${stats.bytes} mb=${formatMegabytes(stats.bytes)} elapsed_ms=${elapsedMs} current=${entryPath}`,
        );
        while (stats.bytes >= nextRootProgressBytes) {
          nextRootProgressBytes += 25 * 1024 * 1024;
        }
      }
    };

    fs.mkdirSync(destDir, { recursive: true });

    tar.extract({
      file: tarPath,
      cwd: destDir,
      sync: true,
      onReadEntry: handleEntry,
      onentry: handleEntry,
    });

    const elapsedMs = Date.now() - t0;
    logLine(`[unpack-dsh-resources] phase=extract-complete entries=${extractedEntries} bytes=${extractedBytes} elapsed_ms=${elapsedMs}`);

    for (const [root, stats] of rootStats.entries()) {
      const rootElapsedMs = Date.now() - stats.startedAtMs;
      logLine(
        `[unpack-dsh-resources] phase=root-summary root=${root} entries=${stats.entries} bytes=${stats.bytes} mb=${formatMegabytes(stats.bytes)} elapsed_ms=${rootElapsedMs}`,
      );
    }

    const expectedDirs = ['dsh-runtime', 'dsh-bundles', 'SKILLs', 'python-win'];
    let missingDirs = 0;
    for (const dir of expectedDirs) {
      const dirPath = path.join(destDir, dir);
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(dirPath).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (isDirectory) {
        logLine(`[unpack-dsh-resources] phase=verify-ok dir=${dir}`);
      } else {
        missingDirs += 1;
        logLine(`[unpack-dsh-resources] phase=verify-missing dir=${dir}`);
      }
    }

    const requiredResourceChecks = [
      {
        name: 'dsh-runtime-entry',
        ok: fs.existsSync(path.join(destDir, 'dsh-runtime', 'lib', 'bin.js'))
          && fs.existsSync(path.join(destDir, 'dsh-runtime', 'package.json')),
      },
      {
        name: 'dsh-host-bundle',
        ok: fs.existsSync(path.join(destDir, 'dsh-bundles', 'lobsterai-host', 'package.json')),
      },
      {
        name: 'dsh-channels-bundle',
        ok: fs.existsSync(path.join(destDir, 'dsh-bundles', 'lobsterai-channels', 'package.json')),
      },
      {
        name: 'skills-content',
        ok: fs.existsSync(path.join(destDir, 'SKILLs'))
          && fs.readdirSync(path.join(destDir, 'SKILLs')).length > 0,
      },
      {
        name: 'python-entry',
        ok: ['python.exe', 'python3.exe']
          .some((fileName) => fs.existsSync(path.join(destDir, 'python-win', fileName))),
      },
    ];
    const missingResources = requiredResourceChecks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    for (const check of requiredResourceChecks) {
      logLine(
        `[unpack-dsh-resources] phase=${check.ok ? 'verify-ok' : 'verify-missing'} resource=${check.name}`,
      );
    }

    if (missingDirs > 0 || missingResources.length > 0) {
      throw new Error(
        `required resources missing after extraction: directories=${missingDirs}, resources=${missingResources.join(',') || 'none'}`,
      );
    }

    // Success sentinel for exit-code-blind environments where security tooling
    // breaks PowerShell's $p.ExitCode query even when extraction completed cleanly.
    if (missingDirs === 0 && missingResources.length === 0) {
      const sentinelPath = path.join(destDir, '.unpack-dsh-ok');
      try {
        fs.writeFileSync(
          sentinelPath,
          `${formatTimestamp()} pid=${process.pid} entries=${extractedEntries} bytes=${extractedBytes}\n`,
        );
        logLine(`[unpack-dsh-resources] phase=sentinel-written path=${sentinelPath}`);
      } catch (error) {
        logLine(`[unpack-dsh-resources] phase=sentinel-write-failed error=${stringifyError(error)}`);
      }
    }

    logLine('[unpack-dsh-resources] phase=extract-ok');
    closeLogFile();
    process.exit(0);
  } catch (err) {
    logLine(`[unpack-dsh-resources] phase=extract-failed error=${stringifyError(err)}`);
    closeLogFile();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractTarPureNode,
  loadTarModule,
  parsePaxRecords,
};
