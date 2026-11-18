import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { listOpenClawStateDbPrewarmFiles, prewarmOpenClawStateDatabases } from './openclawStateDbPrewarm';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-db-prewarm-'));
  tempRoots.push(stateDir);
  return stateDir;
}

function writeFile(stateDir: string, relativePath: string, size: number): string {
  const filePath = path.join(stateDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(size, 1));
  return filePath;
}

describe('listOpenClawStateDbPrewarmFiles', () => {
  test('lists the state and agent databases with their WAL files, largest first', async () => {
    const stateDir = createStateDir();
    const state = writeFile(stateDir, 'state/openclaw.sqlite', 300);
    const mainAgent = writeFile(stateDir, 'agents/main/agent/openclaw-agent.sqlite', 900);
    const mainWal = writeFile(stateDir, 'agents/main/agent/openclaw-agent.sqlite-wal', 50);
    const otherAgent = writeFile(stateDir, 'agents/writer/agent/openclaw-agent.sqlite', 500);
    // An empty WAL holds nothing to read, and other files are not databases the gateway checks.
    writeFile(stateDir, 'agents/writer/agent/openclaw-agent.sqlite-wal', 0);
    writeFile(stateDir, 'agents/writer/agent/models.json', 700);
    writeFile(stateDir, 'agents/empty/agent/.keep', 1);

    const listed = await listOpenClawStateDbPrewarmFiles(stateDir, Number.MAX_SAFE_INTEGER);

    expect(listed.files).toEqual([
      { path: mainAgent, size: 900 },
      { path: otherAgent, size: 500 },
      { path: state, size: 300 },
      { path: mainWal, size: 50 },
    ]);
    expect(listed.skippedFiles).toBe(0);
  });

  test('leaves files that do not fit the byte budget cold', async () => {
    const stateDir = createStateDir();
    writeFile(stateDir, 'agents/main/agent/openclaw-agent.sqlite', 900);
    const otherAgent = writeFile(stateDir, 'agents/writer/agent/openclaw-agent.sqlite', 500);
    const state = writeFile(stateDir, 'state/openclaw.sqlite', 300);

    const listed = await listOpenClawStateDbPrewarmFiles(stateDir, 850);

    expect(listed.files.map(file => file.path)).toEqual([otherAgent, state]);
    expect(listed.skippedFiles).toBe(1);
  });

  test('returns nothing for a state directory without databases', async () => {
    const listed = await listOpenClawStateDbPrewarmFiles(path.join(createStateDir(), 'missing'), 1_000);

    expect(listed).toEqual({ files: [], skippedFiles: 0 });
  });
});

describe('prewarmOpenClawStateDatabases', () => {
  test('reads every listed file to its end', async () => {
    const stateDir = createStateDir();
    // Larger than one read chunk, so the reader has to loop.
    writeFile(stateDir, 'agents/main/agent/openclaw-agent.sqlite', 5 * 1024 * 1024 + 7);
    writeFile(stateDir, 'agents/writer/agent/openclaw-agent.sqlite', 4096);
    writeFile(stateDir, 'state/openclaw.sqlite', 8192);

    const result = await prewarmOpenClawStateDatabases(stateDir, { concurrency: 2 });

    expect(result).toMatchObject({ files: 3, bytes: 5 * 1024 * 1024 + 7 + 4096 + 8192, skippedFiles: 0 });
  });

  test('shares one pass per state directory while it runs', async () => {
    const stateDir = createStateDir();
    writeFile(stateDir, 'state/openclaw.sqlite', 4096);

    const first = prewarmOpenClawStateDatabases(stateDir);
    const concurrent = prewarmOpenClawStateDatabases(stateDir);
    expect(concurrent).toBe(first);
    await first;

    const next = prewarmOpenClawStateDatabases(stateDir);
    expect(next).not.toBe(first);
    await expect(next).resolves.toMatchObject({ files: 1, bytes: 4096 });
  });

  test('resolves with an empty pass when there is nothing to read', async () => {
    const result = await prewarmOpenClawStateDatabases(path.join(createStateDir(), 'missing'));

    expect(result).toMatchObject({ files: 0, bytes: 0, skippedFiles: 0 });
  });
});
