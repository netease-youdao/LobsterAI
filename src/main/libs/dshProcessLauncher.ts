import { type ChildProcess, spawn, type SpawnOptions } from 'child_process';

import { DSH_NODE_EXEC_ARGV } from './dshRuntime';

export interface DshProcessLaunchOptions {
  executablePath: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface DshProcessLaunch {
  command: string;
  args: string[];
  options: SpawnOptions;
}

// dsh's Cordis loader needs --expose-internals. Electron strips that switch
// from packaged utility processes, so every platform launches the Electron
// executable in its documented Node mode instead.
export function buildDshProcessLaunch(
  options: DshProcessLaunchOptions,
  platform: NodeJS.Platform = process.platform
): DshProcessLaunch {
  return {
    command: options.executablePath,
    args: [...DSH_NODE_EXEC_ARGV, ...options.args],
    options: {
      cwd: options.cwd,
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(platform === 'win32' ? { windowsHide: true } : {}),
    },
  };
}

export function spawnDshProcess(options: DshProcessLaunchOptions): ChildProcess {
  const launch = buildDshProcessLaunch(options);
  return spawn(launch.command, launch.args, launch.options);
}
