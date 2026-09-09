import { type ChildProcess } from 'child_process';
import { EventEmitter, once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runInNewContext } from 'vm';

import { OpenClawGatewayProcessControl } from '../../shared/openclawEngine/constants';
import {
  buildOpenClawGatewayShutdownBridge,
  OpenClawGatewaySignal,
  spawnOpenClawGatewayProcess,
  stopOpenClawGatewayProcess,
} from './openclawGatewayProcess';

const tempDirs: string[] = [];

function makeEntry(source: string): { cwd: string; entryPath: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw gateway process '));
  tempDirs.push(cwd);
  const entryPath = path.join(cwd, 'gateway entry.cjs');
  fs.writeFileSync(entryPath, source);
  return { cwd, entryPath };
}

async function readResult(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('stopOpenClawGatewayProcess', () => {
  const makeChild = () => Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;

  test('waits for slow graceful shutdown without reporting an early stop', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const stopped = vi.fn();
    const pending = stopOpenClawGatewayProcess(child).then(stopped);

    await vi.advanceTimersByTimeAsync(5_300);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith(OpenClawGatewaySignal.Terminate);
    expect(stopped).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    await pending;
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('escalates to SIGKILL and still waits for the exit event', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = makeChild();
    const stopped = vi.fn();
    const pending = stopOpenClawGatewayProcess(child).then(stopped);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, OpenClawGatewaySignal.Kill);
    expect(stopped).not.toHaveBeenCalled();
    child.emit('exit', null, OpenClawGatewaySignal.Kill);
    await pending;
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  test('rejects when force termination fails to produce an exit', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = makeChild();
    const pending = stopOpenClawGatewayProcess(child);
    const rejected = expect(pending).rejects.toThrow('did not exit after SIGKILL');

    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  test('preserves kill errors and continues waiting for actual exit', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = makeChild();
    vi.mocked(child.kill).mockImplementation(() => {
      child.emit('error', new Error('EPERM'));
      return false;
    });
    const pending = stopOpenClawGatewayProcess(child);
    const rejected = expect(pending).rejects.toThrow('EPERM');

    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  test('recognizes an already completed signal exit', async () => {
    const child = makeChild();
    child.signalCode = OpenClawGatewaySignal.Terminate;
    await stopOpenClawGatewayProcess(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('requests shutdown over IPC and waits for actual exit before completing', async () => {
    vi.useFakeTimers();
    const child = Object.assign(makeChild(), { connected: true, send: vi.fn() });
    const stopped = vi.fn();
    const pending = stopOpenClawGatewayProcess(child).then(stopped);

    expect(child.send).toHaveBeenCalledExactlyOnceWith(
      { type: OpenClawGatewayProcessControl.Shutdown }, expect.any(Function),
    );
    await vi.advanceTimersByTimeAsync(5_300);
    expect(child.kill).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    await pending;
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([false, true])('forces shutdown when IPC fails (throws: %s)', async (throws) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ipcError = new Error('IPC channel closed');
    const child = Object.assign(makeChild(), {
      connected: true,
      send: vi.fn((_message, callback: (error: Error) => void) => {
        if (throws) throw ipcError;
        callback(ipcError);
        return false;
      }),
    });
    const pending = stopOpenClawGatewayProcess(child);
    const rejected = expect(pending).rejects.toThrow(ipcError.message);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith(OpenClawGatewaySignal.Kill);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Windows gateway shutdown bridge', () => {
  test('buffers shutdown until the gateway installs its handler and delivers it once', async () => {
    const childProcess = Object.assign(new EventEmitter(), { send: vi.fn() });
    runInNewContext(buildOpenClawGatewayShutdownBridge(), { process: childProcess, queueMicrotask });
    childProcess.emit('message', { type: OpenClawGatewayProcessControl.Shutdown });
    const shutdown = vi.fn();
    childProcess.on(OpenClawGatewaySignal.Interrupt, shutdown);
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledOnce();
    childProcess.emit('message', { type: OpenClawGatewayProcessControl.Shutdown });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(childProcess.listenerCount('newListener')).toBe(0);
  });

  test('ignores unrelated messages and remains inert without a parent IPC channel', () => {
    const childProcess = Object.assign(new EventEmitter(), { send: vi.fn() });
    const shutdown = vi.fn();
    childProcess.on(OpenClawGatewaySignal.Interrupt, shutdown);
    runInNewContext(buildOpenClawGatewayShutdownBridge(), { process: childProcess, queueMicrotask });
    for (const message of [null, {}, { type: 'other' }]) childProcess.emit('message', message);
    expect(shutdown).not.toHaveBeenCalled();
    childProcess.emit('message', { type: OpenClawGatewayProcessControl.Shutdown });
    expect(shutdown).toHaveBeenCalledOnce();

    const standalone = new EventEmitter();
    runInNewContext(buildOpenClawGatewayShutdownBridge(), { process: standalone, queueMicrotask });
    expect(standalone.eventNames()).toEqual([]);
  });

  test.skipIf(process.platform !== 'win32')('lets a real Windows child complete asynchronous cleanup', async () => {
    const entry = makeEntry(buildOpenClawGatewayShutdownBridge() + `
      process.on(${JSON.stringify(OpenClawGatewaySignal.Interrupt)}, () => {
        setTimeout(() => {
          console.log('cleanup completed');
          process.exit(0);
        }, 50);
      });
      process.send('ready');
    `);
    const child = spawnOpenClawGatewayProcess({
      executablePath: process.execPath, ...entry, args: [], execArgv: [], env: process.env,
    });
    const result = readResult(child);
    try {
      await once(child, 'message');
      await stopOpenClawGatewayProcess(child);
      expect(await result).toEqual({ code: 0, stdout: 'cleanup completed\n', stderr: '' });
      expect(child.signalCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill(OpenClawGatewaySignal.Kill);
    }
  });
});

describe('spawnOpenClawGatewayProcess', () => {
  test('propagates Node mode to gateway workers while preserving launch arguments and environment', async () => {
    const entry = makeEntry(`
      const { spawnSync } = require('node:child_process');
      const worker = spawnSync(process.execPath, [
        '-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE || "missing")',
      ], { encoding: 'utf8' });
      if (worker.status !== 0) throw new Error(worker.stderr);
      console.log(JSON.stringify({
        args: process.argv.slice(2),
        execArgv: process.execArgv,
        cwd: process.cwd(),
        nodeMode: process.env.ELECTRON_RUN_AS_NODE,
        workerNodeMode: worker.stdout,
        marker: process.env.OPENCLAW_TEST_MARKER,
      }));
    `);
    const args = ['gateway', '--port', '18789', 'argument with spaces'];
    const execArgv = ['--max-old-space-size=256'];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '0', OPENCLAW_TEST_MARKER: 'preserved' };

    const result = await readResult(spawnOpenClawGatewayProcess({
      executablePath: process.execPath,
      ...entry,
      args,
      execArgv,
      env,
    }));

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args,
      execArgv,
      cwd: fs.realpathSync(entry.cwd),
      nodeMode: '1',
      workerNodeMode: '1',
      marker: 'preserved',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBe('0');
  });

  test('reports gateway failures and stderr to the supervisor', async () => {
    const entry = makeEntry('process.stderr.write("gateway failed"); process.exitCode = 7;');

    const result = await readResult(spawnOpenClawGatewayProcess({
      executablePath: process.execPath,
      ...entry,
      args: [],
      execArgv: [],
      env: process.env,
    }));

    expect(result).toEqual({ code: 7, stdout: '', stderr: 'gateway failed' });
  });
});
