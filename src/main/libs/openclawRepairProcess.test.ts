import type { ExecFileException } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  formatOpenClawRepairProgress, OPENCLAW_REPAIR_PROGRESS_PREFIX, OpenClawRepairPhase, OpenClawRepairProgressStage,
} from '../../shared/openclawEngine/repair';
import { setLanguage } from '../i18n';
import {
  createOpenClawRepairRunner,
  OPENCLAW_REPAIR_WAIT_POLICY,
  OpenClawRepairProcessOutcome,
  OpenClawRepairTimeoutReason,
  resolveOpenClawRepairMaxWaitMs,
} from './openclawRepairProcess';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

let backupDir: string;
let close: (error: ExecFileException | null, stdout: string, stderr: string) => void;
let child: ReturnType<typeof fakeChild>;
const options = { cwd: '/runtime', env: { ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 60_000 };

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 1234, stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
    kill: vi.fn(() => { child.killed = true; return true; }),
  });
}

function diagnostics() {
  const commands = path.join(backupDir, 'commands');
  const directory = path.join(commands, fs.readdirSync(commands)[0]);
  return {
    report: JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8')),
    output: fs.readFileSync(path.join(directory, 'output.log'), 'utf8'),
  };
}

function interrupted(): ExecFileException {
  return Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' as const });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setLanguage('en');
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-wait-'));
  child = fakeChild();
  mockExecFile.mockImplementation((_command, _args, _options, callback) => {
    close = callback;
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockExecFile.mockReset();
  setLanguage('zh');
  fs.rmSync(backupDir, { recursive: true, force: true });
});

test('a cold config validation can finish past 60 seconds without weakening its exit result', async () => {
  const run = createOpenClawRepairRunner(backupDir);
  const pending = run('/electron', ['/runtime/openclaw.mjs', 'config', 'validate', '--json'], options);
  await vi.advanceTimersByTimeAsync(75_000);
  expect(child.kill).not.toHaveBeenCalled();
  close(Object.assign(new Error('invalid config'), { code: 1 }), '{"valid":false}', 'retired key');
  await expect(pending).resolves.toEqual({ code: 1, stdout: '{"valid":false}', stderr: 'retired key' });
  expect(diagnostics().report).toMatchObject({
    outcome: OpenClawRepairProcessOutcome.Exited, code: 1, durationMs: 75_000,
    requestedTimeoutMs: 60_000, baseTimeoutMs: OPENCLAW_REPAIR_WAIT_POLICY.minimumTimeoutMs,
  });
  expect(mockExecFile.mock.calls[0][2]).toMatchObject({ env: options.env, windowsHide: true, maxBuffer: 1024 * 1024 });
  expect(mockExecFile.mock.calls[0][2]).not.toHaveProperty('timeout');
});

test('Doctor with recent output continues past five minutes and still requires close', async () => {
  const pending = createOpenClawRepairRunner(backupDir)('/electron', ['openclaw.mjs', 'doctor', '--fix'], { ...options, timeoutMs: 300_000 });
  await vi.advanceTimersByTimeAsync(160_000);
  child.stderr.write('Migrating databases\n');
  await vi.advanceTimersByTimeAsync(180_000);
  expect(child.kill).not.toHaveBeenCalled();
  close(null, 'Doctor completed', 'Migrating databases\n');
  await expect(pending).resolves.toMatchObject({ code: 0 });
  expect(diagnostics().report.durationMs).toBe(340_000);
  await vi.advanceTimersByTimeAsync(OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs);
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('silent timeout waits for close before rejecting and preserves partial output and signal', async () => {
  let settled = false;
  const pending = createOpenClawRepairRunner(backupDir)('/electron', ['openclaw.mjs', 'doctor'], options);
  const rejection = expect(pending).rejects.toMatchObject({ message: expect.stringContaining('timed out'), cause: expect.objectContaining({ signal: 'SIGTERM' }) });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(300_000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(settled).toBe(false);
  close(interrupted(), 'partial migration', 'last warning');
  await rejection;
  expect(diagnostics().report).toMatchObject({
    outcome: OpenClawRepairProcessOutcome.TimedOut, timeoutReason: OpenClawRepairTimeoutReason.Idle,
    code: null, signal: 'SIGTERM', killed: true, pid: 1234, durationMs: 305_000,
  });
  expect(diagnostics().output).toContain('partial migration');
  expect(diagnostics().output).toContain('last warning');
});

test('continuous output cannot extend repair beyond the absolute limit', async () => {
  const pending = createOpenClawRepairRunner(backupDir)('/electron', ['repair.mjs'], options);
  const rejection = expect(pending).rejects.toThrow('timed out');
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(240_000);
    child.stdout.write('still working\n');
  }
  await vi.advanceTimersByTimeAsync(179_999);
  child.stderr.write('more progress\n');
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenCalledOnce();
  close(interrupted(), 'still working', 'more progress');
  await rejection;
  expect(diagnostics().report).toMatchObject({
    outcome: OpenClawRepairProcessOutcome.TimedOut, timeoutReason: OpenClawRepairTimeoutReason.Limit,
    durationMs: OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs,
  });
});

const EIGHT_HOURS_MS = 8 * 60 * 60_000;

test('a system sleep during Doctor does not expire its deadline on wake', async () => {
  const pending = createOpenClawRepairRunner(backupDir)('/electron', ['openclaw.mjs', 'doctor', '--fix'], options);
  await vi.advanceTimersByTimeAsync(60_000);
  child.stderr.write('Migrating sessions\n');
  await vi.advanceTimersByTimeAsync(1_000);
  // Wall time jumps while the machine sleeps; no timer runs in between.
  vi.setSystemTime(Date.now() + EIGHT_HOURS_MS);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(child.kill).not.toHaveBeenCalled();
  close(null, 'Doctor completed', 'Migrating sessions\n');
  await expect(pending).resolves.toMatchObject({ code: 0 });
  const { report } = diagnostics();
  expect(report.outcome).toBe(OpenClawRepairProcessOutcome.Exited);
  expect(report.suspendedMs).toBeGreaterThanOrEqual(EIGHT_HOURS_MS);
  expect(report.awakeMs).toBeLessThan(75_000);
  expect(vi.getTimerCount()).toBe(0);
});

test('awake time still bounds a Doctor that stays silent across a sleep', async () => {
  const pending = createOpenClawRepairRunner(backupDir)('/electron', ['openclaw.mjs', 'doctor'], options);
  const rejection = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(100_000);
  vi.setSystemTime(Date.now() + EIGHT_HOURS_MS);
  // About 245s awake so far: the 300s silence budget is not spent yet.
  await vi.advanceTimersByTimeAsync(150_000);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  close(interrupted(), '', '');
  await rejection;
  expect(diagnostics().report).toMatchObject({
    outcome: OpenClawRepairProcessOutcome.TimedOut, timeoutReason: OpenClawRepairTimeoutReason.Idle,
  });
});

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const snapshotArgs = ['/runtime/openclaw-gateway-repair.mjs', '/backup/snapshot-request.json'];

function progressLine(files: number, bytes: number, totals?: { files: number; bytes: number }): string {
  return `${formatOpenClawRepairProgress({
    phase: OpenClawRepairPhase.Snapshot,
    stage: totals ? OpenClawRepairProgressStage.Copy : OpenClawRepairProgressStage.Scan,
    files, bytes, ...(totals ? { totalFiles: totals.files, totalBytes: totals.bytes } : {}),
  })}\n`;
}

test('the wait for a measured copy scales with its bytes and files within the ordinary limit and the ceiling', () => {
  const policy = OPENCLAW_REPAIR_WAIT_POLICY;
  expect(resolveOpenClawRepairMaxWaitMs({ files: 500, bytes: 200 * MIB }, 5_000)).toBe(policy.maxWaitMs);
  // 8 GiB at 2 MiB/s is 4096 s, 20,000 files add 200 s; then the 30 s already spent and one idle window.
  expect(resolveOpenClawRepairMaxWaitMs({ files: 20_000, bytes: 8 * GIB }, 30_000)).toBe(30_000 + 4_096_000 + 200_000 + policy.idleTimeoutMs);
  expect(resolveOpenClawRepairMaxWaitMs({ files: 1_000_000, bytes: 2048 * GIB }, 30_000)).toBe(policy.measuredMaxWaitMs);
});

test('a multi-GB snapshot on slow storage is not stopped while its copy keeps advancing', async () => {
  const totals = { files: 20_000, bytes: 8 * GIB };
  const pending = createOpenClawRepairRunner(backupDir)('/electron', snapshotArgs, { ...options, timeoutMs: 300_000 });
  await vi.advanceTimersByTimeAsync(20_000);
  child.stdout.write(progressLine(12_000, 5 * GIB));
  await vi.advanceTimersByTimeAsync(10_000);
  // A line can arrive split across reads.
  const plan = progressLine(0, 0, totals);
  child.stdout.write(plan.slice(0, OPENCLAW_REPAIR_PROGRESS_PREFIX.length + 7));
  child.stdout.write(plan.slice(OPENCLAW_REPAIR_PROGRESS_PREFIX.length + 7));
  // About 3 MiB/s: the copy needs some 46 minutes, three times the ordinary 15-minute limit.
  let copied = 0;
  for (let minute = 1; minute <= 46; minute++) {
    await vi.advanceTimersByTimeAsync(60_000);
    copied = Math.min(totals.bytes, minute * 180 * MIB);
    child.stdout.write(progressLine(Math.round(totals.files * copied / totals.bytes), copied, totals));
  }
  expect(child.kill).not.toHaveBeenCalled();
  close(null, 'LOBSTERAI_GATEWAY_REPAIR_RESULT={}', '');
  await expect(pending).resolves.toMatchObject({ code: 0 });
  const { report } = diagnostics();
  expect(report).toMatchObject({
    outcome: OpenClawRepairProcessOutcome.Exited, durationMs: 30_000 + 46 * 60_000,
    maxWaitMs: resolveOpenClawRepairMaxWaitMs(totals, 30_000),
    progress: { stage: OpenClawRepairProgressStage.Copy, bytes: copied, totalBytes: totals.bytes, totalFiles: totals.files },
  });
  expect(report.durationMs).toBeGreaterThan(OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs);
  expect(vi.getTimerCount()).toBe(0);
});

test('a snapshot that stops making progress is still stopped by the idle limit despite its large budget', async () => {
  const totals = { files: 20_000, bytes: 8 * GIB };
  const pending = createOpenClawRepairRunner(backupDir)('/electron', snapshotArgs, options);
  const rejection = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(30_000);
  child.stdout.write(progressLine(0, 0, totals));
  await vi.advanceTimersByTimeAsync(60_000);
  child.stdout.write(progressLine(40, 64 * MIB, totals));
  // The helper reports only when its counts move: a copy stuck in one I/O call is silent.
  await vi.advanceTimersByTimeAsync(OPENCLAW_REPAIR_WAIT_POLICY.idleTimeoutMs - 1);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  close(interrupted(), progressLine(40, 64 * MIB, totals), '');
  await rejection;
  expect(diagnostics().report).toMatchObject({
    outcome: OpenClawRepairProcessOutcome.TimedOut, timeoutReason: OpenClawRepairTimeoutReason.Idle,
    durationMs: 90_000 + OPENCLAW_REPAIR_WAIT_POLICY.idleTimeoutMs, progress: { files: 40, bytes: 64 * MIB },
  });
});

test('later progress cannot move the measured limit, which still ends a copy that never finishes', async () => {
  const totals = { files: 1_000, bytes: 2 * GIB };
  const limitMs = resolveOpenClawRepairMaxWaitMs(totals, 10_000);
  expect(limitMs).toBe(1_344_000);
  const pending = createOpenClawRepairRunner(backupDir)('/electron', snapshotArgs, options);
  const rejection = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(10_000);
  child.stdout.write(progressLine(0, 0, totals));
  for (let step = 1; step <= 6; step++) {
    await vi.advanceTimersByTimeAsync(200_000);
    // Larger totals in a later report are ignored.
    child.stdout.write(progressLine(step, step * MIB, { files: 1_000, bytes: 100 * GIB }));
  }
  await vi.advanceTimersByTimeAsync(limitMs - 1_210_000 - 1);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenCalledOnce();
  close(interrupted(), '', '');
  await rejection;
  expect(diagnostics().report).toMatchObject({
    outcome: OpenClawRepairProcessOutcome.TimedOut, timeoutReason: OpenClawRepairTimeoutReason.Limit,
    durationMs: limitMs, maxWaitMs: limitMs,
  });
});

test('output that is not a well-formed progress line keeps the ordinary limit', async () => {
  const pending = createOpenClawRepairRunner(backupDir)('/electron', snapshotArgs, options);
  const rejection = expect(pending).rejects.toThrow('timed out');
  child.stdout.write(`${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":"snapshot","stage":"copy","files":-1,"bytes":0,"totalFiles":1,"totalBytes":${1024 * GIB}}\n`);
  child.stdout.write(`Migrating ${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":"snapshot","stage":"copy","files":0,"bytes":0,"totalBytes":${1024 * GIB}}\n`);
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(200_000);
    child.stderr.write('still working\n');
  }
  await vi.advanceTimersByTimeAsync(OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs - 800_000);
  expect(child.kill).toHaveBeenCalledOnce();
  close(interrupted(), '', '');
  await rejection;
  expect(diagnostics().report).toMatchObject({
    timeoutReason: OpenClawRepairTimeoutReason.Limit, maxWaitMs: OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs,
  });
  expect(diagnostics().report).not.toHaveProperty('progress');
});

test.each(['ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])('preserves %s without calling it a timeout or success', async code => {
  const pending = createOpenClawRepairRunner(backupDir)('/electron', ['repair.mjs'], options);
  const rejection = expect(pending).rejects.toThrow(code);
  close(Object.assign(new Error(code), { code, killed: code !== 'ENOENT' }), 'partial stdout', 'partial stderr');
  await rejection;
  expect(diagnostics().report).toMatchObject({ outcome: OpenClawRepairProcessOutcome.Failed, code });
  expect(diagnostics().report).not.toHaveProperty('timeoutReason');
  expect(diagnostics().output).toContain('partial stderr');
  expect(vi.getTimerCount()).toBe(0);
});

test('a child that already exited is not relabeled as timed out while stdio closes', async () => {
  const pending = createOpenClawRepairRunner(backupDir)('/electron', ['repair.mjs'], options);
  child.exitCode = 0;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(child.kill).not.toHaveBeenCalled();
  close(null, 'completed', '');
  await expect(pending).resolves.toMatchObject({ code: 0 });
  expect(diagnostics().report.outcome).toBe(OpenClawRepairProcessOutcome.Exited);
});

test('a synchronous launch failure is recorded without starting deadline timers', async () => {
  mockExecFile.mockImplementation(() => { throw Object.assign(new Error('cannot spawn'), { code: 'ENOENT' }); });
  await expect(createOpenClawRepairRunner(backupDir)('/missing', ['repair.mjs'], options)).rejects.toThrow('cannot spawn');
  expect(diagnostics().report).toMatchObject({ pid: null, code: 'ENOENT', outcome: OpenClawRepairProcessOutcome.Failed });
  expect(vi.getTimerCount()).toBe(0);
});

test('an unwritable diagnostic file cannot leave an untracked repair writer running', async () => {
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(createOpenClawRepairRunner(backupDir)('/electron', ['repair.mjs'], options)).rejects.toThrow('disk full');
  expect(mockExecFile).not.toHaveBeenCalled();
});
