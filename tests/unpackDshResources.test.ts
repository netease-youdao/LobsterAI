import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import * as tar from 'tar';
import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const unpackModule = require('../scripts/unpack-dsh-resources.cjs') as {
  extractTarPureNode: (options: {
    file: string;
    cwd: string;
    sync?: boolean;
    onReadEntry?: (entry: { path: string; size: number; type: string }) => void;
    onentry?: (entry: { path: string; size: number; type: string }) => void;
  }) => void;
  parsePaxRecords: (buf: Buffer) => Record<string, string>;
};

const REPO_UNPACK_SCRIPT = path.resolve(__dirname, '../scripts/unpack-dsh-resources.cjs');

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
  const str = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  target.write(str.slice(-(length - 1)), offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function createRawTarHeader(
  name: string,
  size: number,
  typeflag: number,
  mode = 0o644,
): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = typeflag;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let checksum = 0;
  for (let i = 0; i < 512; i += 1) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function padTarPayload(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

describe('unpack-dsh-resources.cjs', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extracts a full real tar (long PAX paths, UTF-8 paths, nested dirs, multi-chunk binary) without any tar dependency', () => {
    const workDir = makeTempDir('lobsterai-unpack-e2e-');
    const stagingDir = path.join(workDir, 'staging');
    const resourcesDir = path.join(workDir, 'resources');
    const logPath = path.join(workDir, 'install.log');
    fs.mkdirSync(resourcesDir, { recursive: true });

    // Long nested ASCII path (> 150 chars, exceeds 100-byte ustar name field and triggers PAX).
    const longAsciiRelPath = path.posix.join(
      'SKILLs',
      'very-long-skill-package-name-segment-alpha',
      'deeply-nested-directory-structure-segment-beta',
      'another-long-subdirectory-segment-gamma-0123456789',
      'payload-with-extra-long-filename-exceeding-ustar-100-byte-limit.json',
    );
    expect(Buffer.byteLength(longAsciiRelPath, 'utf8')).toBeGreaterThan(150);

    // Multi-byte UTF-8 path (> 110 UTF-8 bytes) verifying byte-accurate PAX parsing.
    const longUtf8RelPath = path.posix.join(
      'SKILLs',
      '中文技能目录_测试长路径与多字节字符',
      '子目录_包含超长文件名用于验证PAX字节长度解析精度',
      '最终测试文件_配置说明_0123456789.txt',
    );
    expect(Buffer.byteLength(longUtf8RelPath, 'utf8')).toBeGreaterThan(120);

    // Binary payload (> 600 KiB, crossing multiple 256 KiB read-buffer boundaries).
    const binaryPayload = crypto.randomBytes(620 * 1024 + 37);

    const fixtureFiles: Record<string, Buffer> = {
      'dsh-runtime/package.json': Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' })),
      'dsh-runtime/lib/bin.js': Buffer.from('#!/usr/bin/env node\nexport async function runCli() {}\n'),
      'dsh-runtime/node_modules/@scope/pkg/binary.dat': binaryPayload,
      'dsh-bundles/lobsterai-host/package.json': Buffer.from('{"name":"@lobsterai/dsh-host"}'),
      'dsh-bundles/lobsterai-host/cordis.patch.yml': Buffer.from('plugins: {}\n'),
      'dsh-bundles/lobsterai-channels/package.json': Buffer.from('{"name":"@lobsterai/dsh-channels"}'),
      'SKILLs/empty-placeholder.txt': Buffer.alloc(0),
      [longAsciiRelPath]: Buffer.from(JSON.stringify({ ok: true, kind: 'long-ascii-pax' })),
      [longUtf8RelPath]: Buffer.from('你好，世界！PAX UTF-8 字节偏移校验通过。\n', 'utf8'),
      'python-win/python.exe': Buffer.from('MZ-fake-portable-python-binary'),
    };

    for (const [relPath, content] of Object.entries(fixtureFiles)) {
      const fullPath = path.join(stagingDir, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    // Create win-resources.tar using the same tar.create + tar.replace workflow as pack-dsh-win-resources.cjs.
    const tarPath = path.join(resourcesDir, 'win-resources.tar');
    tar.create({ file: tarPath, cwd: path.join(stagingDir, 'dsh-runtime'), prefix: 'dsh-runtime', sync: true }, ['package.json', 'lib', 'node_modules']);
    tar.replace({ file: tarPath, cwd: path.join(stagingDir, 'dsh-bundles'), prefix: 'dsh-bundles', sync: true }, ['lobsterai-host', 'lobsterai-channels']);
    tar.replace({ file: tarPath, cwd: path.join(stagingDir, 'SKILLs'), prefix: 'SKILLs', sync: true }, fs.readdirSync(path.join(stagingDir, 'SKILLs')));
    tar.replace({ file: tarPath, cwd: path.join(stagingDir, 'python-win'), prefix: 'python-win', sync: true }, ['python.exe']);

    // Copy unpack-dsh-resources.cjs into the isolated temp resourcesDir where
    // neither app.asar/node_modules/tar, app.asar.unpacked/node_modules/npm/node_modules/tar,
    // nor any ancestor node_modules/tar exists.
    const isolatedScript = path.join(resourcesDir, 'unpack-dsh-resources.cjs');
    fs.copyFileSync(REPO_UNPACK_SCRIPT, isolatedScript);

    execFileSync(process.execPath, [isolatedScript, tarPath, resourcesDir, logPath], {
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? '',
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: 'pipe',
    });

    const installLog = fs.readFileSync(logPath, 'utf8');
    expect(installLog).toContain('phase=load-tar-fallback source=builtin-pure-node');
    expect(installLog).toContain('phase=sentinel-written');
    expect(installLog).toContain('phase=extract-ok');
    expect(fs.existsSync(path.join(resourcesDir, '.unpack-dsh-ok'))).toBe(true);

    // Verify EVERY extracted file matches the source SHA-256 identically.
    for (const relPath of Object.keys(fixtureFiles)) {
      const srcFile = path.join(stagingDir, ...relPath.split('/'));
      const dstFile = path.join(resourcesDir, ...relPath.split('/'));
      expect(fs.existsSync(dstFile), `missing extracted file: ${relPath}`).toBe(true);
      expect(sha256File(dstFile), `SHA-256 mismatch: ${relPath}`).toBe(sha256File(srcFile));
    }
  });

  test('pure-Node extractor handles GNU LongName (type L) entries cleanly', () => {
    const workDir = makeTempDir('lobsterai-unpack-gnu-');
    const destDir = path.join(workDir, 'dest');
    const tarPath = path.join(workDir, 'gnu-longname.tar');

    const longRelPath = 'dsh-runtime/' + 'segment-'.repeat(18) + 'gnu-long-target.js';
    expect(longRelPath.length).toBeGreaterThan(150);

    const longNamePayload = Buffer.from(`${longRelPath}\0`, 'utf8');
    const filePayload = Buffer.from('export const gnuLongNameWorks = true;\n', 'utf8');

    const archive = Buffer.concat([
      createRawTarHeader('././@LongLink', longNamePayload.length, 0x4c),
      padTarPayload(longNamePayload),
      createRawTarHeader(longRelPath.slice(0, 99), filePayload.length, 0x30),
      padTarPayload(filePayload),
      Buffer.alloc(1024, 0),
    ]);
    fs.writeFileSync(tarPath, archive);

    const seenEntries: string[] = [];
    unpackModule.extractTarPureNode({
      file: tarPath,
      cwd: destDir,
      sync: true,
      onReadEntry: (entry) => seenEntries.push(entry.path),
    });

    const extractedFile = path.join(destDir, ...longRelPath.split('/'));
    expect(fs.existsSync(extractedFile)).toBe(true);
    expect(fs.readFileSync(extractedFile, 'utf8')).toBe('export const gnuLongNameWorks = true;\n');
    expect(seenEntries).toEqual([longRelPath]);
  });

  test('pure-Node extractor rejects parent-traversal paths and corrupt tar checksums', () => {
    const workDir = makeTempDir('lobsterai-unpack-sec-');
    const destDir = path.join(workDir, 'dest');

    const traversalTar = path.join(workDir, 'traversal.tar');
    const evilPayload = Buffer.from('pwned');
    fs.writeFileSync(
      traversalTar,
      Buffer.concat([
        createRawTarHeader('../escaped.txt', evilPayload.length, 0x30),
        padTarPayload(evilPayload),
        Buffer.alloc(1024, 0),
      ]),
    );
    expect(() =>
      unpackModule.extractTarPureNode({ file: traversalTar, cwd: destDir, sync: true }),
    ).toThrow(/parent traversal/i);
    expect(fs.existsSync(path.join(workDir, 'escaped.txt'))).toBe(false);

    const corruptTar = path.join(workDir, 'corrupt.tar');
    fs.writeFileSync(corruptTar, Buffer.alloc(1024, 0x41));
    expect(() =>
      unpackModule.extractTarPureNode({ file: corruptTar, cwd: destDir, sync: true }),
    ).toThrow(/checksum/i);
  });

  test('parsePaxRecords handles multi-byte UTF-8 values and equals signs in values', () => {
    const value = 'SKILLs/文档=说明/测试.txt';
    const body = `path=${value}\n`;
    const totalLen = Buffer.byteLength(body, 'utf8') + String(Buffer.byteLength(body, 'utf8') + 3).length + 1;
    const record = `${totalLen} ${body}`;
    expect(Buffer.byteLength(record, 'utf8')).toBe(totalLen);

    const parsed = unpackModule.parsePaxRecords(Buffer.from(record, 'utf8'));
    expect(parsed.path).toBe(value);
  });
});
