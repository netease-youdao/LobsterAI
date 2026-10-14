import { type ChildProcess, spawn } from 'child_process';

import { OpenClawGatewayProcessControl } from '../../shared/openclawEngine/constants';

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
// Windows kernel teardown and exit notification can outlast the short POSIX
// deadline. Keep waiting for confirmed exit before touching state or respawning.
const WINDOWS_GATEWAY_STOP_FORCE_MS = 30_000;
const WINDOWS_GATEWAY_EXIT_POLL_MS = 250;

export const OpenClawGatewaySignal = {
  Interrupt: 'SIGINT',
  Terminate: 'SIGTERM',
  Kill: 'SIGKILL',
} as const;

/** Installed before the Windows launcher imports OpenClaw's entry point. */
export function buildOpenClawGatewayShutdownBridge(): string {
  return `(() => {
  if (typeof process.send !== 'function') return;
  const shutdownType = ${JSON.stringify(OpenClawGatewayProcessControl.Shutdown)};
  const shutdownSignal = ${JSON.stringify(OpenClawGatewaySignal.Interrupt)};
  let requested = false;
  let delivered = false;
  const deliver = () => {
    if (!requested || delivered || process.listenerCount(shutdownSignal) === 0) return;
    delivered = true;
    process.removeListener('newListener', onNewListener);
    process.emit(shutdownSignal);
  };
  const onNewListener = (event) => {
    if (event === shutdownSignal && requested) queueMicrotask(deliver);
  };
  process.on('newListener', onNewListener);
  process.on('message', (message) => {
    if (!message || message.type !== shutdownType) return;
    requested = true;
    deliver();
  });
  let disconnected = false;
  const onDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    // The supervisor cannot enforce its shutdown deadline after it exits.
    // Bound this child's lifetime even if startup has no signal handler yet.
    setTimeout(() => process.exit(1), ${GATEWAY_STOP_GRACE_MS}).unref();
    requested = true;
    deliver();
  };
  process.once('disconnect', onDisconnect);
  if (process.connected === false) onDisconnect();
})();\n`;
}

function hasGatewayProcessExited(child: ChildProcess): boolean {
  // A signal exit has a null exitCode. A failed spawn has no PID and cannot
  // own gateway state; neither needs another termination request.
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return true;
  if (process.platform === 'win32') {
    try {
      // Windows can finish terminating before Electron delivers the exit event.
      // Signal 0 only probes liveness; a reused PID conservatively keeps waiting.
      process.kill(child.pid, 0);
    } catch (error) {
      // Access denied and other query failures do not prove the process exited.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return false;
}

export function stopOpenClawGatewayProcess(child: ChildProcess): Promise<void> {
  if (hasGatewayProcessExited(child)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let exitPoll: ReturnType<typeof setInterval> | undefined;
    let lastError: Error | undefined;

    const cleanup = () => {
      clearTimeout(forceTimer);
      clearTimeout(exitTimer);
      clearInterval(exitPoll);
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
    if (process.platform === 'win32') {
      exitPoll = setInterval(() => {
        if (hasGatewayProcessExited(child)) onExit();
      }, WINDOWS_GATEWAY_EXIT_POLL_MS);
    }
    forceTimer = setTimeout(() => {
      if (hasGatewayProcessExited(child)) { onExit(); return; }
      console.warn(`[OpenClaw] gateway shutdown exceeded ${GATEWAY_STOP_GRACE_MS}ms; sending SIGKILL to pid=${child.pid}`);
      exitTimer = setTimeout(() => {
        if (hasGatewayProcessExited(child)) { onExit(); return; }
        cleanup();
        reject(new Error(
          `OpenClaw gateway process ${child.pid} did not exit after SIGKILL.`
          + (lastError ? ` ${lastError.message}` : ''),
        ));
      }, process.platform === 'win32' ? WINDOWS_GATEWAY_STOP_FORCE_MS : GATEWAY_STOP_FORCE_MS);
      sendSignal(OpenClawGatewaySignal.Kill);
    }, GATEWAY_STOP_GRACE_MS);
    if (child.connected && child.send) {
      // Windows kill(SIGTERM) is TerminateProcess: no shutdown handlers run.
      // The launcher delivers SIGINT inside the child so OpenClaw closes its
      // channels, releases locks, and completes its boot lifecycle record.
      try {
        child.send({ type: OpenClawGatewayProcessControl.Shutdown }, (error) => {
          if (error) lastError = error;
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      sendSignal(OpenClawGatewaySignal.Terminate);
    }
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
      stdio: process.platform === 'win32'
        ? ['ignore', 'pipe', 'pipe', 'ipc']
        : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}
