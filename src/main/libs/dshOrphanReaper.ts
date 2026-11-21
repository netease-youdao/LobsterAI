// Finds and stops dsh runtimes that an earlier LobsterAI run left behind.
//
// The runtime is Electron in Node mode started as a plain child process, so
// nothing ties its lifetime to ours: a main process that exits without
// stopping it (a crash, a force quit, the quit watchdog, or a build whose quit
// path never stopped dsh) leaves it reparented to launchd, still serving its
// port and writing the dsh home, while the next run's manager reports
// "stopped" and may start a second writer next to it. A run never adopts that
// child (its launch token is gone), so it is stopped instead.
//
// POSIX only: the process table comes from `ps`. Windows has no equivalent
// without WMI, so there the quit-time stop is the only protection.

import { execFile } from 'child_process';

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export interface ProcessTableRow {
  pid: number;
  ppid: number;
  command: string;
}

// Matches both the App-Owned Profile host (`--expose-internals <entry> --profile lobsterai --no-open ...`)
// and legacy `web --port <n> --no-open` runs spawned by this executable.
const DSH_WEB_COMMAND_TAIL = /^ --expose-internals .+ (?:web --port \d+ --no-open|--profile \S+ --no-open\b.*)$/;

// dsh shuts itself down within 5s of SIGTERM (PROCESS_SHUTDOWN_TIMEOUT_MS in
// its profile boot), so a little over that before escalating.
const DEFAULT_GRACE_MS = 6_000;
const ALIVE_POLL_INTERVAL_MS = 100;
const PS_MAX_BUFFER = 16 * 1024 * 1024;

export function parseProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line.replace(/\r$/, ''));
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() });
  }
  return rows;
}

// Only runtimes this same install spawned: the executable path keeps a dev
// build and a packaged app from stopping each other's runtimes.
export function isDshWebCommand(command: string, executablePath: string): boolean {
  if (!command.startsWith(`${executablePath} `)) return false;
  return DSH_WEB_COMMAND_TAIL.test(command.slice(executablePath.length));
}

// macOS launches the runtime through Electron Helper, while its live parent
// is the Electron main binary (and may have a relative argv[0]). Only reclaim
// children demonstrably adopted by init or a known Linux subreaper.
export function findOrphanedDshRuntimes(rows: readonly ProcessTableRow[], executablePath: string): ProcessTableRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows.filter((row) => {
    if (!isDshWebCommand(row.command, executablePath)) return false;
    if (row.ppid === 1) return true;
    const parent = byPid.get(row.ppid);
    return Boolean(parent && /^(?:\S*\/)?(?:systemd|tini|dumb-init)(?:\s|$)/.test(parent.command));
  });
}

export interface DshOrphanReapOptions {
  executablePath?: string;
  platform?: NodeJS.Platform;
  listProcesses?: () => Promise<string>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  graceMs?: number;
}

function listProcessesWithPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    // `-ww`: never truncate the command column, whatever the terminal width.
    execFile('ps', ['-axww', '-o', 'pid=,ppid=,command='], { maxBuffer: PS_MAX_BUFFER }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves the number of leftover runtimes found. Never throws: a failed scan
// only means nothing is reclaimed this time.
export async function reapOrphanedDshRuntimes(options: DshOrphanReapOptions = {}): Promise<number> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return 0;
  const executablePath = options.executablePath ?? process.execPath;
  const listProcesses = options.listProcesses ?? listProcessesWithPs;
  const sendSignal = options.sendSignal ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? isProcessAlive;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  let orphans: ProcessTableRow[];
  try {
    orphans = findOrphanedDshRuntimes(parseProcessTable(await listProcesses()), executablePath);
  } catch (error) {
    console.warn('[DSH] Could not scan for runtimes left by an earlier run', error);
    return 0;
  }
  if (orphans.length === 0) return 0;

  console.warn(
    `[DSH] Stopping ${orphans.length} runtime(s) left by an earlier run: ` +
      orphans.map((row) => `pid=${row.pid} ppid=${row.ppid}`).join(', ')
  );
  const signalAll = (pids: number[], signal: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        sendSignal(pid, signal);
      } catch {
        // Already gone.
      }
    }
  };

  signalAll(orphans.map((row) => row.pid), 'SIGTERM');
  const deadline = Date.now() + graceMs;
  let survivors = orphans.map((row) => row.pid).filter(isAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(ALIVE_POLL_INTERVAL_MS);
    survivors = survivors.filter(isAlive);
  }
  if (survivors.length > 0) {
    // A PID can be reused during the grace period. Check the executable,
    // command line and adoptive parent again before escalating.
    try {
      const current = findOrphanedDshRuntimes(parseProcessTable(await listProcesses()), executablePath);
      const verified = current.filter(row => survivors.includes(row.pid)
        && orphans.some(original => original.pid === row.pid && original.command === row.command));
      if (verified.length) {
        console.warn(`[DSH] Leftover runtime(s) ignored SIGTERM, killing: ${verified.map(row => row.pid).join(', ')}`);
        signalAll(verified.map(row => row.pid), 'SIGKILL');
      }
    } catch (error) {
      console.warn('[DSH] Could not recheck orphaned runtimes before forced termination', error);
    }
  }
  return orphans.length;
}
