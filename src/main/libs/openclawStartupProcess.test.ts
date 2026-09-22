import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { runStartupMigration, stopStartupStateMigrations } from './openclawStartupStateMigration';

test('cancels and waits for only this state directory’s actual migration child', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-startup-stop-'));
  const entry = path.join(root, 'migration.cjs');
  const ready = path.join(root, 'ready');
  fs.writeFileSync(entry, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);");
  const outcome = runStartupMigration(process.execPath, [entry, ready], {
    cwd: root, env: { ...process.env, OPENCLAW_STATE_DIR: root }, timeoutMs: 15_000,
  }).then(value => ({ value }), error => ({ error }));
  try {
    await expect.poll(() => fs.existsSync(ready), { timeout: 5_000 }).toBe(true);
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    await stopStartupStateMigrations(path.join(root, 'other'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await stopStartupStateMigrations(root);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await outcome).toHaveProperty('error');
  } finally {
    await stopStartupStateMigrations(root); await outcome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
