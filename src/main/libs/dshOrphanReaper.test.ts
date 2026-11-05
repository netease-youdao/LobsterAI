import { describe, expect, test } from 'vitest';

import {
  findOrphanedDshRuntimes,
  isDshWebCommand,
  parseProcessTable,
  type ProcessTableRow,
  reapOrphanedDshRuntimes,
} from './dshOrphanReaper';
import { buildDshProcessLaunch } from './dshProcessLauncher';
import { buildDshWebArgs } from './dshRuntime';

const EXEC = '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI';
const DEV_EXEC = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const INSTALLED_ENTRY = '/Users/me/Library/Application Support/LobsterAI/dsh-runtime/0.2.1-rc.5/lib/bin.js';

// The command line exactly as the manager spawns it, so the matcher cannot
// drift from dshProcessLauncher/buildDshWebArgs unnoticed.
function dshCommand(executablePath: string, entry: string, port: number): string {
  const launch = buildDshProcessLaunch(
    { executablePath, args: buildDshWebArgs(entry, port), cwd: '/', env: {} },
    'darwin'
  );
  return [launch.command, ...launch.args].join(' ');
}

describe('parseProcessTable', () => {
  test('reads right-aligned pid/ppid columns and keeps spaces in the command', () => {
    const rows = parseProcessTable(
      `    1     0 /sbin/launchd\n90204 89768 ${dshCommand(EXEC, INSTALLED_ENTRY, 57437)}\n\ngarbage line\n`
    );

    expect(rows).toEqual([
      { pid: 1, ppid: 0, command: '/sbin/launchd' },
      { pid: 90204, ppid: 89768, command: dshCommand(EXEC, INSTALLED_ENTRY, 57437) },
    ]);
  });
});

describe('isDshWebCommand', () => {
  test('matches the spawned runtime, through bin.js or a generated launcher', () => {
    expect(isDshWebCommand(dshCommand(EXEC, INSTALLED_ENTRY, 57437), EXEC)).toBe(true);
    expect(isDshWebCommand(dshCommand(EXEC, '/Users/me/Library/Application Support/LobsterAI/dsh-launcher/launch.mjs', 1), EXEC)).toBe(true);
  });

  test('ignores another install, the main process, and other Node-mode children', () => {
    expect(isDshWebCommand(dshCommand(DEV_EXEC, INSTALLED_ENTRY, 57437), EXEC)).toBe(false);
    expect(isDshWebCommand(EXEC, EXEC)).toBe(false);
    expect(isDshWebCommand(`${EXEC} /runtime/openclaw.mjs gateway --port 18789`, EXEC)).toBe(false);
    expect(isDshWebCommand(`${EXEC} --expose-internals ${INSTALLED_ENTRY} plugin install foo`, EXEC)).toBe(false);
  });
});

describe('findOrphanedDshRuntimes', () => {
  const main: ProcessTableRow = { pid: 500, ppid: 1, command: EXEC };
  const owned: ProcessTableRow = { pid: 501, ppid: 500, command: dshCommand(EXEC, INSTALLED_ENTRY, 4000) };
  const orphan: ProcessTableRow = { pid: 600, ppid: 1, command: dshCommand(EXEC, INSTALLED_ENTRY, 4001) };

  test('keeps a runtime whose LobsterAI main process is alive', () => {
    expect(findOrphanedDshRuntimes([main, owned], EXEC)).toEqual([]);
  });

  test('reclaims a runtime reparented to launchd', () => {
    expect(findOrphanedDshRuntimes([main, owned, orphan], EXEC)).toEqual([orphan]);
  });

  test('reclaims a runtime adopted by a non-LobsterAI subreaper', () => {
    const subreaper: ProcessTableRow = { pid: 42, ppid: 1, command: '/usr/lib/systemd/systemd --user' };
    const adopted: ProcessTableRow = { ...orphan, ppid: 42 };
    expect(findOrphanedDshRuntimes([subreaper, adopted], EXEC)).toEqual([adopted]);
  });

  test("never touches another install's runtime, orphaned or not", () => {
    const devOrphan: ProcessTableRow = { pid: 700, ppid: 1, command: dshCommand(DEV_EXEC, '/repo/vendor/dsh-runtime/mac-arm64/lib/bin.js', 4002) };
    expect(findOrphanedDshRuntimes([devOrphan], EXEC)).toEqual([]);
  });
});

describe('reapOrphanedDshRuntimes', () => {
  const table = `  500     1 ${EXEC}\n  501   500 ${dshCommand(EXEC, INSTALLED_ENTRY, 4000)}\n  600     1 ${dshCommand(EXEC, INSTALLED_ENTRY, 4001)}\n`;

  test('sends SIGTERM to orphans only and stops once they exit', async () => {
    const alive = new Set([500, 501, 600]);
    const signals: Array<[number, NodeJS.Signals]> = [];
    const found = await reapOrphanedDshRuntimes({
      executablePath: EXEC,
      platform: 'darwin',
      listProcesses: async () => table,
      sendSignal: (pid, signal) => {
        signals.push([pid, signal]);
        alive.delete(pid);
      },
      isAlive: (pid) => alive.has(pid),
    });

    expect(found).toBe(1);
    expect(signals).toEqual([[600, 'SIGTERM']]);
    expect(alive.has(501)).toBe(true);
  });

  test('escalates to SIGKILL when an orphan ignores SIGTERM', async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    await reapOrphanedDshRuntimes({
      executablePath: EXEC,
      platform: 'darwin',
      listProcesses: async () => table,
      sendSignal: (pid, signal) => signals.push([pid, signal]),
      isAlive: () => true,
      graceMs: 0,
    });

    expect(signals).toEqual([
      [600, 'SIGTERM'],
      [600, 'SIGKILL'],
    ]);
  });

  test('skips Windows and survives a failed scan', async () => {
    const neverCalled = async () => {
      throw new Error('should not scan');
    };
    expect(await reapOrphanedDshRuntimes({ platform: 'win32', listProcesses: neverCalled })).toBe(0);
    expect(await reapOrphanedDshRuntimes({ platform: 'darwin', listProcesses: neverCalled })).toBe(0);
  });
});
