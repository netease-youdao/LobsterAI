import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { spawnOpenClawGatewayProcess, stopOpenClawGatewayProcess } from './openclawGatewayProcess';

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
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
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
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(stopped).not.toHaveBeenCalled();
    child.emit('exit', null, 'SIGKILL');
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
    child.signalCode = 'SIGTERM';
    await stopOpenClawGatewayProcess(child);
    expect(child.kill).not.toHaveBeenCalled();
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
