import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it } from 'vitest';

import { assertRemoteSidecarHeadroom, RemoteSidecarHeadroom } from './remoteSidecarHeadroom';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
it('counts retained WAL and stops new work without removing original files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-headroom-')); directories.push(directory);
  const file = path.join(directory, 'remote-sync.sqlite'), wal = `${file}-wal`;
  fs.writeFileSync(file, ''); fs.writeFileSync(wal, ''); fs.truncateSync(wal, RemoteSidecarHeadroom.WalBytes);
  expect(() => assertRemoteSidecarHeadroom(file, 1024, 1024)).toThrow('REMOTE_SIDECAR_STORAGE_BUDGET');
  expect(fs.statSync(wal).size).toBe(RemoteSidecarHeadroom.WalBytes);
  fs.truncateSync(wal, 0);
  expect(() => assertRemoteSidecarHeadroom(file, 1024, 1024)).not.toThrow();
});
