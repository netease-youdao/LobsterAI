import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  isOpenClawDiscoverableAgentDirName,
  migrateLegacySessionStorageWithDoctor,
} from '../src/main/libs/openclawSessionLegacyMigration';

// Point at a built runtime root (the directory containing openclaw.mjs).
const runtimeRoot = process.env.OPENCLAW_LEGACY_SESSION_RUNTIME;
const AGENT_DIR_NAMES = [
  'main', 'content-writer', 'Main-', '设计expert', 'Retired Agent', 'a.b', '-x-',
  '内容创作', '设计专家', '主main', '###', '_old',
];
let tempDir: string;
let stateDir: string;
let configPath: string;

describe.skipIf(!runtimeRoot)('legacy session stores in agent directories OpenClaw does not own', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-legacy-session-orphans-'));
    stateDir = path.join(tempDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local' }, agents: { entries: { main: {} } }, plugins: { enabled: false },
    }, null, 2));
  });

  afterEach(() => {
    if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const storePath = (dirName: string) => path.join(stateDir, 'agents', dirName, 'sessions', 'sessions.json');

  function seedStore(dirName: string, index: number): void {
    const sessionId = `legacy-session-${index}`;
    const sessionFile = path.join(path.dirname(storePath(dirName)), `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(storePath(dirName), JSON.stringify({
      [`agent:main:probe-${index}`]: { sessionId, updatedAt: 1000, sessionFile },
    }));
    fs.writeFileSync(sessionFile, `${JSON.stringify({
      type: 'session', version: 3, id: sessionId, timestamp: '2026-09-01T00:00:00.000Z', cwd: tempDir,
    })}\n`);
  }

  test('doctor leaves exactly the stores the mirrored rule ignores, and they do not block startup', async () => {
    AGENT_DIR_NAMES.forEach(seedStore);

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot: runtimeRoot!, electronNodeRuntimePath: process.execPath,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: tempDir, USERPROFILE: tempDir, TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir,
        XDG_CACHE_HOME: path.join(tempDir, 'cache'),
      },
    });

    expect(result.status, JSON.stringify(result)).toBe('migrated');
    // A failure here means the pinned OpenClaw changed its discovery rule.
    expect(AGENT_DIR_NAMES.filter(name => fs.existsSync(storePath(name))))
      .toEqual(AGENT_DIR_NAMES.filter(name => !isOpenClawDiscoverableAgentDirName(name)));
  }, 120_000);
});
