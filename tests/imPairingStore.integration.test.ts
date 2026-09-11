// OPENCLAW_PAIRING_RUNTIME=<built runtime> npm test -- imPairingStore
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { approvePairingCode, listPairingRequests, type PairingGatewayClient, rejectPairingRequest } from '../src/main/im/imPairingStore';
import { IMPairingFailure, OpenClawPairingMethod } from '../src/shared/im/pairing';

const runtimeRoot = process.env.OPENCLAW_PAIRING_RUNTIME;
const FixtureMethod = { Seed: 'im-pairing-fixture.seed', Allowed: 'im-pairing-fixture.allowed' } as const;
const platform = 'email';
const firstAccount = 'bot-one';
const secondAccount = 'bot-two';

interface FixtureGatewayClient extends PairingGatewayClient {
  start(): void;
  stopAndWait(): Promise<void>;
}

function removeFixture(tempDir: string): void {
  if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to clean up outside the temporary fixture directory');
  }
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

test.skipIf(!runtimeRoot)('pairs through the real Gateway and SQLite, preserving account scope across restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-im-pairing-integration-'));
  const stateDir = path.join(tempDir, 'state');
  const configPath = path.join(stateDir, 'openclaw.json');
  const workspace = path.join(stateDir, 'workspace-main');
  const pluginDir = path.join(tempDir, 'pairing-plugin');
  const token = 'im-pairing-isolated-test-token';
  const cliPath = path.join(runtimeRoot!, 'openclaw.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env, OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_SERVICE_REPAIR_POLICY: 'external', OPENCLAW_NO_RESPAWN: '1',
    // Test built JS with the same cache behavior as the packaged runtime; avoid the source launcher's cache-disabling respawn.
    OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: '1',
    OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1', NODE_COMPILE_CACHE: path.join(tempDir, 'compile-cache'), NODE_ENV: 'production',
  };
  delete env.VITEST;
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(path.join(import.meta.dirname, 'fixtures/im-pairing-runtime'), pluginDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    logging: { file: path.join(tempDir, 'gateway.log') },
    gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' }, controlUi: { enabled: false } },
    agents: { ownership: 'explicit', entries: { main: { workspace } },
      defaults: { workspace, systemAgent: { agentId: 'main' }, authInheritance: { agentId: 'main' } } },
    memory: { search: { enabled: true, provider: 'none', fallback: 'none', store: { vector: { enabled: false } } } },
    plugins: { load: { paths: [pluginDir] }, allow: ['memory-core', 'im-pairing-fixture'], entries: {
      'memory-core': { enabled: true, config: { dreaming: { enabled: false } } }, 'im-pairing-fixture': { enabled: true },
    } },
    cron: { enabled: false }, browser: { enabled: false },
  }));

  const readApprovals = () => {
    const db = new DatabaseSync(path.join(stateDir, 'state/openclaw.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT account_id, entry FROM channel_pairing_allow_entries ORDER BY account_id, entry').all();
    } finally { db.close(); }
  };
  let secondCode = '';
  try {
    // Use the same public SDK entry as the desktop adapter, keeping one live connection per Gateway.
    const { GatewayClient } = createRequire(import.meta.url)(path.join(runtimeRoot!, 'dist/plugin-sdk/gateway-runtime.js')) as {
      GatewayClient: new (options: Record<string, unknown>) => FixtureGatewayClient;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const server = net.createServer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as net.AddressInfo).port;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const gateway = spawn(process.execPath, ['--stack-size=8192', cliPath, 'gateway', '--bind', 'loopback', '--port', String(port), '--token', token], {
        cwd: runtimeRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = new Promise<void>(resolve => gateway.once('close', () => resolve()));
      let output = '';
      gateway.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
      gateway.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
      const ready = Promise.withResolvers<void>();
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`, token, env, role: 'operator', scopes: ['operator.admin'], mode: 'backend',
        deviceIdentity: null, sharedStateMode: 'read-only', clientDisplayName: 'LobsterAI pairing test', clientVersion: '1.0.0',
        onHelloOk: () => ready.resolve(), onConnectError: (error: Error) => ready.reject(error),
      });
      try {
        let started = false;
        let lastProbe = 'not reachable';
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline && gateway.exitCode === null) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) });
            const status = await response.json() as { status?: string };
            lastProbe = JSON.stringify(status);
            if (response.ok && status.status === 'started') { started = true; break; }
          } catch { /* The isolated Gateway has not bound its port yet. */ }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        expect(started, `${output.replaceAll(token, '[REDACTED]')}\nLast startup probe: ${lastProbe}`).toBe(true);
        const handshakeTimer = setTimeout(() => ready.reject(new Error('Pairing test handshake timed out')), 30_000);
        try {
          client.start();
          await ready.promise;
        } finally { clearTimeout(handshakeTimer); }
        const configBefore = fs.readFileSync(configPath, 'utf8');
        if (attempt === 0) {
          const first = await client.request<{ code: string }>(FixtureMethod.Seed, { accountId: firstAccount, id: 'shared-sender' }, { timeoutMs: 120_000 });
          const second = await client.request<{ code: string }>(FixtureMethod.Seed, { accountId: secondAccount, id: 'shared-sender' });
          const rejected = await client.request<{ code: string }>(FixtureMethod.Seed, { accountId: firstAccount, id: 'rejected-sender' });
          secondCode = second.code;
          // The channel's normal runtime API writes SQLite without creating the old JSON store.
          const legacyPath = path.join(stateDir, 'credentials/email-pairing.json');
          expect(fs.existsSync(legacyPath)).toBe(false);
          expect((await listPairingRequests(client, platform)).requests).toHaveLength(3);
          const publicList = await client.request<{ requests: Array<{ code?: string }> }>(OpenClawPairingMethod.List, { channel: platform });
          expect(publicList.requests).toHaveLength(3);
          expect(publicList.requests.every(request => request.code === undefined)).toBe(true);

          // Stale data created after startup must neither hide requests nor receive new approvals.
          fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
          const legacyContent = JSON.stringify({ version: 1, requests: [] });
          fs.writeFileSync(legacyPath, legacyContent);
          await expect(approvePairingCode(client, platform, second.code, firstAccount))
            .rejects.toMatchObject({ code: IMPairingFailure.NotFound });
          await approvePairingCode(client, platform, first.code.toLowerCase(), firstAccount);
          await rejectPairingRequest(client, platform, rejected.code, firstAccount);
          await expect(approvePairingCode(client, platform, first.code, firstAccount))
            .rejects.toMatchObject({ code: IMPairingFailure.NotFound });
          expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyContent);
          expect(fs.existsSync(path.join(stateDir, 'credentials/email-bot-one-allowFrom.json'))).toBe(false);
          fs.unlinkSync(legacyPath);
        } else {
          const pending = await listPairingRequests(client, platform);
          expect(pending.requests).toEqual([expect.objectContaining({ code: secondCode, accountId: secondAccount })]);
          await rejectPairingRequest(client, platform, secondCode, secondAccount);
          expect((await listPairingRequests(client, platform)).requests).toEqual([]);
        }
        // The plugin's canonical read and a read-only DB inspection agree; the adapter chooses the stored identity.
        expect(await client.request(FixtureMethod.Allowed, { accountId: firstAccount })).toEqual({ entries: ['fixture-allow:shared-sender'], notifications: 0 });
        expect(await client.request(FixtureMethod.Allowed, { accountId: secondAccount })).toEqual({ entries: [], notifications: 0 });
        expect(readApprovals()).toEqual([{ account_id: firstAccount, entry: 'fixture-allow:shared-sender' }]);
        expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
      } catch (error) {
        throw new Error(`${String(error)}\nGateway output:\n${output.replaceAll(token, '[REDACTED]')}`, { cause: error });
      } finally {
        try { await client.stopAndWait(); } finally {
          if (gateway.exitCode === null) gateway.kill();
          await closed;
        }
      }
    }
  } finally {
    removeFixture(tempDir);
  }
}, 540_000);
