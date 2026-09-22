import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const nodeRuntimeMocks = vi.hoisted(() => ({
  resolveNodeRuntimeForSpawn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('../libs/nodeRuntime', () => nodeRuntimeMocks);

import { __skillServicesTestUtils, SkillServiceManager } from './skillServices';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReset();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveSkillServiceNodeRuntime delegates to shared node runtime resolution', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    env: {},
  });

  expect(__skillServicesTestUtils.resolveSkillServiceNodeRuntime({ PATH: 'ignored' })).toEqual({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    extraEnv: undefined,
  });
});

test('resolveSkillServiceNodeRuntime preserves Electron-as-node fallback env', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\LobsterAI\\LobsterAI.exe',
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });

  expect(__skillServicesTestUtils.resolveSkillServiceNodeRuntime({ PATH: 'ignored' })).toEqual({
    command: 'C:\\LobsterAI\\LobsterAI.exe',
    args: [],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
});

describe('stopWebSearchService', () => {
  function makeService() {
    const skillPath = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-stop-'));
    tempDirs.push(skillPath);
    const pidFile = path.join(skillPath, '.server.pid');
    const pid = 12345;
    fs.writeFileSync(pidFile, String(pid));
    const manager = new SkillServiceManager();
    vi.spyOn(manager as unknown as { getWebSearchPath(): string }, 'getWebSearchPath')
      .mockReturnValue(skillPath);
    return { manager, pid, pidFile };
  }

  test('completes as soon as the process exits instead of sleeping for two seconds', async () => {
    vi.useFakeTimers();
    const { manager, pid, pidFile } = makeService();
    let running = true;
    vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      expect(targetPid).toBe(pid);
      if (!running) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      if (signal === 'SIGTERM') setTimeout(() => { running = false; }, 80);
      return true;
    });
    const stopped = vi.fn();
    const pending = manager.stopWebSearchService().then(stopped);

    await vi.advanceTimersByTimeAsync(50);
    expect(stopped).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(stopped).toHaveBeenCalledOnce();
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('bounds waiting for a stuck process and retains its PID for another attempt', async () => {
    vi.useFakeTimers();
    const { manager, pidFile } = makeService();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stopped = vi.fn();
    const pending = manager.stopWebSearchService().then(stopped);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not stop within'));
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(manager.isWebSearchServiceRunning()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('does not wait when the service has already exited', async () => {
    vi.useFakeTimers();
    const { manager } = makeService();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    await manager.stopWebSearchService();

    expect(kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
