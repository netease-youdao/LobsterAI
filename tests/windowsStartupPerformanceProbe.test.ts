import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  summarize, readFiles, readLargeFile, writeBench, sqliteBench, runProbe,
  sampleEvenly, readLocationGroup, randomReadBench, defaultTargets,
} = require('../scripts/support/windows-gateway-diagnostics/performance-probe.cjs');
const {
  buildPerformanceCollector, splitParamBlock, PROBE_VARIABLE,
} = require('../scripts/support/windows-gateway-diagnostics/build-performance-collector.cjs');
const toolDirectory = path.resolve(__dirname, '../scripts/support/windows-gateway-diagnostics');
const directories: string[] = [];

function fixtureDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-performance-probe-'));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('summarizes latencies with stable quantiles', () => {
  expect(summarize([])).toEqual({ count: 0 });
  const stats = summarize([5, 1, 4, 2, 3, 10, 6, 7, 8, 9]);
  expect(stats).toMatchObject({ count: 10, totalMs: 55, meanMs: 5.5, p50Ms: 6, p90Ms: 10, maxMs: 10 });
});

test('reads runtime files, reports failures and names only paths relative to the runtime', () => {
  const root = fixtureDirectory();
  const files = ['a.js', path.join('nested 目录', 'b.json')].map(name => path.join(root, name));
  fs.mkdirSync(path.dirname(files[1]));
  fs.writeFileSync(files[0], 'module.exports = 1;');
  fs.writeFileSync(files[1], '{}');
  const result = readFiles([...files, path.join(root, 'missing.js')], root);
  expect(result).toMatchObject({ count: 2, failures: 1, bytes: 21 });
  expect(result.slowest.map((entry: { file: string }) => entry.file).sort()).toEqual(['a.js', path.join('nested 目录', 'b.json')].sort());
});

test('reads large files without modifying them and tolerates missing ones', () => {
  const root = fixtureDirectory();
  const file = path.join(root, 'openclaw.sqlite');
  const content = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  fs.writeFileSync(file, content);
  expect(readLargeFile({ label: 'state/openclaw.sqlite', path: file })).toMatchObject({
    label: 'state/openclaw.sqlite', exists: true, sizeBytes: content.length, bytesRead: content.length,
  });
  expect(fs.readFileSync(file).equals(content)).toBe(true);
  expect(readLargeFile({ label: 'gone', path: path.join(root, 'gone.sqlite') })).toEqual({ label: 'gone', exists: false });
});

test('write and SQLite benchmarks leave their directories empty', () => {
  const root = fixtureDirectory();
  const writeDir = path.join(root, 'files');
  const result = writeBench({ label: 'userData', path: writeDir, count: 5 });
  expect(result.smallCreateWriteFsync.count).toBe(5);
  expect(result.smallDelete.count).toBe(5);
  expect(result.largeReadBackBytes).toBe(16 * 1024 * 1024);
  expect(fs.readdirSync(writeDir)).toEqual([]);

  const sqliteDir = path.join(root, 'sqlite');
  const sqlite = sqliteBench(sqliteDir);
  if (sqlite.unavailable) return;
  expect(sqlite.walFull.commit.count).toBe(100);
  expect(sqlite.rollbackFull.commit.count).toBe(50);
  expect(fs.readdirSync(sqliteDir)).toEqual([]);
});

test('writes a complete report for every section', async () => {
  const root = fixtureDirectory();
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot);
  const cold = path.join(runtimeRoot, 'cold.js');
  const cross = path.join(runtimeRoot, 'cross.js');
  fs.writeFileSync(cold, 'cold');
  fs.writeFileSync(cross, 'cross');
  const reportPath = path.join(root, 'performance-probe.json');
  const report = await runProbe({
    runtimeRoot, reportPath,
    coldFiles: [cold], crossFiles: [cross],
    largeFiles: [{ label: 'runtime/cold.js', path: cold }],
    writeDirs: [{ label: 'temp', path: path.join(root, 'bench'), count: 3 }],
    sqliteDir: path.join(root, 'sqlite'),
    spawn: true,
  });
  expect(Object.keys(report.sections)).toEqual([
    'coldRead', 'repeatRead', 'crossProcessRead', 'locationGroups', 'randomReads', 'largeFiles', 'writes', 'sqlite', 'spawn',
  ]);
  for (const section of Object.values(report.sections) as Array<{ error?: string; wallMs: number; cpuMs: number }>) {
    expect(section.error).toBeUndefined();
    expect(section.wallMs).toBeGreaterThanOrEqual(0);
    expect(section.cpuMs).toBeGreaterThanOrEqual(0);
  }
  expect(report.sections.coldRead.count).toBe(1);
  expect(report.sections.spawn.electronNode).toHaveLength(3);
  expect(report.sections.spawn.electronNode.every((attempt: { status: number }) => attempt.status === 0)).toBe(true);
  expect(report.runtime.bootstrapMs).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(fs.readFileSync(reportPath, 'utf8')).finishedAt).toBe(report.finishedAt);
  expect(fs.readdirSync(path.join(root, 'bench'))).toEqual([]);
});

test('builds one launcher that still works when Explorer runs it from inside a ZIP', () => {
  const text: string = buildPerformanceCollector();
  // cmd.exe would treat a BOM as part of the first command.
  expect(text.charCodeAt(0)).toBe('<'.charCodeAt(0));
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  const lines = text.split('\r\n');
  const batchEnd = lines.indexOf('#>');
  const batch = lines.slice(0, batchEnd);
  expect(batch[0].startsWith('<# : ')).toBe(true);
  expect(batch.join('\n')).not.toMatch(/[^\x20-\x7e\n]/);
  expect(batch.findIndex(line => line.startsWith('exit /b'))).toBeGreaterThan(0);
  expect(batch.join('\n')).toContain('ReadAllText($env:LOBSTERAI_DIAG_SELF, [Text.Encoding]::UTF8)');
  expect(lines[batchEnd + 1]).toBe('param(');
  // Nothing next to the launcher is needed: helpers and probe are embedded.
  expect(text).toContain('function Protect-DiagnosticText');
  expect(text).toContain('function ConvertTo-DiagnosticArgument');
  const probeStart = lines.indexOf(`${PROBE_VARIABLE} = @'`);
  const probeEnd = lines.indexOf("'@", probeStart);
  const probeSource = fs.readFileSync(path.join(toolDirectory, 'performance-probe.cjs'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  expect(probeStart).toBeGreaterThan(batchEnd);
  expect(lines.slice(probeStart + 1, probeEnd).join('\n')).toBe(probeSource);
  expect(lines.filter(line => line.startsWith('param(')).length).toBe(1);
});

test('rejects a collector whose param block is not first', () => {
  expect(splitParamBlock('param(\n    [string]$AppPath\n)\nWrite-Host 1\n')[1]).toBe('Write-Host 1\n');
  expect(() => splitParamBlock('Write-Host 1\nparam()\n')).toThrow(/param block/);
});

test('picks database, disk-latency and Defender comparison targets from plain directories', () => {
  const root = fixtureDirectory();
  const installRoot = path.join(root, 'install');
  const pythonDir = path.join(installRoot, 'resources', 'python-win');
  const skillsDir = path.join(installRoot, 'resources', 'SKILLs', 'demo');
  const stateDir = path.join(root, 'userData', 'openclaw', 'state');
  const userSkills = path.join(root, 'userData', 'SKILLs', 'mine');
  for (const directory of [pythonDir, skillsDir, path.join(stateDir, 'agents', 'main'), userSkills]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(pythonDir, 'python312.dll'), Buffer.alloc(1024 * 1024, 1));
  fs.writeFileSync(path.join(pythonDir, 'small.txt'), 'x');
  fs.writeFileSync(path.join(stateDir, 'agents', 'main', 'openclaw-agent.sqlite'), Buffer.alloc(900 * 1024, 2));
  fs.writeFileSync(path.join(stateDir, 'openclaw.sqlite'), Buffer.alloc(10, 3));
  fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# demo');
  fs.writeFileSync(path.join(skillsDir, 'run.py'), 'print(1)');
  fs.writeFileSync(path.join(skillsDir, 'image.png'), 'not sampled');
  fs.writeFileSync(path.join(userSkills, 'index.js'), 'module.exports = 1;');
  const targets = defaultTargets({
    installRoot, runtimeRoot: path.join(installRoot, 'resources', 'cfmind'), stateDir, userDataDir: path.join(root, 'userData'),
  });
  expect(targets.largeFiles.map((entry: { label: string }) => entry.label)).toEqual([
    'runtime/gateway-bundle.mjs', 'state/agents/main/openclaw-agent.sqlite', 'state/openclaw.sqlite', 'userData/lobsterai.sqlite',
  ]);
  expect(targets.randomReads.map((entry: { label: string }) => entry.label)).toEqual([
    'install/resources/python-win/python312.dll', 'state/agents/main/openclaw-agent.sqlite',
  ]);
  expect(targets.locationGroups.map((entry: { label: string }) => entry.label)).toEqual(['install/resources/SKILLs', 'userData/SKILLs']);
  const installGroup = readLocationGroup(targets.locationGroups[0]);
  expect(installGroup).toMatchObject({ label: 'install/resources/SKILLs', count: 2, failures: 0 });
  const randomRead = randomReadBench({ ...targets.randomReads[0], count: 20 });
  expect(randomRead.read.count).toBe(20);
  expect(randomReadBench({ label: 'tiny', path: path.join(stateDir, 'openclaw.sqlite') })).toMatchObject({ skipped: 'file too small' });
  expect(sampleEvenly(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'c']);
});

test('never wraps a List[object] variable in @() (Windows PowerShell 5.1 throws "Argument types do not match")', () => {
  const source = fs.readFileSync(path.join(toolDirectory, 'collect-performance.ps1'), 'utf8');
  const objectLists = [...source.matchAll(/\$(\w+) = New-Object 'System\.Collections\.Generic\.List\[object\]'/g)].map(match => match[1]);
  expect(objectLists.length).toBeGreaterThan(0);
  for (const name of objectLists) expect(source).not.toMatch(new RegExp(`@\\(\\$${name}\\)`));
});
