import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  createOpenClawConfigTarget, persistOpenClawConfigTarget,
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
  persistOpenClawConfigTarget(file, target);
  expect(fs.statSync(file).mtimeMs).toBe(before);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ gateway: { mode: 'local' } });
  expect(fs.readdirSync(path.dirname(file))).toEqual(['openclaw.json']);
});
