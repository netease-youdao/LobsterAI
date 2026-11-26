import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { RemoteTelemetrySpool } from './remoteTelemetrySpool';

const directories: string[] = [];
const directory = async () => { const result = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-spool-')); directories.push(result); return result; };
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

test('caps segments and disk bytes, yields per bounded segment, and never clears unrelated files', async () => {
  const dir = await directory(); await fs.writeFile(path.join(dir, 'business-file'), 'keep');
  const spool = new RemoteTelemetrySpool(dir);
  spool.replace(Array.from({ length: 1024 }, (_, i) => ({ eventId: String(i), epoch: 'a', createdAt: 1, payload: 'x'.repeat(4000) })));
  await spool.flush();
  const names = (await fs.readdir(dir)).filter(name => name.startsWith('segment-'));
  expect(names.length).toBeLessThanOrEqual(20);
  const bytes = (await Promise.all(names.map(async name => (await fs.stat(path.join(dir, name))).size))).reduce((a, b) => a + b, 0);
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const restored = await spool.restore(value => value as { eventId: string; epoch: string; createdAt: number }, () => true);
  expect(restored.length).toBeGreaterThan(500); expect(restored.length).toBeLessThanOrEqual(1000);
  spool.replace([]); await spool.flush();
  expect(await fs.readFile(path.join(dir, 'business-file'), 'utf8')).toBe('keep');
  expect((await fs.readdir(dir)).filter(name => name.startsWith('segment-'))).toEqual([]);
});

test('oversized, corrupt and cancelled cache reads are isolated', async () => {
  const dir = await directory(), failures = vi.fn();
  await fs.writeFile(path.join(dir, 'segment-00.jsonl'), '{broken\n');
  await fs.writeFile(path.join(dir, 'segment-01.jsonl'), 'x'.repeat(201 * 1024));
  await fs.writeFile(path.join(dir, 'segment-02.jsonl'), JSON.stringify({ eventId: 'good', epoch: 'a', createdAt: 1 }) + '\n');
  const spool = new RemoteTelemetrySpool(dir, failures);
  const accept = (value: unknown) => value as { eventId: string; epoch: string; createdAt: number };
  expect(await spool.restore(accept, () => false)).toEqual([]);
  expect(await spool.restore(accept, () => true)).toEqual([{ eventId: 'good', epoch: 'a', createdAt: 1 }]);
  expect(failures).toHaveBeenCalledTimes(2);
});
