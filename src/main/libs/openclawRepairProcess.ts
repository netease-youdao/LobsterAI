import { type ChildProcess, execFile, type ExecFileException } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { t } from '../i18n';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

// Explicit repair loads the full CLI and can migrate a large profile. A cold
// Windows process needs more than config validate's ordinary 60-second budget.
// Output permits more time, but neither silence nor continuous output can keep
// the maintenance guard occupied indefinitely. Ordinary startup is unaffected.
export const OPENCLAW_REPAIR_WAIT_POLICY = {
  minimumTimeoutMs: 300_000,
  idleTimeoutMs: 300_000,
  maxWaitMs: 900_000,
} as const;

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    let closed = false;
    let timeoutReason: TimeoutReason | undefined;
    const description = [path.basename(args[0]), ...args.slice(1).map(arg => path.isAbsolute(arg) ? path.basename(arg) : arg)].join(' ');
    const initialReport = {
      command, args, startedAt: new Date(startedAt).toISOString(),
      requestedTimeoutMs: options.timeoutMs, baseTimeoutMs,
      idleTimeoutMs: OPENCLAW_REPAIR_WAIT_POLICY.idleTimeoutMs, maxWaitMs: OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs,
    };

    const finish = (error: ExecFileException | null, stdout: string, stderr: string) => {
      closed = true;
      if (timer) clearTimeout(timer);
      child?.stdout?.removeListener('data', onOutput);
      child?.stderr?.removeListener('data', onOutput);
      const failed = Boolean(timeoutReason || (error && (error.killed || typeof error.code !== 'number')));
      const report = {
        ...initialReport, pid: child?.pid ?? null,
        durationMs: Date.now() - startedAt, silentMs: Date.now() - lastOutputAt,
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
          command: description, seconds: Math.round(report.durationMs / 1000), path: reportPath,
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
      timeoutReason = Date.now() - startedAt >= OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs
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
      const deadline = Math.min(startedAt + OPENCLAW_REPAIR_WAIT_POLICY.maxWaitMs,
        Math.max(startedAt + baseTimeoutMs, lastOutputAt + OPENCLAW_REPAIR_WAIT_POLICY.idleTimeoutMs));
      const remainingMs = deadline - Date.now();
      // Continuous output must not repeatedly postpone a timer already due.
      if (remainingMs <= 0) stopAtDeadline();
      else timer = setTimeout(stopAtDeadline, remainingMs);
    };
    function onOutput() {
      lastOutputAt = Date.now();
      scheduleDeadline();
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
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    scheduleDeadline();
  });
}
