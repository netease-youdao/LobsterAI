// OPENCLAW_SQLITE_WORKER_SOURCE=<patched source> npm test -- openclawSqliteWorkerProtocol.runtime
// Builds the real owner and worker in both shipped layouts; uses disposable SQLite data only.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const source = process.env.OPENCLAW_SQLITE_WORKER_SOURCE;
const require = createRequire(import.meta.url);
const { buildOpenClawWorkerShimContent } = require('../scripts/openclaw-worker-shims.cjs');
const execute = promisify(execFile);
const Mode = { Sync: 'sync', Async: 'async' } as const;
const Layout = { Dist: 'dist', Bundle: 'bundle' } as const;
const Fault = {
  Noise: 'noise', Missing: 'missing', Malformed: 'malformed', Spawn: 'spawn', Link: 'link',
  Shape: 'shape', Oversized: 'oversized', Exit: 'exit', WorkerError: 'worker-error', Write: 'write',
} as const;
type Fault = typeof Fault[keyof typeof Fault];
const layouts = Object.values(Layout);
const modes = Object.values(Mode);
const roots: string[] = [];
let runtime: string;

function temporaryDirectory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-sqlite-protocol-')));
  roots.push(root);
  return root;
}

const runner = `
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [entry, mode, databasePath] = process.argv.slice(2);
const api = await import(entry);
if (process.env.LOBSTER_SQLITE_TEST_FAULT === 'spawn') process.execPath += '-missing';
let prepared;
try {
  prepared = await (mode === 'sync' ? api.prepareSqliteReadOnlyLocationSync : api.prepareSqliteReadOnlyLocation)(databasePath);
  const database = new DatabaseSync(prepared.location, { readOnly: true });
  let rows;
  try { rows = database.prepare('SELECT value FROM probe ORDER BY rowid').all(); } finally { database.close(); }
  const location = prepared.location;
  const cleaned = prepared.cleanup();
  process.stdout.write(JSON.stringify({ ok: true, rows, cleaned, snapshotExists: fs.existsSync(location) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
} finally { prepared?.cleanup(); }
`;

const faultInjector = `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
if (process.argv.includes('--openclaw-sqlite-readonly-child')) {
  const fault = process.env.LOBSTER_SQLITE_TEST_FAULT;
  const resultIndex = process.argv.indexOf('--openclaw-sqlite-readonly-result-file');
  const resultPath = resultIndex < 0 ? undefined : process.argv[resultIndex + 1];
  const noise = '[0x7FF89BE13B00] ANOMALY: meaningless REX prefix used\\r\\n';
  const originalWrite = fs.writeFileSync;
  if (fault === 'noise') {
    fs.writeSync(1, noise + '{"ok":false,"message":"stdout is not protocol data"}');
    fs.appendFileSync(process.env.LOBSTER_SQLITE_TEST_TRACE, 'prefix\\n');
  }
  if (fault === 'write') {
    fs.writeFileSync = function(file, ...args) {
      if (String(file) === resultPath) throw Object.assign(new Error('fixture result write denied'), { code: 'EACCES' });
      return originalWrite.call(this, file, ...args);
    };
    syncBuiltinESMExports();
  }
  process.on('exit', () => {
    if (fault === 'noise') {
      fs.writeSync(1, noise);
      fs.writeSync(2, 'fixture stderr diagnostic\\n');
      fs.appendFileSync(process.env.LOBSTER_SQLITE_TEST_TRACE, 'suffix\\n');
    }
    if (fault === 'exit') process.exitCode = 23;
    if (!resultPath || !fs.existsSync(resultPath)) return;
    if (fault === 'missing') fs.unlinkSync(resultPath);
    if (fault === 'malformed') originalWrite(resultPath, '{"ok":');
    if (fault === 'shape') originalWrite(resultPath, '{"ok":true,"location":42}');
    if (fault === 'oversized') originalWrite(resultPath, 'x'.repeat(65537));
    if (fault === 'link') fs.linkSync(resultPath, resultPath + '.link');
    if (fault === 'worker-error') originalWrite(resultPath, '{"ok":false,"message":"fixture snapshot failed"}');
  });
}
`;

describe.skipIf(!source)('SQLite worker result channel with real subprocesses', () => {
  beforeAll(async () => {
    runtime = temporaryDirectory();
    fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(path.join(source!, 'node_modules'), path.join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const common = {
      bundle: true, platform: 'node' as const, format: 'esm' as const, packages: 'external' as const,
      banner: { js: 'import { createRequire as __testCreateRequire } from "node:module"; const require = __testCreateRequire(import.meta.url);' },
      logLevel: 'silent' as const,
    };
    await build({ ...common, outdir: path.join(runtime, 'dist/infra'), entryPoints: [
      path.join(source!, 'src/infra/sqlite-readonly-location.ts'),
      path.join(source!, 'src/infra/sqlite-readonly-location.worker.ts'),
    ] });
    await build({ ...common, outfile: path.join(runtime, 'owner-bundle.mjs'),
      entryPoints: [path.join(source!, 'src/infra/sqlite-readonly-location.ts')] });
    fs.writeFileSync(path.join(runtime, 'sqlite-readonly-location.worker.mjs'),
      buildOpenClawWorkerShimContent('dist/infra/sqlite-readonly-location.worker.js'));
    fs.writeFileSync(path.join(runtime, 'runner.mjs'), runner);
    fs.writeFileSync(path.join(runtime, 'fault.cjs'), faultInjector);
  }, 60_000);

  afterAll(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function probe(layout: typeof layouts[number], mode: typeof modes[number], fault: Fault, missingDatabase = false) {
    const root = temporaryDirectory();
    const databasePath = path.join(root, '用户数据 with spaces.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('preserved history');");
    database.close();
    const digest = () => createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
    const before = digest();
    const cache = path.join(root, 'cache');
    const trace = path.join(root, 'noise.log');
    const entry = layout === Layout.Bundle ? 'owner-bundle.mjs' : 'dist/infra/sqlite-readonly-location.js';
    const { stdout } = await execute(process.execPath, [path.join(runtime, 'runner.mjs'),
      pathToFileURL(path.join(runtime, entry)).href, mode, missingDatabase ? path.join(root, 'missing.sqlite') : databasePath,
    ], { cwd: runtime, timeout: 60_000, env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: root, USERPROFILE: root, XDG_CACHE_HOME: cache, LOCALAPPDATA: root,
      TMP: root, TEMP: root, TMPDIR: root, ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: path.join(root, 'state'),
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(runtime, 'fault.cjs'))}`,
      LOBSTER_SQLITE_TEST_FAULT: fault, LOBSTER_SQLITE_TEST_TRACE: trace,
    } });
    expect(digest()).toBe(before);
    const cacheDirectories = fs.readdirSync(cache, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('openclaw-sqlite-'))
      .map(entry => entry.name);
    expect(cacheDirectories.filter(name => name.startsWith('openclaw-sqlite-result-'))).toEqual([]);
    return { output: JSON.parse(stdout), cacheDirectories,
      trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '' };
  }

  for (const layout of layouts) {
    for (const mode of modes) {
      test(`${layout}/${mode} reads and cleans a snapshot despite native stdout prefix/suffix noise`, async () => {
        const result = await probe(layout, mode, Fault.Noise);
        expect(result.output).toEqual({ ok: true, rows: [{ value: 'preserved history' }], cleaned: true, snapshotExists: false });
        expect(result.trace).toBe('prefix\nsuffix\n');
        expect(result.cacheDirectories).toEqual([]);
      }, 60_000);
    }
  }

  for (const mode of modes) {
    test(`${mode} preserves the actual SQLite error with noisy stdout`, async () => {
      const result = await probe(Layout.Dist, mode, Fault.Noise, true);
      expect(result.output.ok).toBe(false);
      expect(result.output.error).toContain('ENOENT');
      expect(result.output.error).not.toContain('invalid JSON');
      expect(result.cacheDirectories).toEqual([]);
    }, 60_000);

    test.each([
      [Fault.Missing, /ENOENT/], [Fault.Malformed, /invalid JSON/], [Fault.Shape, /invalid result/],
      [Fault.Oversized, /invalid result file/], [Fault.Exit, /23/],
      [Fault.WorkerError, /fixture snapshot failed/], [Fault.Write, /fixture result write denied/],
      [Fault.Spawn, /ENOENT/], [Fault.Link, /invalid result file/],
    ] as const)(`${mode} rejects %s rather than accepting stdout or an unsuccessful child`, async (fault, message) => {
      const result = await probe(Layout.Dist, mode, fault);
      expect(result.output.ok).toBe(false);
      expect(result.output.error).toMatch(message);
      if (fault === Fault.Write || fault === Fault.Spawn) expect(result.cacheDirectories).toEqual([]);
    }, 60_000);
  }
});
