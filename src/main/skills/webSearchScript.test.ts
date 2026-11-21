import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const REPO_SEARCH_SCRIPT = path.resolve(process.cwd(), 'SKILLs', 'web-search', 'scripts', 'search.sh');
const tempDirs: string[] = [];
const servers: http.Server[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startHttpServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral server port');
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

function runBashAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bash timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      // Restore write permissions on read-only test skill dirs before cleanup.
      fs.chmodSync(dir, 0o755);
      const webSearchDir = path.join(dir, 'web-search');
      if (fs.existsSync(webSearchDir)) fs.chmodSync(webSearchDir, 0o755);
    } catch {
      // ignore chmod cleanup errors
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('SKILLs/web-search/scripts/search.sh sandbox safety', () => {
  test('writes .connection cache to TMPDIR and never attempts to write into read-only PROJECT_DIR', async () => {
    const root = createTempDir('lobsterai-web-search-ro-');
    const skillDir = path.join(root, 'web-search');
    const scriptsDir = path.join(skillDir, 'scripts');
    const customTmp = path.join(root, 'writable-tmp');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(customTmp, { recursive: true });

    const copiedScript = path.join(scriptsDir, 'search.sh');
    fs.copyFileSync(REPO_SEARCH_SCRIPT, copiedScript);
    fs.chmodSync(copiedScript, 0o755);

    // Lock down PROJECT_DIR as strictly read-only so any write to $PROJECT_DIR/.connection fails.
    fs.chmodSync(skillDir, 0o555);

    const seenPaths: string[] = [];
    const { url } = await startHttpServer((req, res) => {
      seenPaths.push(req.url ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/health') {
          res.end(JSON.stringify({ success: true }));
          return;
        }
        if (req.url === '/api/browser/launch') {
          res.end(JSON.stringify({ success: true }));
          return;
        }
        if (req.url === '/api/browser/connect') {
          res.end(JSON.stringify({ success: true, data: { connectionId: 'conn-temp-42' } }));
          return;
        }
        if (req.url === '/api/search') {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query?: string };
          res.end(JSON.stringify({
            success: true,
            data: {
              query: payload.query,
              engine: 'bing',
              totalResults: 1,
              duration: 12,
              results: [
                {
                  title: 'Sandbox Safe Result',
                  url: 'https://sandbox.example.test/docs',
                  snippet: 'Verified temp connection cache without writing to PROJECT_DIR.',
                },
              ],
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false }));
      });
    });

    const result = await runBashAsync([copiedScript, 'sandbox test query', '3'], {
      ...process.env,
      TMPDIR: customTmp,
      USER: 'tester',
      WEB_SEARCH_SERVER: url,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/Operation not permitted|Permission denied/i);
    expect(result.stdout).toContain('Sandbox Safe Result');
    expect(result.stdout).toContain('https://sandbox.example.test/docs');
    expect(seenPaths).toContain('/api/search');
    expect(fs.existsSync(path.join(skillDir, '.connection'))).toBe(false);
    expect(fs.readFileSync(path.join(customTmp, 'lobsterai-web-search-tester.connection'), 'utf8').trim()).toBe(
      'conn-temp-42',
    );
  });

  test('queries direct host bridge via LOBSTERAI_WEB_SEARCH_BRIDGE_FILE with zero writes to read-only PROJECT_DIR', async () => {
    const root = createTempDir('lobsterai-web-search-bridge-');
    const skillDir = path.join(root, 'web-search');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const copiedScript = path.join(scriptsDir, 'search.sh');
    fs.copyFileSync(REPO_SEARCH_SCRIPT, copiedScript);
    fs.chmodSync(copiedScript, 0o755);
    fs.chmodSync(skillDir, 0o555);

    const bridgeSecret = 'bridge-secret-123';
    const receivedOps: Array<{ op?: string; query?: string; engine?: string; secret?: string }> = [];
    const { url } = await startHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          op?: string;
          query?: string;
          engine?: string;
        };
        receivedOps.push({
          op: body.op,
          query: body.query,
          engine: body.engine,
          secret: typeof req.headers['x-mcp-bridge-secret'] === 'string'
            ? req.headers['x-mcp-bridge-secret']
            : undefined,
        });
        res.setHeader('content-type', 'application/json');
        if (body.op === 'status') {
          res.end(JSON.stringify({ success: true, data: { active: true } }));
          return;
        }
        if (body.op === 'search') {
          res.end(JSON.stringify({
            success: true,
            data: {
              query: body.query,
              engine: body.engine,
              totalResults: 1,
              duration: 7,
              results: [
                {
                  title: 'Direct Bridge Result',
                  url: 'https://bridge.example.test/hit',
                  snippet: 'Returned straight from WebSearchHost.',
                },
              ],
            },
          }));
          return;
        }
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'unexpected op' }));
      });
    });

    const bridgeFile = path.join(root, 'web-search-bridge.json');
    fs.writeFileSync(
      bridgeFile,
      JSON.stringify({ version: 1, bridgeUrl: `${url}/web-search/page`, bridgeSecret }),
      'utf8',
    );

    const env = { ...process.env };
    delete env.WEB_SEARCH_SERVER;
    env.LOBSTERAI_WEB_SEARCH_BRIDGE_FILE = bridgeFile;

    const result = await runBashAsync([copiedScript, 'bridge direct query', '3'], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Direct Bridge Result');
    expect(result.stdout).toContain('https://bridge.example.test/hit');
    expect(receivedOps).toEqual([
      { op: 'status', query: undefined, engine: undefined, secret: bridgeSecret },
      { op: 'search', query: 'bridge direct query', engine: 'google', secret: bridgeSecret },
    ]);
    expect(fs.existsSync(path.join(skillDir, '.connection'))).toBe(false);
  });

  test('fails immediately when host bridge reports skill-disabled without falling back', async () => {
    const root = createTempDir('lobsterai-web-search-disabled-');
    const bridgeFile = path.join(root, 'web-search-bridge.json');
    const { url } = await startHttpServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        code: 'skill-disabled',
        error: 'The LobsterAI web-search skill is disabled.',
      }));
    });
    fs.writeFileSync(
      bridgeFile,
      JSON.stringify({ version: 1, bridgeUrl: `${url}/web-search/page`, bridgeSecret: 's' }),
      'utf8',
    );

    const env = { ...process.env };
    delete env.WEB_SEARCH_SERVER;
    env.LOBSTERAI_WEB_SEARCH_BRIDGE_FILE = bridgeFile;

    const result = await runBashAsync([REPO_SEARCH_SCRIPT, 'should fail', '3'], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('web-search skill is disabled');
  });
});
