import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { healOpenClawConfigUnrecognizedKeys, OpenClawConfigSelfHealStatus } from '../src/main/libs/openclawConfigSelfHeal';

// Point at a built runtime root (the directory containing openclaw.mjs).
const runtimeRoot = process.env.OPENCLAW_CONFIG_SELF_HEAL_RUNTIME;
let tempDir: string;
let stateDir: string;
let configPath: string;

describe.skipIf(!runtimeRoot)('bundled CLI config self-heal', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-config-self-heal-integration-'));
    stateDir = path.join(tempDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const heal = () => healOpenClawConfigUnrecognizedKeys({
    configPath, stateDir, runtimeRoot: runtimeRoot!, electronNodeRuntimePath: process.execPath,
    // Test-runner variables can make the CLI exit without output; use a clean environment.
    env: { PATH: process.env.PATH, HOME: tempDir, USERPROFILE: tempDir },
  });

  test('accepts a config written by an older LobsterAI after removing the retired keys', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local' },
      staleRootKey: true,
      tools: { loopDetection: { enabled: true, historySize: 48, warningThreshold: 6, detectors: { pingPong: true } } },
      session: { maintenance: { rotateBytes: 1_000 } },
      cron: { enabled: true, maxConcurrentRuns: 3, store: path.join(stateDir, 'cron', 'jobs.json') },
      agents: { defaults: { compaction: { truncateAfterCompaction: true } } },
    }, null, 2));

    const result = await heal();

    expect(result).toMatchObject({ status: OpenClawConfigSelfHealStatus.Healed });
    expect(result.status === OpenClawConfigSelfHealStatus.Healed && [...result.removed].sort()).toEqual([
      'agents.defaults.compaction.truncateAfterCompaction',
      'cron.maxConcurrentRuns',
      'cron.store',
      'session.maintenance.rotateBytes',
      'staleRootKey',
      'tools.loopDetection.detectors',
      'tools.loopDetection.historySize',
      'tools.loopDetection.warningThreshold',
    ]);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      gateway: { mode: 'local' },
      tools: { loopDetection: { enabled: true } },
      session: { maintenance: {} },
      cron: { enabled: true },
      agents: { defaults: { compaction: {} } },
    });
  }, 60_000);

  test('leaves keys owned by other migrations for those migrations', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local' },
      cron: { maxConcurrentRuns: 3 },
      plugins: { installs: { demo: { source: 'npm', spec: 'demo@1.0.0' } }, bundledDiscovery: 'compat' },
    }, null, 2));

    const result = await heal();

    expect(result).toMatchObject({ status: OpenClawConfigSelfHealStatus.Invalid, removed: ['cron.maxConcurrentRuns'] });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins).toEqual({
      installs: { demo: { source: 'npm', spec: 'demo@1.0.0' } }, bundledDiscovery: 'compat',
    });
  }, 60_000);
});
