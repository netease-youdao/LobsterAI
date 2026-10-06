import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { signFile, readPeCertTable, loadDotEnv, _resetForTests } = require('../scripts/win-sign.cjs');

const PE_BODY_MARKER = 'FAKE-PE-BODY-FOR-WIN-SIGN-TEST';
const SIGN_ENV_KEYS = ['YD_SIGN_SERVICE_URL', 'YD_SIGN_APP_KEY', 'YD_SIGN_APP_SECRET', 'YD_SIGN_USERNAME'] as const;

/** Build a minimal but structurally valid PE32+ image. */
function buildMinimalPe(options: { signed: boolean }): Buffer {
  const headerSize = 0x148; // MZ stub (0x40) + PE sig (4) + COFF (20) + optional header (240)
  const bodyEnd = 0x200;
  const cert = Buffer.from('FAKE-AUTHENTICODE-PKCS7-BLOB');
  const certRecordLength = 8 + cert.length;
  const total = options.signed ? bodyEnd + certRecordLength : bodyEnd;

  const pe = Buffer.alloc(total);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x40, 0x3c); // e_lfanew
  pe.write('PE\0\0', 0x40, 'latin1');

  const coff = 0x44;
  pe.writeUInt16LE(0x8664, coff); // machine: x64
  pe.writeUInt16LE(0, coff + 2); // sections
  pe.writeUInt16LE(240, coff + 16); // sizeOfOptionalHeader
  pe.writeUInt16LE(0x22, coff + 18); // characteristics

  const opt = 0x58;
  pe.writeUInt16LE(0x20b, opt); // PE32+
  pe.writeUInt32LE(16, opt + 108); // numberOfRvaAndSizes

  if (options.signed) {
    const certEntry = opt + 112 + 4 * 8; // data directory #4
    pe.writeUInt32LE(bodyEnd, certEntry);
    pe.writeUInt32LE(certRecordLength, certEntry + 4);
    pe.writeUInt32LE(certRecordLength, bodyEnd); // WIN_CERTIFICATE.dwLength
    pe.writeUInt16LE(0x0200, bodyEnd + 4); // wRevision
    pe.writeUInt16LE(2, bodyEnd + 6); // wCertificateType
    cert.copy(pe, bodyEnd + 8);
  }

  pe.write(PE_BODY_MARKER, headerSize, 'latin1');
  return pe;
}

interface MockSignServer {
  baseUrl: string;
  requests: string[];
  mode: 'ok' | 'sign-500';
  lastUploadBody: Buffer | null;
  close: () => Promise<void>;
}

function hasValidAuthHeaders(req: http.IncomingMessage): boolean {
  return (
    req.headers['x-app-key'] === 'test-app-key' &&
    req.headers['x-app-secret'] === 'test-app-secret' &&
    req.headers['x-username'] === 'ci-bot'
  );
}

function startMockSignServer(): Promise<MockSignServer> {
  const state: Omit<MockSignServer, 'baseUrl' | 'close'> = {
    requests: [],
    mode: 'ok',
    lastUploadBody: null,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push(`${req.method} ${req.url}`);

      if (!hasValidAuthHeaders(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid app credentials' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/sign') {
        if (state.mode === 'sign-500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'signer exploded' }));
          return;
        }
        state.lastUploadBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Relative downloadUrl on purpose: the hook must resolve it against the base URL.
        res.end(JSON.stringify({ results: [{ originalName: 'target.exe', downloadUrl: 'api/download/target.exe' }] }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/download/target.exe') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(buildMinimalPe({ signed: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        get requests() { return state.requests; },
        get mode() { return state.mode; },
        set mode(value) { state.mode = value; },
        get lastUploadBody() { return state.lastUploadBody; },
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('win-sign hook', () => {
  let server: MockSignServer;
  let workDir: string;
  let targetPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = await startMockSignServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    for (const key of SIGN_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.YD_SIGN_SERVICE_URL = server.baseUrl;
    process.env.YD_SIGN_APP_KEY = 'test-app-key';
    process.env.YD_SIGN_APP_SECRET = 'test-app-secret';
    process.env.YD_SIGN_USERNAME = 'ci-bot';
    server.mode = 'ok';
    server.requests.length = 0;
    _resetForTests();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-sign-'));
    targetPath = path.join(workDir, 'target.exe');
    fs.writeFileSync(targetPath, buildMinimalPe({ signed: false }));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('parses signed and unsigned PE certificate tables', () => {
    expect(readPeCertTable(targetPath)).toBeNull();
    fs.writeFileSync(targetPath, buildMinimalPe({ signed: true }));
    expect(readPeCertTable(targetPath)).toMatchObject({ offset: 0x200 });
    fs.writeFileSync(targetPath, Buffer.from('not a pe file'));
    expect(() => readPeCertTable(targetPath)).toThrow(/not a PE file/);
  });

  test('signs a binary end-to-end: upload with auth headers, download, replace', async () => {
    const result = await signFile(targetPath);

    expect(result).toBe(true);
    expect(readPeCertTable(targetPath)).not.toBeNull();
    expect(server.requests).toEqual([
      'POST /api/sign',
      'GET /api/download/target.exe',
    ]);
    // The multipart upload must contain the actual binary content.
    expect(server.lastUploadBody?.includes(Buffer.from(PE_BODY_MARKER))).toBe(true);
    expect(fs.existsSync(`${targetPath}.ydsign.tmp`)).toBe(false);
  });

  test.each([
    ['service root', ''],
    ['full /api/sign endpoint', '/api/sign'],
    ['manual upload page', '/sign.html'],
    ['trailing slash', '/'],
  ])('accepts the %s form of YD_SIGN_SERVICE_URL', async (_label, suffix) => {
    process.env.YD_SIGN_SERVICE_URL = `${server.baseUrl}${suffix}`;

    const result = await signFile(targetPath);

    expect(result).toBe(true);
    expect(readPeCertTable(targetPath)).not.toBeNull();
    expect(server.requests[0]).toBe('POST /api/sign');
  });

  test('rejects with the service error when credentials are wrong', async () => {
    process.env.YD_SIGN_APP_SECRET = 'wrong-secret';
    const before = fs.readFileSync(targetPath);

    await expect(signFile(targetPath)).rejects.toThrow(/HTTP 401/);
    expect(fs.readFileSync(targetPath).equals(before)).toBe(true);
  });

  test('skips when any credential (incl. service URL) is missing and leaves the file untouched', async () => {
    const before = fs.readFileSync(targetPath);

    for (const key of SIGN_ENV_KEYS) {
      const saved = process.env[key];
      delete process.env[key];

      const result = await signFile(targetPath);

      expect(result, `expected skip when ${key} is missing`).toBe(false);
      process.env[key] = saved;
    }

    expect(fs.readFileSync(targetPath).equals(before)).toBe(true);
    expect(server.requests).toHaveLength(0);
  });

  test('skips files that already carry a signature without contacting the service', async () => {
    fs.writeFileSync(targetPath, buildMinimalPe({ signed: true }));

    const result = await signFile(targetPath);

    expect(result).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  test('keeps the original file intact when the service fails', async () => {
    server.mode = 'sign-500';
    const before = fs.readFileSync(targetPath);

    await expect(signFile(targetPath)).rejects.toThrow(/HTTP 500/);
    expect(fs.readFileSync(targetPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${targetPath}.ydsign.tmp`)).toBe(false);
  });

  test('loadDotEnv fills missing vars from a .env file without overriding process.env', () => {
    const envPath = path.join(workDir, '.env');
    fs.writeFileSync(envPath, [
      '# signing credentials',
      'YD_SIGN_APP_KEY="from-dotenv-key"',
      "YD_SIGN_APP_SECRET='from-dotenv-secret'",
      'export YD_SIGN_USERNAME=dotenv-bot',
      'MALFORMED LINE IGNORED',
    ].join('\n'));

    delete process.env.YD_SIGN_APP_KEY;
    delete process.env.YD_SIGN_APP_SECRET;
    process.env.YD_SIGN_USERNAME = 'env-wins';

    loadDotEnv(envPath);

    expect(process.env.YD_SIGN_APP_KEY).toBe('from-dotenv-key');
    expect(process.env.YD_SIGN_APP_SECRET).toBe('from-dotenv-secret');
    expect(process.env.YD_SIGN_USERNAME).toBe('env-wins');
  });
});
