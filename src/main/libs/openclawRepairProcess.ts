import { type ChildProcess, execFile, type ExecFileException } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { type OpenClawRepairProgress, parseOpenClawRepairProgress } from '../../shared/openclawEngine/repair';
import { t } from '../i18n';
import { AwakeClock } from './awakeClock';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

// Explicit repair loads the full CLI and can migrate a large profile. A cold
// Windows process needs more than config validate's ordinary 60-second budget.
// Output permits more time, but neither silence nor continuous output can keep
// the maintenance guard occupied indefinitely. Ordinary startup is unaffected.
export const OPENCLAW_REPAIR_WAIT_POLICY = {
  minimumTimeoutMs: 300_000,
  idleTimeoutMs: 300_000,
  maxWaitMs: 900_000,
  // A helper that measures its copy first (the state snapshot) may outlast
  // maxWaitMs: it gets time for the measured bytes at this slow-disk rate plus
  // a per-file cost, up to the ceiling. The idle limit applies throughout.
  measuredCopyBytesPerSecond: 2 * 1024 * 1024,
  measuredCopyPerFileMs: 10,
  measuredMaxWaitMs: 4 * 60 * 60_000,
} as const;

// Keeps the awake clock observed while a command runs, so system sleep is
// recognised and left out instead of expiring the deadline on wake.
const REPAIR_AWAKE_CHECK_INTERVAL_MS = 5_000;
// Progress lines are short; a longer partial stdout line is not one of them.
const PROGRESS_LINE_MAX_LENGTH = 4_096;

/**
 * Absolute wait for a command that measured its copy at `measuredAtAwakeMs`:
 * the time already spent plus room to copy the measured work at the slowest
 * accepted rate, never below the ordinary limit nor above the ceiling.
 */
export function resolveOpenClawRepairMaxWaitMs(work: { files: number; bytes: number }, measuredAtAwakeMs: number): number {
  const policy = OPENCLAW_REPAIR_WAIT_POLICY;
  const copyMs = (work.bytes / policy.measuredCopyBytesPerSecond) * 1000 + work.files * policy.measuredCopyPerFileMs;
  return Math.min(policy.measuredMaxWaitMs,
    Math.max(policy.maxWaitMs, Math.ceil(measuredAtAwakeMs + copyMs + policy.idleTimeoutMs)));
}

export const OpenClawRepairProcessOutcome = {
  Running: 'running',
  Exited: 'exited',
  Failed: 'failed',
  TimedOut: 'timed-out',
} as const;

export const OpenClawRepairTimeoutReason = {
  Idle: 'idle',
  Limit: 'absolute-limit',
} as const;
type TimeoutReason = typeof OpenClawRepairTimeoutReason[keyof typeof OpenClawRepairTimeoutReason];

/** Run only inside explicit repair, with the gateway stopped and a private backup directory. */
export function createOpenClawRepairRunner(backupDir: string): StartupMigrationRunner {
  return (command, args, options) => new Promise((resolve, reject) => {
    const commandsDir = path.join(backupDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true, mode: 0o700 });
    const diagnosticDir = fs.mkdtempSync(path.join(commandsDir, 'command-'));
    const reportPath = path.join(diagnosticDir, 'result.json');
    const startedAt = Date.now();
    const baseTimeoutMs = Math.min(OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs,
      Math.max(options.timeoutMs, OPENCLAW_REPAIR_WAIT_POLICY.minimumTimeoutMs));
    let lastOutputAt = startedAt;
    // Deadlines count awake time: Doctor frozen by system sleep resumes on
    // wake, and killing it mid-write would be worse than waiting.
    const clock = new AwakeClock(startedAt);
    let lastOutputAwakeMs = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let awakeCheck: ReturnType<typeof setInterval> | undefined;
    let child: ChildProcess | undefined;
    let closed = false;
    let timeoutReason: TimeoutReason | undefined;
    // Sized once, when a helper first reports its measured copy, so repeated
    // reports cannot move the limit.
    let maxWaitMs: number = OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs;
    let measured = false;
    let progress: OpenClawRepairProgress | undefined;
    let partialStdoutLine = '';
    const description = [path.basename(args[0]), ...args.slice(1).map(arg => path.isAbsolute(arg) ? path.basename(arg) : arg)].join(' ');
    const initialReport = {
      command, args, startedAt: new Date(startedAt).toISOString(),
      requestedTimeoutMs: options.timeoutMs, baseTimeoutMs,
      idleTimeoutMs: OPENCLAW_REPAIR_WAIT_POLICY.idleTimeoutMs, maxWaitMs: OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs,
    };

    const finish = (error: ExecFileException | null, stdout: string, stderr: string) => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (awakeCheck) clearInterval(awakeCheck);
      child?.stdout?.removeListener('data', onStdout);
      child?.stderr?.removeListener('data', onOutput);
      const failed = Boolean(timeoutReason || (error && (error.killed || typeof error.code !== 'number')));
      const awakeMs = clock.observe(Date.now());
      const report = {
        ...initialReport, maxWaitMs, progress, pid: child?.pid ?? null,
        durationMs: Date.now() - startedAt, silentMs: Date.now() - lastOutputAt,
        awakeMs, suspendedMs: clock.suspendedMs,
        outcome: timeoutReason ? OpenClawRepairProcessOutcome.TimedOut
          : failed ? OpenClawRepairProcessOutcome.Failed : OpenClawRepairProcessOutcome.Exited,
        code: error ? error.code ?? null : 0, signal: error?.signal ?? child?.signalCode ?? null,
        killed: Boolean(error?.killed || child?.killed), timeoutReason,
      };
      // execFile's callback runs after close, also on timeout/maxBuffer/spawn
      // failures. Persist partial output before rejecting and releasing repair.
      try {
        fs.writeFileSync(path.join(diagnosticDir, 'output.log'), `[stdout]\n${stdout}\n[stderr]\n${stderr}`, { mode: 0o600 });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
      } catch (writeError) {
        reject(writeError);
        return;
      }
      if (failed) {
        console.error('[OpenClawRepair] Repair command failed:', { ...report, reportPath }, error);
        const message = timeoutReason ? t('openClawRepairCommandTimeout', {
          command: description, seconds: Math.round(report.awakeMs / 1000), path: reportPath,
        }) : error?.message || t('openClawRepairCommandFailed', { command: description, path: reportPath });
        reject(new Error(message, { cause: error }));
      } else {
        console.log('[OpenClawRepair] Repair command closed:', {
          command: description, pid: report.pid, code: report.code, durationMs: report.durationMs, reportPath,
        });
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      }
    };

    const stopAtDeadline = () => {
      if (closed || timeoutReason || !child || child.exitCode !== null || child.signalCode !== null) return;
      timeoutReason = clock.awakeMs >= maxWaitMs
        ? OpenClawRepairTimeoutReason.Limit : OpenClawRepairTimeoutReason.Idle;
      // Killing is not completion. Keep the maintenance guard until finish
      // sees close, so another repair cannot race this process's SQLite writer.
      try { child.kill('SIGTERM'); } catch (error) {
        console.error('[OpenClawRepair] Could not stop timed-out repair command:', error);
      }
    };
    const scheduleDeadline = () => {
      if (closed || timeoutReason) return;
      if (timer) clearTimeout(timer);
      const deadlineAwakeMs = Math.min(maxWaitMs,
        Math.max(baseTimeoutMs, lastOutputAwakeMs + OPENCLAW_REPAIR_WAIT_POLICY.idleTimeoutMs));
      const remainingMs = deadlineAwakeMs - clock.observe(Date.now());
      // Continuous output must not repeatedly postpone a timer already due.
      if (remainingMs <= 0) stopAtDeadline();
      // A sleep before the timer fires leaves awake time owed: reschedule then.
      else timer = setTimeout(scheduleDeadline, remainingMs);
    };
    function onOutput() {
      lastOutputAt = Date.now();
      lastOutputAwakeMs = clock.observe(lastOutputAt);
      scheduleDeadline();
    }
    function onProgress(value: OpenClawRepairProgress) {
      progress = value;
      if (measured || (value.totalFiles === undefined && value.totalBytes === undefined)) return;
      measured = true;
      maxWaitMs = resolveOpenClawRepairMaxWaitMs(
        { files: value.totalFiles ?? 0, bytes: value.totalBytes ?? 0 }, clock.observe(Date.now()));
      console.log('[OpenClawRepair] Repair command measured its copy:', {
        command: description, files: value.totalFiles, bytes: value.totalBytes, maxWaitMs,
      });
    }
    function onStdout(chunk: string | Buffer) {
      const lines = (partialStdoutLine + chunk.toString()).split('\n');
      const partial = lines.pop() ?? '';
      partialStdoutLine = partial.length > PROGRESS_LINE_MAX_LENGTH ? '' : partial;
      for (const line of lines) {
        const value = parseOpenClawRepairProgress(line.trimEnd());
        if (value) onProgress(value);
      }
      onOutput();
    }

    // Fail before starting a writer if diagnostics cannot be created.
    fs.writeFileSync(reportPath, JSON.stringify({
      ...initialReport, pid: null, outcome: OpenClawRepairProcessOutcome.Running,
    }, null, 2), { mode: 0o600 });
    try {
      child = execFile(command, args, {
        cwd: options.cwd, env: options.env, windowsHide: true, encoding: 'utf8',
        // Our bounded activity deadline replaces execFile's fixed wall clock.
        maxBuffer: 1024 * 1024,
      }, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), '', '');
      return;
    }
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onOutput);
    awakeCheck = setInterval(() => clock.observe(Date.now()), REPAIR_AWAKE_CHECK_INTERVAL_MS);
    scheduleDeadline();
  });
}
