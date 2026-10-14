import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { OpenClawLoopbackService, OpenClawLoopbackState } from './openclawLoopbackState';

let dir: string;
let filePath: string;
let counter = 0;

const secrets = {
  proxyToken: () => `proxy-token-${++counter}`.padEnd(48, 'x'),
  mcpBridgeSecret: () => `bridge-secret-${++counter}`.padEnd(36, 'y'),
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-state-'));
  filePath = path.join(dir, 'openclaw', 'loopback-state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keeps secrets and ports across launches of the same app version', () => {
  const first = new OpenClawLoopbackState(filePath, '2026.9.24', secrets);
  first.rememberPort(OpenClawLoopbackService.TokenProxy, 54061);
  first.rememberPort(OpenClawLoopbackService.McpBridge, 54071);

  const second = new OpenClawLoopbackState(filePath, '2026.9.24', secrets);
  expect(second.proxyToken).toBe(first.proxyToken);
  expect(second.mcpBridgeSecret).toBe(first.mcpBridgeSecret);
  expect(second.getPreferredPort(OpenClawLoopbackService.TokenProxy)).toBe(54061);
  expect(second.getPreferredPort(OpenClawLoopbackService.McpBridge)).toBe(54071);
  expect(second.getPreferredPort(OpenClawLoopbackService.CompatProxy)).toBeUndefined();
  if (process.platform !== 'win32') {
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  }
});

test('rotates secrets but keeps ports when the app version changes', () => {
  const first = new OpenClawLoopbackState(filePath, '2026.9.24', secrets);
  first.rememberPort(OpenClawLoopbackService.CompatProxy, 61000);

  const upgraded = new OpenClawLoopbackState(filePath, '2026.10.1', secrets);
  expect(upgraded.proxyToken).not.toBe(first.proxyToken);
  expect(upgraded.mcpBridgeSecret).not.toBe(first.mcpBridgeSecret);
  expect(upgraded.getPreferredPort(OpenClawLoopbackService.CompatProxy)).toBe(61000);

  const reloaded = new OpenClawLoopbackState(filePath, '2026.10.1', secrets);
  expect(reloaded.proxyToken).toBe(upgraded.proxyToken);
});

test('regenerates state from a corrupt or weak file and drops unusable ports', () => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{not json');
  const fromCorrupt = new OpenClawLoopbackState(filePath, '2026.9.24', secrets);
  expect(fromCorrupt.proxyToken).toMatch(/^proxy-token-/);

  // An untrusted file is regenerated as a whole, ports included.
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    appVersion: '2026.9.24',
    proxyToken: 'short',
    mcpBridgeSecret: 'short',
    ports: { compatProxy: 61000 },
  }));
  const fromWeak = new OpenClawLoopbackState(filePath, '2026.9.24', secrets);
  expect(fromWeak.proxyToken).not.toBe('short');
  expect(fromWeak.getPreferredPort(OpenClawLoopbackService.CompatProxy)).toBeUndefined();

  const token = 't'.repeat(48);
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    appVersion: '2026.9.24',
    proxyToken: token,
    mcpBridgeSecret: 'b'.repeat(36),
    ports: { tokenProxy: 80, compatProxy: 61000, mcpBridge: 'x' },
  }));
  const sanitized = new OpenClawLoopbackState(filePath, '2026.9.24', secrets);
  expect(sanitized.proxyToken).toBe(token);
  expect(sanitized.getPreferredPort(OpenClawLoopbackService.TokenProxy)).toBeUndefined();
  expect(sanitized.getPreferredPort(OpenClawLoopbackService.CompatProxy)).toBe(61000);
  expect(sanitized.getPreferredPort(OpenClawLoopbackService.McpBridge)).toBeUndefined();
});

test('rememberPort ignores unusable values and unchanged ports', () => {
  const state = new OpenClawLoopbackState(filePath, '2026.9.24', secrets);
  state.rememberPort(OpenClawLoopbackService.TokenProxy, 54061);
  const writtenAt = fs.statSync(filePath).mtimeMs;
  state.rememberPort(OpenClawLoopbackService.TokenProxy, 54061);
  state.rememberPort(OpenClawLoopbackService.TokenProxy, 0);
  expect(fs.statSync(filePath).mtimeMs).toBe(writtenAt);
  expect(state.getPreferredPort(OpenClawLoopbackService.TokenProxy)).toBe(54061);
});
