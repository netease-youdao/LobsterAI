import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { WeixinPlugin } from '../src/shared/im/weixin';
import { OPENCLAW_REPAIR_RESULT_PREFIX, OpenClawRepairPhase } from '../src/shared/openclawEngine/repair';

const runtimeRoot = process.env.OPENCLAW_PLUGIN_REPAIR_RUNTIME;
const execFileAsync = promisify(execFile);

test.skipIf(!runtimeRoot)('bundled repair reconciles a migrated Weixin ledger and boots twice with the shipped plugin', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-plugin-repair-integration-'));
  const stateDir = path.join(tempDir, 'admin', 'LobsterAI', 'openclaw', 'state');
  const configPath = path.join(stateDir, 'openclaw.json');
  const backupDir = path.join(tempDir, 'backup');
  const pluginRoot = path.join(fs.realpathSync(runtimeRoot!), 'third-party-extensions', WeixinPlugin.Id);
  const oldPath = path.join(tempDir, 'old-user', 'LobsterAI', 'openclaw', 'state', 'npm', 'projects',
    'tencent-weixin-openclaw-weixin-7783ac86ba', 'node_modules', '@tencent-weixin', 'openclaw-weixin');
  const token = 'isolated-plugin-repair-token';
  const env = {
    ...process.env, OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_NO_AUTO_UPDATE: '1', XDG_CACHE_HOME: path.join(tempDir, 'cache'),
  };
  const cliPath = path.join(runtimeRoot!, 'openclaw.mjs');
  const config = {
    gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token }, controlUi: { enabled: false } },
    agents: { entries: { main: { workspace: path.join(stateDir, 'workspace-main') } } },
    plugins: { allow: [WeixinPlugin.Id], load: { paths: [pluginRoot] },
      slots: { memory: 'none' }, entries: { [WeixinPlugin.Id]: { enabled: false } } },
    channels: { [WeixinPlugin.Id]: { enabled: false } },
    cron: { enabled: false }, browser: { enabled: false },
    logging: { file: path.join(tempDir, 'gateway.log') },
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(backupDir);
  fs.writeFileSync(configPath, JSON.stringify(config));
  const dbPath = path.join(stateDir, 'state', 'openclaw.sqlite');
  const readIndex = (db: DatabaseSync) => JSON.parse(String(db.prepare(
    "SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
  ).get()?.value_json));

  async function bootAndProbe(enabled: boolean) {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const child = spawn(process.execPath, [cliPath, 'gateway', '--port', String(port)], {
      cwd: runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
    try {
      let ready = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) });
          const status = await response.json() as { status?: string };
          if (response.ok && status.status === 'started') { ready = true; break; }
        } catch { /* wait for startup */ }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      expect(ready, output.replaceAll(token, '[redacted]')).toBe(true);
      // Use the same SDK client/explicit-token handshake as Electron. Some
      // packaged CLI routes exit before their one-shot RPC prints a result.
      const probe = `
        const { GatewayClient } = require(process.argv[1]);
        const timeout = setTimeout(() => { console.error('RPC timeout'); process.exit(1); }, 20000);
        const client = new GatewayClient({
          url: process.argv[2], token: process.env.OPENCLAW_GATEWAY_TOKEN,
          mode: 'backend', role: 'operator', scopes: ['operator.admin'], deviceIdentity: null,
          onHelloOk: async () => {
            try { console.log(JSON.stringify(await client.request('config.get', {}))); }
            catch (error) { console.error(error); process.exitCode = 1; }
            finally { client.stop(); clearTimeout(timeout); }
          },
          onConnectError: error => { console.error(error); client.stop(); clearTimeout(timeout); process.exitCode = 1; },
        });
        client.start();
      `;
      const response = await execFileAsync(process.execPath, ['-e', probe,
        path.join(runtimeRoot!, 'dist', 'plugin-sdk', 'gateway-runtime.js'), `ws://127.0.0.1:${port}`],
      { cwd: runtimeRoot, env, timeout: 30_000 });
      const result = JSON.parse(response.stdout);
      expect(result.valid).toBe(true);
      expect(result.config.plugins.entries[WeixinPlugin.Id].enabled).toBe(enabled);
      expect(output).not.toContain('requires capability consent');
    } finally {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      await closed;
      clearTimeout(force);
    }
  }

  try {
    await bootAndProbe(false);
    const db = new DatabaseSync(dbPath);
    const before = readIndex(db);
    before.index.installRecords[WeixinPlugin.Id] = {
      source: 'npm', spec: '@tencent-weixin/openclaw-weixin@2.4.3',
      resolvedName: '@tencent-weixin/openclaw-weixin', version: '2.4.3', installPath: oldPath,
    };
    db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = 'plugins.installedIndex'").run(JSON.stringify(before));
    db.close();
    const request = path.join(backupDir, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ phase: OpenClawRepairPhase.Plugins, backupDir }));
    const result = await execFileAsync(process.execPath, [path.join(runtimeRoot!, 'openclaw-gateway-repair.mjs'), request], {
      cwd: runtimeRoot, env, timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    const line = result.stdout.split('\n').find(value => value.startsWith(OPENCLAW_REPAIR_RESULT_PREFIX));
    const report = JSON.parse(line!.slice(OPENCLAW_REPAIR_RESULT_PREFIX.length));
    expect(report, result.stdout + result.stderr).toMatchObject({ success: true });
    const repaired = new DatabaseSync(dbPath, { readOnly: true });
    const saved = new DatabaseSync(path.join(backupDir, 'original', 'state', 'openclaw.sqlite'), { readOnly: true });
    try {
      expect(readIndex(repaired).index.installRecords[WeixinPlugin.Id].installPath).toBe(pluginRoot);
      expect(readIndex(saved).index.installRecords[WeixinPlugin.Id].installPath).toBe(oldPath);
    } finally { repaired.close(); saved.close(); }
    expect(fs.existsSync(oldPath)).toBe(false);
    // Retain the consent written by the helper while enabling the QR plugin.
    const repairedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    repairedConfig.plugins.entries[WeixinPlugin.Id].enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(repairedConfig));
    await bootAndProbe(true);
    await bootAndProbe(true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}, 180_000);
