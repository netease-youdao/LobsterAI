import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { classifyOutput, childEnvironment, runProbe } = require('../scripts/support/windows-gateway-diagnostics/worker-probe.cjs');
const directories: string[] = [];

function fixtureDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-diagnostic-test-'));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('distinguishes stdout contamination from worker failure and successful results', () => {
  const good = JSON.stringify({ ok: true, location: 'C:\\temp\\snapshot.sqlite' });
  const noise = '[0x7FFD40063B00] ANOMALY: meaningless REX prefix used';
  expect(classifyOutput(good, 0)).toMatchObject({ validWholeStdoutJson: true, validWorkerResult: true, successfulExitWithInvalidJson: false });
  for (const output of [noise + '\n' + good, good + noise, good + '\r\n' + noise]) {
    expect(classifyOutput(output, 0)).toMatchObject({ containsAnomaly: true, validWholeStdoutJson: false, successfulExitWithInvalidJson: true });
  }
  expect(classifyOutput(noise, 1)).toMatchObject({ containsAnomaly: true, successfulExitWithInvalidJson: false });
  expect(classifyOutput(JSON.stringify({ ok: false, message: 'database cannot be opened' }), 1)).toMatchObject({ validWorkerResult: true, successfulExitWithInvalidJson: false });
  expect(classifyOutput('{}', 0)).toMatchObject({ validWholeStdoutJson: true, validWorkerResult: false });
});

test('isolates OpenClaw state and native temporary files without inheriting application credentials or loaders', () => {
  const root = fixtureDirectory();
  const env = childEnvironment(root, {
    PATH: 'existing-path', USERPROFILE: 'C:\\Users\\customer',
    OPENCLAW_STATE_DIR: 'C:\\production-state', LOBSTER_APIKEY_CUSTOM_0: 'secret',
    LOBSTERAI_OPENCLAW_ENTRY: 'production-entry', NODE_OPTIONS: '--require unsafe.cjs', NODE_PATH: 'external-modules',
  });
  expect(env.PATH).toBe('existing-path');
  expect(env.USERPROFILE).toBe('C:\\Users\\customer');
  expect(env.OPENCLAW_STATE_DIR).toBe(path.join(root, 'state'));
  expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(root, 'state', 'openclaw.json'));
  expect(env.TEMP).toBe(path.join(root, 'temp'));
  expect(env.TMPDIR).toBe(env.TEMP);
  expect(env.XDG_CACHE_HOME).toBe(path.join(root, 'cache'));
  expect(env.LOCALAPPDATA).toBe(path.join(root, 'local-app-data'));
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.NODE_PATH).toBeUndefined();
  expect(env.LOBSTER_APIKEY_CUSTOM_0).toBeUndefined();
  expect(env.LOBSTERAI_OPENCLAW_ENTRY).toBeUndefined();
  expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, 'utf8')).toBe('{}\n');
});

test('captures real subprocess bytes for both worker entry points and both modes while preserving the fixture', async () => {
  const root = fixtureDirectory();
  const runtimeRoot = path.join(root, '安装路径 with spaces');
  const workDir = path.join(root, 'work');
  const reportDir = path.join(root, 'report');
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'infra'), { recursive: true });
  fs.mkdirSync(workDir);
  const source = [
    "const fs = require('node:fs');",
    "if (process.argv[2] !== '--openclaw-sqlite-readonly-child') throw new Error('wrong child marker');",
    "if (!['sync','async'].includes(process.argv[3])) throw new Error('wrong mode');",
    "if (!fs.readFileSync(process.argv[4]).subarray(0, 16).equals(Buffer.from('SQLite format 3\\0'))) throw new Error('not a SQLite fixture');",
    "process.stdout.write(JSON.stringify({ok:true,location:process.argv[4]}));",
    "process.stdout.write('[0x123] ANOMALY: meaningless REX prefix used');",
    "process.stderr.write('fixture diagnostic on stderr');",
  ].join('\n');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'infra', 'sqlite-readonly-location.worker.js'), source);
  fs.writeFileSync(path.join(runtimeRoot, 'sqlite-readonly-location.worker.mjs'), "import './dist/infra/sqlite-readonly-location.worker.js';\n");
  const result = await runProbe({ runtimeRoot, workDir, reportDir, observationMs: 0 });
  expect(result.attempts).toHaveLength(4);
  expect(result.fixtureBytesUnchanged).toBe(true);
  for (const attempt of result.attempts) {
    expect(attempt.exitCode).toBe(0);
    expect(attempt.analysis.successfulExitWithInvalidJson).toBe(true);
    expect(attempt.analysis.containsAnomaly).toBe(true);
    expect(attempt.stderr).toBe('fixture diagnostic on stderr');
  }
  expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'worker-probe.json'), 'utf8')).finding).toContain('Observed ANOMALY');
  expect(fs.readFileSync(path.join(runtimeRoot, 'dist', 'infra', 'sqlite-readonly-location.worker.js'), 'utf8')).toBe(source);
});

test('reports missing workers as incomplete evidence instead of successful diagnosis', async () => {
  const root = fixtureDirectory();
  const runtimeRoot = path.join(root, 'runtime');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(runtimeRoot);
  fs.mkdirSync(workDir);
  const result = await runProbe({ runtimeRoot, workDir, reportDir: path.join(root, 'report'), observationMs: 0 });
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts.every((attempt: { skipped?: string }) => attempt.skipped)).toBe(true);
  expect(result.finding).toContain('No worker probe completed');
});

test('recognizes the repaired result-file protocol even when stdout remains contaminated', async () => {
  const root = fixtureDirectory();
  const runtimeRoot = path.join(root, 'runtime');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'infra'), { recursive: true });
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'infra', 'sqlite-readonly-location.worker.js'), [
    "const fs = require('node:fs');",
    "if (process.argv[5] !== '--openclaw-sqlite-readonly-result-file') throw new Error('missing result-file argument');",
    "fs.writeFileSync(process.argv[6], JSON.stringify({ok:true,location:process.argv[4]}), {flag:'wx'});",
    "process.stdout.write('[0x123] ANOMALY: meaningless REX prefix used');",
  ].join('\n'));
  fs.writeFileSync(path.join(runtimeRoot, 'sqlite-readonly-location.worker.mjs'), "import './dist/infra/sqlite-readonly-location.worker.js';\n");
  const result = await runProbe({ runtimeRoot, workDir, reportDir: path.join(root, 'report'), observationMs: 0 });
  expect(result.finding).toContain('Result-file protocol succeeded in all four probes');
  expect(result.fixtureBytesUnchanged).toBe(true);
  for (const attempt of result.attempts) {
    expect(attempt.analysis.containsAnomaly).toBe(true);
    expect(attempt.resultFile.analysis).toMatchObject({ validWorkerResult: true, workerReportedOk: true });
  }
});
