import { test, expect, vi, beforeEach } from 'vitest';
import * as cp from 'child_process';
import type { SpawnSyncReturns } from 'child_process';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { checkDockerForSandbox } from './dockerSandboxCheck';

const spawnSyncMock = vi.mocked(cp.spawnSync);

beforeEach(() => {
  spawnSyncMock.mockReset();
});

test('returns ok when docker info succeeds', () => {
  spawnSyncMock.mockReturnValue({
    status: 0,
    signal: null,
    error: undefined,
    stdout: '24.0.0\n',
    stderr: '',
  } as unknown as SpawnSyncReturns<string>);
  const r = checkDockerForSandbox();
  expect(r.ok).toBe(true);
  expect(r.code).toBe('ok');
  expect(r.serverVersion).toBe('24.0.0');
});

test('returns cli_missing when docker binary is missing', () => {
  const err = Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' });
  spawnSyncMock.mockReturnValue({
    status: null,
    signal: null,
    error: err,
    stdout: '',
    stderr: '',
  } as unknown as SpawnSyncReturns<string>);
  const r = checkDockerForSandbox();
  expect(r.ok).toBe(false);
  expect(r.code).toBe('cli_missing');
});

test('returns daemon_unavailable on non-zero exit', () => {
  spawnSyncMock.mockReturnValue({
    status: 1,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon',
  } as unknown as SpawnSyncReturns<string>);
  const r = checkDockerForSandbox();
  expect(r.ok).toBe(false);
  expect(r.code).toBe('daemon_unavailable');
});
