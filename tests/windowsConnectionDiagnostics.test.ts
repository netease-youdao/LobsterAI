import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const toolDirectory = path.resolve(__dirname, '../scripts/support/windows-gateway-diagnostics');
const probeModule = path.join(toolDirectory, 'connection-probe.cjs');
const {
  RESULT_MARKER, crossProcessServerTest, fetchLikeApp, inProcessSelfTest, normalizePorts,
  probeGatewayPort, proxyEnvironment, runProbe, tcpConnect,
} = require(probeModule);
const { buildConnectionCollector, PROBE_VARIABLE } = require('../scripts/support/windows-gateway-diagnostics/build-connection-collector.cjs');
const directories: string[] = [];
const servers: net.Server[] = [];

function fixtureDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-connection-probe-'));
  directories.push(root);
  return root;
}

async function listenOnFreePort(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

/** A port that was free a moment ago, so connections to it are refused. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fakeGateway(): http.Server {
  return http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/startupz' ? '{"ok":true,"status":"started"}' : '{"ok":true}');
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('reports the connect error behind fetch failed, as the app only logs the outer message', async () => {
  const port = await closedPort();
  const fetched = await fetchLikeApp(`http://127.0.0.1:${port}/startupz`, 3000);
  expect(fetched).toMatchObject({ ok: false, code: 'ECONNREFUSED' });
  expect(fetched.error).toMatchObject({ name: 'TypeError', message: 'fetch failed', cause: { code: 'ECONNREFUSED', syscall: 'connect' } });
  expect(await tcpConnect(port, 3000)).toMatchObject({ ok: false, code: 'ECONNREFUSED' });
});

test('names a connection that is accepted and then dropped', async () => {
  const port = await listenOnFreePort(net.createServer((socket) => socket.destroy()));
  const fetched = await fetchLikeApp(`http://127.0.0.1:${port}/startupz`, 3000);
  expect(fetched.ok).toBe(false);
  expect(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']).toContain(fetched.code);
  expect(await tcpConnect(port, 3000)).toMatchObject({ ok: true, code: null });
});

test('reads the startup status from a reachable gateway', async () => {
  const port = await listenOnFreePort(fakeGateway());
  const entry = await probeGatewayPort(port, Date.now() + 30000);
  expect(entry.summary).toMatchObject({ tcpOk: 3, tcpTotal: 3, fetchOk: 4, fetchTotal: 4, httpOk: true, errorCodes: [], startupStatus: 'HTTP 200 started' });
  expect(entry.fetch['/startupz'][0]).toMatchObject({ ok: true, status: 200, payloadStatus: 'started' });
});

test('runs loopback self-tests in one process and across two runtime processes', async () => {
  const self = await inProcessSelfTest();
  expect(self).toMatchObject({ ok: true, tcpEcho: { ok: true }, fetch: { ok: true, status: 200 } });
  const workDir = fixtureDirectory();
  const cross = await crossProcessServerTest({ port: 0, workDir });
  expect(cross).toMatchObject({ ok: true, listen: { listening: true }, tcp: { ok: true }, fetch: { ok: true, status: 200 } });
  expect(cross.listen.pid).not.toBe(process.pid);
  expect(fs.readdirSync(workDir)).toEqual([]);
});

test('reports a fixed port that another program already holds', async () => {
  const port = await listenOnFreePort(net.createServer());
  const result = await crossProcessServerTest({ port, workDir: fixtureDirectory() });
  expect(result).toMatchObject({ ok: false, requestedPort: port, listen: { listening: false, code: 'EADDRINUSE' } });
});

test('writes a complete report and keeps fixed-port tests off while the app runs', async () => {
  const root = fixtureDirectory();
  const port = await closedPort();
  const reportPath = path.join(root, 'report.json');
  const report = await runProbe({ reportPath, workDir: path.join(root, 'work'), ports: port, allowFixedPortTest: false, budgetMs: 30000 });
  expect(report.ports).toEqual([port]);
  expect(report.gateway[0].summary).toMatchObject({ tcpOk: 0, fetchOk: 0, errorCodes: ['ECONNREFUSED'], startupStatus: null });
  expect(report.selfTest.ok).toBe(true);
  expect(report.crossProcess.ok).toBe(true);
  expect(report.fixedPort).toMatchObject({ skipped: expect.any(String) });
  expect(JSON.parse(fs.readFileSync(reportPath, 'utf8')).finishedAt).toBe(report.finishedAt);
});

test('runs from the command line like LobsterAI.exe does and prints one result line', () => {
  const root = fixtureDirectory();
  const requestPath = path.join(root, 'request.json');
  // PowerShell writes the request; a BOM must not break it.
  fs.writeFileSync(requestPath, `\uFEFF${JSON.stringify({ reportPath: path.join(root, 'report.json'), workDir: root, ports: [1], budgetMs: 20000 })}`);
  const run = spawnSync(process.execPath, [probeModule, requestPath], { encoding: 'utf8', timeout: 60000 });
  expect(run.status).toBe(0);
  const line = run.stdout.split('\n').find((entry) => entry.startsWith(RESULT_MARKER));
  expect(JSON.parse(line!.slice(RESULT_MARKER.length))).toMatchObject({ gateway: [{ port: 1, tcpOk: 0 }], selfTest: true, crossProcess: true });
});

test('normalizes requested ports and hides proxy credentials', () => {
  expect(normalizePorts(18789)).toEqual([18789]);
  expect(normalizePorts([18789, '18790', 18789, 0, 70000, 'x', 1, 2, 3])).toEqual([18789, 18790, 1]);
  expect(normalizePorts(undefined)).toEqual([]);
  expect(proxyEnvironment({ HTTP_PROXY: 'http://user:secret@127.0.0.1:7890', NODE_USE_ENV_PROXY: '1', PATH: '/bin' }))
    .toEqual({ HTTP_PROXY: 'http://<USERINFO>@127.0.0.1:7890', NODE_USE_ENV_PROXY: '1' });
});

test('builds one launcher that embeds the collector, helpers and probe', () => {
  const text: string = buildConnectionCollector();
  // cmd.exe would treat a BOM as part of the first command.
  expect(text.charCodeAt(0)).toBe('<'.charCodeAt(0));
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  const lines = text.split('\r\n');
  const batchEnd = lines.indexOf('#>');
  const batch = lines.slice(0, batchEnd);
  expect(batch[0].startsWith('<# : ')).toBe(true);
  expect(batch.join('\n')).not.toMatch(/[^\x20-\x7e\n]/);
  expect(batch).toContain('title LobsterAI Engine Connection Diagnostics');
  expect(lines[batchEnd + 1]).toBe('param(');
  expect(lines.filter((line) => line.startsWith('param(')).length).toBe(1);
  expect(text).toContain('function Protect-DiagnosticText');
  expect(text).toContain('function Get-ConnectionVerdict');
  const probeStart = lines.indexOf(`${PROBE_VARIABLE} = @'`);
  const probeEnd = lines.indexOf("'@", probeStart);
  const probeSource = fs.readFileSync(probeModule, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  expect(probeStart).toBeGreaterThan(batchEnd);
  expect(lines.slice(probeStart + 1, probeEnd).join('\n')).toBe(probeSource);
  // The collector writes the embedded probe out instead of looking next to the .cmd.
  expect(text).toContain('if ($script:EmbeddedConnectionProbe) {');
});
