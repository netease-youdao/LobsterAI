import { type ChildProcess, spawn } from 'child_process';

interface OpenClawGatewaySpawnOptions {
  executablePath: string;
  entryPath: string;
  args: string[];
  execArgv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function spawnOpenClawGatewayProcess(options: OpenClawGatewaySpawnOptions): ChildProcess {
  // OpenClaw launches SQLite and other Node workers through process.execPath.
  // Start the gateway in Node mode so those children inherit it too. Setting
  // this flag on utilityProcess.fork instead breaks Chromium's utility args.
  return spawn(
    options.executablePath,
    [...options.execArgv, options.entryPath, ...options.args],
    {
      cwd: options.cwd,
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}
