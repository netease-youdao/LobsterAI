// OPENCLAW_MODEL_POLICY_RUNTIME=<built runtime> npm test -- openclawManagedModelPolicy.integration
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

  test('matches the pinned policy schema across ASCII, Unicode, aliases and reference structure', async () => {
    const characters = [
      ...Array.from({ length: 128 }, (_, code) => String.fromCodePoint(code)),
      '\u0085', '\u00a0', '\u1680', '\u2000', '\u2007', '\u200b', '\u2028', '\u2029',
      '\u202f', '\u205f', '\u2060', '\u3000', '\ufeff', '中', '🚀',
    ];
    const refs = [
      ...characters.flatMap(char => [`pro${char}vider/model`, `provider/mo${char}del`]),
      'provider', '/model', 'provider/', 'provider//model', 'provider/model/',
      'provider/model*', 'provider/**', '*/model', 'provider/*/model', 'provider/a /b',
      'provider/a/b', 'provider/*', ' provider / namespace / * ', ' provider / model ',
      'openrouter:auto', 'openrouter:free', 'unresolved-alias', 'known alias',
    ];
    const fixtures = refs.map(ref => {
      const legacy = { agents: {
        defaults: { models: { 'fixture/base-model': { alias: 'known alias' }, [ref]: {} } },
        entries: { [AgentId.Main]: { default: true } },
      } };
      const explicit = {
        agents: { ...legacy.agents, defaults: {
          ...legacy.agents.defaults, modelPolicy: { allow: Object.keys(legacy.agents.defaults.models) },
        } },
        meta: { migrations: { modelPolicyAllowlist: true } },
      };
      return { ref, legacy, explicit,
        generated: withManagedOpenClawModelPolicy(legacy, legacy),
        repaired: withManagedOpenClawModelPolicy(explicit, explicit),
      };
    });
    const fixturePath = path.join(tempDir, 'reference-boundaries.json');
    fs.writeFileSync(fixturePath, JSON.stringify(fixtures));
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const { validateConfigObject } = await import(${JSON.stringify(pathToFileURL(path.join(runtimeRoot!, 'dist/config/config.js')).href)});
      const fixtures = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      console.log(JSON.stringify(fixtures.map(({ ref, legacy, explicit, generated, repaired }) => ({
        ref, legacyValid: validateConfigObject(legacy).ok, explicitValid: validateConfigObject(explicit).ok,
        generatedValid: validateConfigObject(generated).ok, repairedValid: validateConfigObject(repaired).ok,
        generatedPolicy: !!generated.agents.defaults.modelPolicy, repairedPolicy: !!repaired.agents.defaults.modelPolicy,
        generatedMarked: generated.meta?.migrations?.modelPolicyAllowlist === true,
        repairedMarked: repaired.meta?.migrations?.modelPolicyAllowlist === true,
      }))));
    `, fixturePath], { cwd: runtimeRoot, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    for (const item of JSON.parse(result.stdout)) {
      expect(item, JSON.stringify(item.ref)).toMatchObject({
        legacyValid: true, generatedValid: true, repairedValid: true,
        generatedPolicy: item.explicitValid, repairedPolicy: item.explicitValid,
        generatedMarked: item.explicitValid, repairedMarked: item.explicitValid,
      });
    }
  }, 90_000);

  test('recovers an invalid generated policy through real startup migration and config writes', async () => {
    const refs = [
      'qwen/qwen3.6-plus', 'qwen/qwen3.5-plus', 'anthropic/claude-opus-4-6',
      'anthropic/claude-sonnet-4-6', 'custom_0/DeepSeek V4 Pro',
    ];
    const corrupted = {
      agents: {
        defaults: {
          model: { primary: refs[0] },
          models: Object.fromEntries(refs.map(ref => [ref, {}])),
          modelPolicy: { allow: refs },
        },
        entries: { [AgentId.Main]: { default: true } },
      },
      meta: { migrations: { modelPolicyAllowlist: true } },
    };
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      USERPROFILE: tempDir, HOME: tempDir, TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir,
      OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SERVICE_REPAIR_POLICY: 'external', OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1',
      NODE_COMPILE_CACHE: path.join(tempDir, 'compile-cache'), NODE_ENV: 'production',
    };
    const run = (args: string[]) => execFileAsync(process.execPath, args, {
      cwd: runtimeRoot, env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    const validate = async () => {
      const result = await run(['--input-type=module', '-e', `
        import fs from 'node:fs';
        const { validateConfigObject } = await import(${JSON.stringify(pathToFileURL(path.join(runtimeRoot!, 'dist/config/config.js')).href)});
        const result = validateConfigObject(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')));
        console.log(JSON.stringify({ ok: result.ok, issues: result.issues }));
      `, configPath]);
      return JSON.parse(result.stdout);
    };
    const startup = () => run([path.join(runtimeRoot!, 'openclaw-startup-state-migration.mjs')]);
    fs.writeFileSync(configPath, JSON.stringify(corrupted));
    expect(await validate()).toMatchObject({ ok: false, issues: [
      expect.objectContaining({ path: 'agents.defaults.modelPolicy.allow.4' }),
    ] });
    await expect(startup()).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining('Auth migration cannot repair unrelated config errors at: agents.defaults.modelPolicy.allow.4'),
    });

    const repaired = withManagedOpenClawModelPolicy(corrupted, corrupted);
    fs.writeFileSync(configPath, JSON.stringify(repaired));
    expect(await validate()).toMatchObject({ ok: true });
    expect((await startup()).stdout).toContain('"status":"skipped"');
    await run([path.join(runtimeRoot!, 'openclaw.mjs'), 'config', 'set', 'agents.defaults.model.primary', refs[0]]);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(Object.keys(persisted.agents.defaults.models)).toEqual(refs);
    expect(persisted.agents.defaults.modelPolicy).toBeUndefined();
    expect(persisted.meta?.migrations?.modelPolicyAllowlist).toBeUndefined();
    expect(withoutOpenClawWriteMetadata(withManagedOpenClawModelPolicy(persisted, persisted)))
      .toEqual(withoutOpenClawWriteMetadata(persisted));
    expect((await startup()).stdout).toContain('"status":"skipped"');
  }, 240_000);

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
        const result = await call(OpenClawConfigRpcMethod.Apply, { raw: JSON.stringify(desired), baseHash: snapshot.hash });
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
