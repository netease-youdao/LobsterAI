import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

/** Use the bundled CLI/client and an isolated profile; never contact a provider. */
export async function readRepairedGatewayHistory(params: {
  runtimeRoot: string; env: NodeJS.ProcessEnv; sessionKey: string;
}): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const token = 'isolated-gateway-repair-fixture';
  const entry = path.join(params.runtimeRoot, 'openclaw.mjs');
  const options = { cwd: params.runtimeRoot, env: params.env, windowsHide: true };
  const child = spawn(process.execPath, [entry, 'gateway', 'run', '--bind', 'loopback', '--port', String(port), '--token', token],
    { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Isolated gateway did not listen: ${output}`)), 30_000);
      const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      child.once('error', finish);
      child.once('close', code => finish(new Error(`Isolated gateway exited (${code}): ${output}`)));
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('[gateway] ready')) finish();
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
    });
    const call = (method: string, payload: object) => promisify(execFile)(process.execPath, [entry,
      'gateway', 'call', method, '--params', JSON.stringify(payload), '--json',
      '--url', `ws://127.0.0.1:${port}`, '--token', token,
    ], { ...options, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const health = await call('health', {});
    if (!JSON.parse(health.stdout).ok) throw new Error(`Isolated gateway is unhealthy: ${health.stdout}`);
    return (await call('chat.history', { sessionKey: params.sessionKey })).stdout;
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(timer);
  }
}
