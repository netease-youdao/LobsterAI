import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { NSP_CLAWGUARD, patchEnabledNspClawguard } from '../src/main/plugins/nspClawguardCompatibility';
import { OpenClawRepairPluginSource } from '../src/shared/openclawEngine/repair';
import { OPENCLAW_STARTUP_COMPATIBILITY_ENTRY, OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX, OpenClawStartupCompatibilityMode } from '../src/shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../src/shared/openclawEngine/startupMigration';

// Opt-in: freshly bundle the startup helper into an isolated runtime copy and
// supply the two published archives. Nothing is downloaded during this test.
const runtimeRoot = process.env.NSP_CLAWGUARD_TEST_RUNTIME;
const archiveDir = process.env.NSP_CLAWGUARD_TEST_ARCHIVES;
const executable = process.env.NSP_CLAWGUARD_TEST_NODE || process.execPath;
const execAsync = promisify(execFile);
const id = NSP_CLAWGUARD.Id;

test.skipIf(!runtimeRoot || !archiveDir).each(NSP_CLAWGUARD.Releases)(
  '$version repairs the stale npm receipt and survives two real gateway starts', async release => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-startup-integration-'));
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
    const userDataDir = path.join(temp, 'AppData', 'LobsterAI');
    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    const configPath = path.join(stateDir, 'openclaw.json');
    const pluginDir = path.join(userDataDir, 'third-party-extensions', id);
    const oldPath = path.join(stateDir, 'extensions', id);
    const dbPath = path.join(stateDir, 'state', 'openclaw.sqlite');
    const token = 'isolated-nsp-startup-test';
    const proxy = http.createServer((_request, response) => { response.writeHead(404); response.end('offline test'); });
    proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'));
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: temp, USERPROFILE: temp, APPDATA: path.join(temp, 'AppData'), LOCALAPPDATA: path.join(temp, 'Local'),
      TEMP: temp, TMP: temp, TMPDIR: temp, XDG_CACHE_HOME: path.join(temp, 'cache'),
      OPENCLAW_HOME: path.dirname(stateDir), OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_NO_AUTO_UPDATE: '1', ELECTRON_RUN_AS_NODE: '1',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      npm_config_registry: proxyUrl, npm_config_fetch_retries: '0',
    };
    const config = {
      gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token }, controlUi: { enabled: false } },
      agents: { entries: { main: { workspace: path.join(stateDir, 'workspace-main') } } },
      plugins: { allow: [id], load: { paths: [path.dirname(pluginDir)] },
        slots: { memory: 'none' }, entries: { [id]: { enabled: false } } },
      cron: { enabled: false }, browser: { enabled: false },
      logging: { file: path.join(temp, 'gateway.log') },
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    execFileSync('tar', ['-xf', path.join(archiveDir!, `${id}-${release.version}.tgz`), '-C', pluginDir, '--strip-components', '1']);
    const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
    const originalManifest = fs.readFileSync(manifestPath);
    fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify({ mode: 'offline' }));
    fs.writeFileSync(configPath, JSON.stringify(config));
    // Windows normally uses Jiti; exercise the macOS-like native ESM path on
    // the second start, targeting only this isolated plugin. Keep every hook.
    const nativeLoader = path.join(temp, 'native-clawguard.cjs');
    fs.writeFileSync(nativeLoader, `
      const Module = require('node:module');
      const { pathToFileURL } = require('node:url');
      const entry = process.env.LOBSTERAI_TEST_NSP_ENTRY;
      const entryUrl = pathToFileURL(entry).href;
      const load = Module._load;
      Module._load = function(id, ...rest) {
        const value = load.call(this, id, ...rest);
        if (id !== 'jiti') return value;
        return new Proxy(value, { get(target, key) {
          if (key !== 'createJiti') return target[key];
          return (...args) => new Proxy(target.createJiti(...args), { apply(fn, receiver, params) {
            if (params[0] !== entry && params[0] !== entryUrl) return Reflect.apply(fn, receiver, params);
            const plugin = require(entry);
            console.log('[nsp-test] native ESM entry loaded');
            return plugin;
          }});
        }});
      };
    `);
    const readIndex = (db: DatabaseSync) => JSON.parse(String(db.prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
    ).get()?.value_json));
    const patch = () => patchEnabledNspClawguard({ plugins: [{ pluginId: id, enabled: true }], userDataDir, stateDir });

    async function prepare() {
      const result = await execAsync(executable, [path.join(runtimeRoot!, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), OpenClawStartupCompatibilityMode.PrepareStartup],
        { cwd: runtimeRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }).catch(error => {
          throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`);
        });
      const line = result.stdout.split(/\r?\n/).find(value => value.startsWith(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX));
      expect(line, result.stdout + result.stderr).toBeDefined();
      return JSON.parse(line!.slice(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX.length));
    }

    async function boot(holdMs: number, expectFailure = false, nativeEntry = false) {
      // Avoid Windows' dynamic client-port pool: a released port from listen(0)
      // can be claimed by outbound traffic before the gateway finishes loading.
      let port = 0;
      for (let attempt = 0; attempt < 10 && !port; attempt += 1) {
        const server = net.createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(20_000 + Math.floor(Math.random() * 10_000), '127.0.0.1', resolve);
          });
          port = (server.address() as net.AddressInfo).port;
          await new Promise<void>(resolve => server.close(() => resolve()));
        } catch (error) {
          if (!['EACCES', 'EADDRINUSE'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      if (!port) throw new Error('No available integration-test gateway port');
      const startedAt = Date.now();
      const child = spawn(executable, [...(nativeEntry ? ['--require', nativeLoader] : []),
        path.join(runtimeRoot!, 'gateway-launcher.cjs'), 'gateway', '--port', String(port)],
      { cwd: runtimeRoot, env: { ...env, LOBSTERAI_TEST_NSP_ENTRY: path.join(pluginDir, NSP_CLAWGUARD.Entry) },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      let output = '';
      const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-40_000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      try {
        let readyAt = 0;
        const deadline = Date.now() + 90_000 + holdMs;
        while (Date.now() < deadline && child.exitCode === null) {
          if (expectFailure && /Failed to update nsp-clawguard/.test(output)) break;
          try {
            const response = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) });
            if (response.ok && (await response.json() as { status: string }).status === 'started') {
              readyAt ||= Date.now();
              if (Date.now() - readyAt >= holdMs) break;
            }
          } catch { /* wait for startup */ }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (expectFailure) {
          expect(readyAt, output).toBe(0);
          expect(output).toContain('Failed to update nsp-clawguard');
        } else {
          expect(readyAt > 0 && Date.now() - readyAt >= holdMs && child.exitCode === null, output).toBe(true);
          expect(output).not.toMatch(/Dynamic require|__dirname is not defined|plugin register must be synchronous|requires capability consent|Failed to update nsp-clawguard/);
          if (nativeEntry && process.platform === 'win32') expect(output).toContain('[nsp-test] native ESM entry loaded');
          if (config.plugins.entries[id].enabled) {
            const securityDbPath = path.join(pluginDir, 'data', 'lm-security.db');
            expect(fs.statSync(securityDbPath).mtimeMs).toBeGreaterThanOrEqual(startedAt);
            const securityDb = new DatabaseSync(securityDbPath, { readOnly: true });
            try { expect(securityDb.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok'); }
            finally { securityDb.close(); }
          }
        }
      } finally {
        if (child.connected) child.send({ type: 'lobsterai:gateway:shutdown' });
        else child.kill();
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        await closed;
        clearTimeout(force);
      }
    }

    try {
      await boot(0);
      const db = new DatabaseSync(dbPath);
      const before = readIndex(db);
      before.index.installRecords[id] = {
        source: OpenClawRepairPluginSource.Npm, spec: `${id}@2.4.13`,
        resolvedName: id, version: '2.4.13', installPath: oldPath,
      };
      db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = 'plugins.installedIndex'").run(JSON.stringify(before));
      db.close();
      config.plugins.entries[id].enabled = true;
      fs.writeFileSync(configPath, JSON.stringify(config));
      expect(patch()).toBe(true);
      if (release.registrationHash) {
        expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual({
          ...JSON.parse(originalManifest.toString('utf8')), activation: { onStartup: true },
        });
        const manifestBackup = fs.readdirSync(pluginDir).find(file => file.startsWith('openclaw.plugin.json.lobsterai-startup-manifest-v1.'));
        expect(fs.readFileSync(path.join(pluginDir, manifestBackup!))).toEqual(originalManifest);
        const entry = path.join(pluginDir, NSP_CLAWGUARD.Entry);
        const patched = fs.readFileSync(entry, 'utf8');
        expect(patched).not.toContain('async function register(api) {');
        // Also complete a partial repair that already has the native context.
        fs.writeFileSync(entry, patched.replace('function register(api) {', 'async function register(api) {'));
        expect(patch()).toBe(true);
        expect(fs.readFileSync(entry, 'utf8')).toBe(patched);
      }
      // This is the original incident even with the native module patch applied.
      await boot(0, true);
      const report = await prepare();
      expect(report).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
      const repaired = new DatabaseSync(dbPath, { readOnly: true });
      const saved = new DatabaseSync(report.backups.at(-1), { readOnly: true });
      try {
        expect(readIndex(repaired).index.installRecords[id]).toMatchObject({
          source: OpenClawRepairPluginSource.Path, installPath: pluginDir, version: release.version,
        });
        expect(readIndex(saved).index.installRecords[id].installPath).toBe(oldPath);
      } finally { repaired.close(); saved.close(); }
      await boot(60_000);
      expect(patch()).toBe(false);
      expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, changes: [], backups: [] });
      await boot(15_000, false, true);
      expect(fs.existsSync(oldPath)).toBe(false);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 360_000,
);
