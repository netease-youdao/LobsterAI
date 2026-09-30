import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  alignOpenClawConfigBackup, createOpenClawConfigTarget, persistOpenClawConfigTarget,
  rebaseOpenClawConfigTarget, sameOpenClawConfigContent,
} from './openclawConfigTarget';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test('rebases host-owned models without losing concurrent unowned fields or secrets', () => {
  const base = {
    models: { providers: { plan: { baseUrl: 'http://127.0.0.1:3474', apiKey: '${PLAN_TOKEN}' } } },
    gateway: { mode: 'local', auth: { token: '${GATEWAY_TOKEN}' } },
    plugins: { entries: { user: { enabled: true } } },
    custom: { preserve: 'before' },
  };
  const target = createOpenClawConfigTarget(JSON.stringify(base), JSON.stringify({
    models: { providers: { plan: { baseUrl: 'http://127.0.0.1:4121', apiKey: '${PLAN_TOKEN}' } } },
    gateway: base.gateway,
    plugins: { entries: { ...base.plugins.entries, host: { enabled: true } } },
  }));
  const concurrent = {
    ...base, custom: { preserve: 'after' },
    gateway: { ...base.gateway, trustedProxies: ['127.0.0.1'] },
    plugins: { entries: { ...base.plugins.entries, external: { enabled: true } } },
  };
  const merged = JSON.parse(rebaseOpenClawConfigTarget(target, JSON.stringify(concurrent)));
  expect(merged.models.providers.plan).toEqual({ baseUrl: 'http://127.0.0.1:4121', apiKey: '${PLAN_TOKEN}' });
  expect(merged.custom).toEqual({ preserve: 'after' });
  expect(merged.gateway).toEqual(concurrent.gateway);
  expect(Object.keys(merged.plugins.entries).sort()).toEqual(['external', 'host', 'user']);
});

test('does not accept a concurrent reversion of an unchanged host-owned proxy', () => {
  const desired = JSON.stringify({ models: { providers: { plan: { baseUrl: 'http://127.0.0.1:4121' } } } });
  const target = createOpenClawConfigTarget(desired, desired);
  const obsolete = desired.replace('4121', '3474');
  expect(sameOpenClawConfigContent(rebaseOpenClawConfigTarget(target, obsolete), desired)).toBe(true);
});

test('replaces owned arrays and deletes removed bindings, preserving unrelated fields', () => {
  const target = createOpenClawConfigTarget(
    '{"bindings":[{"agentId":"old"}],"agents":{"list":[{"id":"old"}]},"unowned":true}',
    '{"agents":{"list":[{"id":"new"}]}}',
  );
  const result = JSON.parse(rebaseOpenClawConfigTarget(target, target.baseRaw));
  expect(result).toEqual({ agents: { list: [{ id: 'new' }] }, unowned: true });
});

test('preparation has no file side effects; stopped bootstrap is atomic and idempotent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-config-target-'));
  directories.push(directory);
  const file = path.join(directory, 'state', 'openclaw.json');
  const target = createOpenClawConfigTarget('', '{"gateway":{"mode":"local"}}');
  expect(fs.existsSync(file)).toBe(false);
  persistOpenClawConfigTarget(file, target);
  const before = fs.statSync(file).mtimeMs;
  const backupBefore = fs.statSync(`${file}.bak`).mtimeMs;
  persistOpenClawConfigTarget(file, target);
  expect(fs.statSync(file).mtimeMs).toBe(before);
  expect(fs.statSync(`${file}.bak`).mtimeMs).toBe(backupBefore);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ gateway: { mode: 'local' } });
  expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
  expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['openclaw.json', 'openclaw.json.bak']);
});

const makeConfigDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-config-backup-'));
  directories.push(directory);
  return directory;
};

test('a shrinking host write leaves no stale backup for the gateway to restore', () => {
  const file = path.join(makeConfigDir(), 'openclaw.json');
  const signedIn = JSON.stringify({
    gateway: { mode: 'local' },
    models: { providers: { 'lobsterai-server': { models: Array.from({ length: 40 }, (_, i) => ({ id: `plan-${i}` })) } } },
  }, null, 2);
  fs.writeFileSync(file, signedIn);
  fs.writeFileSync(`${file}.bak`, signedIn);
  fs.writeFileSync(`${file}.bak.1`, 'older');

  const target = createOpenClawConfigTarget(signedIn, JSON.stringify({
    gateway: { mode: 'local' },
    models: { providers: { qwen: { models: [{ id: 'qwen3.8-max' }] } } },
  }));
  const written = persistOpenClawConfigTarget(file, target);

  expect(fs.readFileSync(file, 'utf8')).toBe(written);
  expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(written);
  expect(fs.readFileSync(`${file}.bak.1`, 'utf8')).toBe(signedIn);
  expect(fs.readFileSync(`${file}.bak.2`, 'utf8')).toBe('older');
});

test('an unchanged config still replaces a stale backup without rewriting the config', () => {
  const file = path.join(makeConfigDir(), 'openclaw.json');
  const current = '{\n  "gateway": {\n    "mode": "local"\n  }\n}\n';
  fs.writeFileSync(file, current);
  fs.writeFileSync(`${file}.bak`, '{"gateway":{"mode":"local"},"models":{"providers":{"stale":{}}}}');
  const before = fs.statSync(file).mtimeMs;

  const target = createOpenClawConfigTarget(current, current);
  expect(persistOpenClawConfigTarget(file, target)).toBe(current);

  expect(fs.statSync(file).mtimeMs).toBe(before);
  expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(current);
  expect(fs.readFileSync(`${file}.bak.1`, 'utf8')).toContain('stale');
});

test('backup rotation keeps OpenClaw\'s five-slot ring', () => {
  const file = path.join(makeConfigDir(), 'openclaw.json');
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(`${file}.bak`, 'slot-0');
  for (let index = 1; index <= 4; index += 1) fs.writeFileSync(`${file}.bak.${index}`, `slot-${index}`);

  const raw = '{\n  "gateway": {\n    "mode": "local"\n  }\n}\n';
  expect(alignOpenClawConfigBackup(file, raw)).toBe(true);
  expect(alignOpenClawConfigBackup(file, raw)).toBe(false);

  expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(raw);
  expect([1, 2, 3, 4].map(index => fs.readFileSync(`${file}.bak.${index}`, 'utf8')))
    .toEqual(['slot-0', 'slot-1', 'slot-2', 'slot-3']);
  expect(fs.existsSync(`${file}.bak.5`)).toBe(false);
});
