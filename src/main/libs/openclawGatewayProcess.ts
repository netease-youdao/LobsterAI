import { type ChildProcess, spawn } from 'child_process';

interface OpenClawGatewaySpawnOptions {
  executablePath: string;
  entryPath: string;
  args: string[];
  execArgv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const GATEWAY_STOP_GRACE_MS = 6_000;
const GATEWAY_STOP_FORCE_MS = 2_000;

export function stopOpenClawGatewayProcess(child: ChildProcess): Promise<void> {
  // A signal exit has a null exitCode. A failed spawn has no PID and cannot
  // own gateway state; neither needs another termination request.
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let lastError: Error | undefined;

    const cleanup = () => {
      clearTimeout(forceTimer);
      clearTimeout(exitTimer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      lastError = error;
    };
    const sendSignal = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    };

    child.once('exit', onExit);
    child.on('error', onError);
    forceTimer = setTimeout(() => {
      console.warn(`[OpenClaw] gateway shutdown exceeded ${GATEWAY_STOP_GRACE_MS}ms; sending SIGKILL to pid=${child.pid}`);
      exitTimer = setTimeout(() => {
        cleanup();
        reject(new Error(
          `OpenClaw gateway process ${child.pid} did not exit after SIGKILL.`
          + (lastError ? ` ${lastError.message}` : ''),
        ));
      }, GATEWAY_STOP_FORCE_MS);
      sendSignal('SIGKILL');
    }, GATEWAY_STOP_GRACE_MS);
    sendSignal('SIGTERM');
  });
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
