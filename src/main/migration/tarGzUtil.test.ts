import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  extractMatchingEntriesFromTarGz,
  writeTarGzArchive,
} from './tarGzUtil';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-targz-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('tarGzUtil', () => {
  test('selectively extracts matching entries across chunk boundaries and ustar prefixes', async () => {
    const dir = createTempDir();
    const archivePath = path.join(dir, 'sample.tar.gz');
    const extractDir = path.join(dir, 'out');

    const longNestedPath = `openclaw-state/cron/runs/${'a'.repeat(45)}/${'b'.repeat(45)}/job-1.jsonl`;
    const bigPayload = Buffer.alloc(140_000, 0x42);

    writeTarGzArchive(archivePath, [
      {
        archivePath: 'openclaw-state/.compile-cache/huge.bin',
        content: Buffer.alloc(200_000, 0x61),
      },
      {
        archivePath: 'openclaw-state/state/openclaw.sqlite',
        content: bigPayload,
      },
      {
        archivePath: 'openclaw-state/state/empty.wal',
        content: Buffer.alloc(0),
      },
      {
        archivePath: longNestedPath,
        content: Buffer.from('{"jobId":"job-1","status":"ok"}\n', 'utf8'),
      },
    ]);

    const extracted = await extractMatchingEntriesFromTarGz(
      archivePath,
      extractDir,
      (entryPath) =>
        entryPath.startsWith('openclaw-state/state/')
        || entryPath.startsWith('openclaw-state/cron/'),
    );

    expect(extracted).toEqual([
      'openclaw-state/state/openclaw.sqlite',
      'openclaw-state/state/empty.wal',
      longNestedPath,
    ]);

    expect(fs.existsSync(path.join(extractDir, 'openclaw-state', '.compile-cache'))).toBe(false);
    expect(
      fs.readFileSync(path.join(extractDir, 'openclaw-state', 'state', 'openclaw.sqlite')).equals(bigPayload),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(extractDir, 'openclaw-state', 'state', 'empty.wal')).byteLength,
    ).toBe(0);
    expect(fs.readFileSync(path.join(extractDir, longNestedPath), 'utf8')).toContain('"jobId":"job-1"');
  });
});
