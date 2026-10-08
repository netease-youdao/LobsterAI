import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { readDreamingRecoverySummary } from '../src/main/libs/openclawDreamingRecovery';
import { extractDreamingStartupFailure } from '../src/main/libs/openclawDreamingStartupFailure';
import { runOpenClawStartupCompatibility } from '../src/main/libs/openclawStartupCompatibility';
import { OpenClawDreamingStateFile as File } from '../src/shared/openclawEngine/dreamingRecovery';
import { OpenClawStartupCompatibilityMode as Mode } from '../src/shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus as Status } from '../src/shared/openclawEngine/startupMigration';

const helperRuntime = process.env.OPENCLAW_STARTUP_COMPAT_RUNTIME;
const gatewayRuntime = process.env.OPENCLAW_DREAMING_GATEWAY_RUNTIME;
const execFileAsync = promisify(execFile);
const Rpc = { Config: 'config.get', Agents: 'agents.list', Sessions: 'sessions.list' } as const;
const token = 'dreaming-isolated-test-token';
const invalid = Buffer.from('{"version":1,"files":{}}\n{"corrupted":true}\n');
const phaseNamespace = 'short-term-phase-signals';
let root: string;
let stateDir: string;
let configPath: string;
let workspaces: string[];
let env: NodeJS.ProcessEnv;

describe.skipIf(!helperRuntime)('bundled dreaming recovery', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dreaming-integration-'));
    stateDir = path.join(root, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    workspaces = Array.from({ length: 5 }, (_, index) => path.join(root, `配置 工作区 ${index}`));
    fs.mkdirSync(stateDir);
    const entries = Object.fromEntries(workspaces.map((workspace, index) => [index === 0 ? 'main' : `agent-${index}`, { workspace }]));
    entries.shared = { workspace: workspaces[0] };
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' }, controlUi: { enabled: false } },
      agents: { ownership: 'explicit', entries,
        defaults: { workspace: workspaces[0], systemAgent: { agentId: 'main' }, authInheritance: { agentId: 'main' } } },
      memory: { search: { enabled: true, provider: 'none', fallback: 'none', store: { vector: { enabled: false } } } },
      plugins: { allow: ['memory-core'], entries: { 'memory-core': { enabled: true, config: { dreaming: { enabled: false } } } } },
      logging: { file: path.join(root, 'gateway.log') }, cron: { enabled: false }, browser: { enabled: false },
    }));
    env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'), XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'), TMPDIR: root, TEMP: root, TMP: root,
      OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
      OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1', NODE_COMPILE_CACHE: path.join(root, 'compile-cache'), NODE_ENV: 'production',
    };
  });
  afterEach(() => {
    const artifactDirectory = process.env.OPENCLAW_DREAMING_ARTIFACT_DIR;
    if (artifactDirectory && fs.existsSync(path.join(root, 'gateway.log'))) {
      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.copyFileSync(path.join(root, 'gateway.log'), path.join(artifactDirectory, `${path.basename(root)}.log`));
    }
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const repair = () => runOpenClawStartupCompatibility({
    stateDir, configPath, runtimeRoot: helperRuntime!, electronNodeRuntimePath: process.execPath, env, mode: Mode.RepairDreamingState,
  });
  function seedSources() {
    return workspaces.flatMap((workspace, index) => {
      const names = index === 4 ? [File.DailyIngestion, File.ShortTermRecall, File.PhaseSignals]
        : [File.DailyIngestion, File.SessionIngestion, File.ShortTermRecall];
      const dreams = path.join(workspace, 'memory', '.dreams');
      fs.mkdirSync(dreams, { recursive: true });
      return names.map(name => {
        const file = path.join(dreams, name);
        fs.writeFileSync(file, invalid);
        return file;
      });
    });
  }
  function phaseRows() {
    const db = new DatabaseSync(path.join(stateDir, 'state', 'openclaw.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM plugin_state_entries WHERE namespace = ? ORDER BY entry_key').all(phaseNamespace); }
    finally { db.close(); }
  }

  test('uses configured physical workspaces, backs up all 15 sources once, and excludes unconfigured directories', async () => {
    const sources = seedSources();
    const unconfigured = path.join(stateDir, 'workspace-unconfigured', 'memory', '.dreams', File.DailyIngestion);
    fs.mkdirSync(path.dirname(unconfigured), { recursive: true });
    fs.writeFileSync(unconfigured, invalid);
    const configBefore = fs.readFileSync(configPath);
    expect(await repair()).toMatchObject({ status: Status.Migrated,
      dreamingRecovery: { affectedWorkspaceCount: 5, quarantinedFileCount: 15, pendingFileCount: 0 } });
    expect(sources.every(file => !fs.existsSync(file))).toBe(true);
    expect(fs.readFileSync(unconfigured)).toEqual(invalid);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
    expect(await repair()).toEqual({ status: Status.Skipped });
  }, 60_000);

  test.skipIf(!gatewayRuntime)('recovers real gateway startup, retains partial migration data, enforces the live lock and stays healthy on a second start', async () => {
    const sources = seedSources();
    const phasePath = path.join(workspaces[0], 'memory', '.dreams', File.PhaseSignals);
    const now = new Date().toISOString();
    const validPhase = JSON.stringify({ version: 1, updatedAt: now, entries: {
      'memory:memory/2026-09-15.md:1:1': { key: 'memory:memory/2026-09-15.md:1:1', lightHits: 1, remHits: 2, lastLightAt: now, lastRemAt: now },
    } });
    fs.writeFileSync(phasePath, validPhase);
    const cliPath = path.join(gatewayRuntime!, 'openclaw.mjs');
    const cli = (args: string[]) => execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: gatewayRuntime, env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    async function gatewayAttempt(action: (port: number, child: ReturnType<typeof spawn>, output: () => string) => Promise<void>) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = (server.address() as net.AddressInfo).port;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const child = spawn(process.execPath, [cliPath, 'gateway', '--bind', 'loopback', '--port', String(port), '--token', token], {
        cwd: gatewayRuntime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { output += String(chunk); });
      try { await action(port, child, () => output); }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      }
      return { code: child.exitCode, output };
    }
    const failed = await gatewayAttempt(async (_port, child) => {
      const deadline = Date.now() + 60_000;
      while (child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    });
    expect(failed.code, failed.output.slice(-6000)).toBe(1);
    expect(extractDreamingStartupFailure('', failed.output), failed.output.slice(-6000)).toContain('Memory Core legacy JSON');
    expect(sources.every(file => fs.existsSync(file))).toBe(true);
    const canonical = phaseRows();
    expect(canonical).toHaveLength(1);
    expect(String(canonical[0].value_json)).toContain('"remHits":2');
    expect(fs.readFileSync(phasePath + '.migrated', 'utf8')).toBe(validPhase);
    const configBefore = fs.readFileSync(configPath);
    const recovered = await repair();
    expect(recovered).toMatchObject({ status: Status.Migrated, dreamingRecovery: { quarantinedFileCount: 15, pendingFileCount: 0 } });
    expect(phaseRows()).toEqual(canonical);
    const manifest = JSON.parse(fs.readFileSync(recovered.dreamingRecovery!.manifestPath, 'utf8'));
    for (const file of manifest.files) {
      expect(fs.readFileSync(file.backupPath)).toEqual(invalid);
      expect(fs.readFileSync(file.isolatedPath)).toEqual(invalid);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await gatewayAttempt(async (port, child, output) => {
        let started = false;
        // Packaged plugin loading on Windows can exceed the old 60s fixture
        // deadline. The product itself allows 300s for this cold-start path.
        const deadline = Date.now() + 180_000;
        let lastProbe = '';
        while (Date.now() < deadline && child.exitCode === null) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) });
            const probe = await response.json() as { status?: string };
            lastProbe = JSON.stringify(probe);
            if (response.ok && probe.status === 'started') { started = true; break; }
          } catch { /* Not bound yet. */ }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        expect(started, `${lastProbe}\n${output().slice(-6000)}`).toBe(true);
        const locked = await repair();
        expect(locked.status).toBe(Status.Failed);
        expect(locked.error).toContain('owns this state directory');
        for (const method of Object.values(Rpc)) {
          const result = await cli(['gateway', 'call', method, '--url', `ws://127.0.0.1:${port}`, '--token', token, '--json']);
          const response = JSON.parse(result.stdout);
          if (method === Rpc.Config) expect(response.valid).toBe(true);
          if (method === Rpc.Agents) expect(response.agents).toHaveLength(6);
          if (method === Rpc.Sessions) expect(response.sessions).toEqual([]);
        }
      });
      expect(await repair()).toEqual({ status: Status.Skipped });
      expect(readDreamingRecoverySummary(stateDir)).toMatchObject({ quarantinedFileCount: 15, pendingFileCount: 0 });
      expect(phaseRows()).toEqual(canonical);
      expect(fs.readFileSync(configPath)).toEqual(configBefore);
    }
  }, 480_000);
});
