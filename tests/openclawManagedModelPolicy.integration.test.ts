// OPENCLAW_MODEL_POLICY_RUNTIME=<built runtime> npm test -- openclawManagedModelPolicy.integration
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { OpenClawAgentOwnership } from '../src/main/libs/openclawAgentModels';
import { OpenClawConfigRpcMethod } from '../src/main/libs/openclawConfigDelivery';
import { withManagedOpenClawModelPolicy, withoutOpenClawWriteMetadata } from '../src/main/libs/openclawManagedModelPolicy';
import { AgentId } from '../src/shared/agent/constants';

const runtimeRoot = process.env.OPENCLAW_MODEL_POLICY_RUNTIME;
const execFileAsync = promisify(execFile);
const token = 'model-policy-isolated-test-token';
let tempDir: string;
let stateDir: string;
let configPath: string;

describe.skipIf(!runtimeRoot)('bundled OpenClaw model policy roundtrip', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-model-policy-integration-'));
    stateDir = path.join(tempDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir);
  });

  afterEach(() => {
    if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error('Refusing to clean up outside the temporary fixture directory');
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  test('migrates legacy policy, starts the gateway, and converges after config.set and model changes', async () => {
    const workspace = path.join(stateDir, 'workspace-main');
    const makeConfig = (ids: string[]) => ({
      gateway: {
        mode: 'local', bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' },
        controlUi: { enabled: false },
      },
      models: { mode: 'replace', providers: { fixture: {
        baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-provider-key', api: 'openai-completions',
        models: ids.map(id => ({ id, name: id })),
      } } },
      agents: {
        ownership: OpenClawAgentOwnership.Explicit,
        defaults: {
          workspace, systemAgent: { agentId: AgentId.Main }, authInheritance: { agentId: AgentId.Main },
          model: { primary: `fixture/${ids[0]}` },
          models: Object.fromEntries(ids.map(id => [`fixture/${id}`, {}])),
        },
        entries: { [AgentId.Main]: { workspace } },
      },
      memory: { search: { provider: 'none', fallback: 'none', store: { vector: { enabled: false } } } },
      plugins: { allow: ['memory-core'], entries: { 'memory-core': { enabled: true, config: { dreaming: { enabled: false } } } } },
      logging: { file: path.join(tempDir, 'gateway.log') },
      cron: { enabled: false }, browser: { enabled: false },
    });
    const writeConfig = (config: Record<string, unknown>) => fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      XDG_CACHE_HOME: path.join(tempDir, 'cache'), TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir,
      OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
      OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1', NODE_COMPILE_CACHE: path.join(tempDir, 'compile-cache'),
      NODE_ENV: 'production',
    };
    const cliPath = path.join(runtimeRoot!, 'openclaw.mjs');
    const cli = (args: string[]) => execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: runtimeRoot, env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    let ids = ['model-a', 'model-b'];
    const legacy = makeConfig(ids);
    legacy.agents.defaults.model.primary = 'fixture/model-b';
    writeConfig(legacy);
    // Exercise the real pinned migration, rather than manually inserting its output.
    await cli(['config', 'set', 'agents.defaults.model.primary', 'fixture/model-a']);
    const migrated = readConfig();
    expect(migrated.agents.defaults.modelPolicy).toEqual({ allow: ids.map(id => `fixture/${id}`) });
    expect(migrated.meta.migrations.modelPolicyAllowlist).toBe(true);
    expect(isDeepStrictEqual(
      withoutOpenClawWriteMetadata(withManagedOpenClawModelPolicy(makeConfig(ids), migrated)),
      withoutOpenClawWriteMetadata(migrated),
    )).toBe(true);

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const gateway = spawn(process.execPath, [cliPath, 'gateway', '--bind', 'loopback', '--port', String(port), '--token', token], {
      cwd: runtimeRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>(resolve => gateway.once('close', () => resolve()));
    let output = '';
    gateway.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-20000); });
    gateway.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-20000); });
    try {
      let started = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && gateway.exitCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { started = true; break; }
        } catch { /* The isolated gateway has not bound its port yet. */ }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      expect(started, output).toBe(true);
      const call = async (method: string, params = {}) => {
        const result = await cli(['gateway', 'call', method, '--url', `ws://127.0.0.1:${port}`, '--token', token,
          '--params', JSON.stringify(params), '--json']);
        return JSON.parse(result.stdout);
      };
      for (ids of [['model-a', 'model-b'], ['model-a', 'model-b', 'model-c'], ['model-c', 'model-b']]) {
        const desired = withManagedOpenClawModelPolicy(makeConfig(ids), readConfig());
        const snapshot = await call(OpenClawConfigRpcMethod.Get);
        expect(snapshot.valid).toBe(true);
        const result = await call(OpenClawConfigRpcMethod.Set, { raw: JSON.stringify(desired), baseHash: snapshot.hash });
        expect(result.ok).toBe(true);
        const persisted = readConfig();
        expect(persisted.agents.defaults.modelPolicy).toEqual({ allow: ids.map(id => `fixture/${id}`) });
        expect(persisted.meta.migrations.modelPolicyAllowlist).toBe(true);
        for (let iteration = 0; iteration < 2; iteration += 1) {
          expect(isDeepStrictEqual(
            withoutOpenClawWriteMetadata(withManagedOpenClawModelPolicy(makeConfig(ids), persisted)),
            withoutOpenClawWriteMetadata(persisted),
          )).toBe(true);
        }
        expect(gateway.exitCode, output).toBeNull();
      }
      expect((await call(OpenClawConfigRpcMethod.Get)).valid).toBe(true);
      expect(output).not.toMatch(/requires gateway restart|restarting gateway|SIGUSR1 received/);
    } finally {
      if (gateway.exitCode === null) gateway.kill();
      await closed;
    }
  }, 240_000);
});
