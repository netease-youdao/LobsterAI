import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PythonEncodingEnv } from './pythonEncodingEnv';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => path.join(process.cwd(), 'test-python-profile'), isPackaged: false },
}));

import { appendPythonRuntimeToEnv, getUserPythonRoot } from './pythonRuntime';

const originalPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

describe('Python runtime child environments', () => {
  test('sets encoding defaults even when no managed Python directory exists', () => {
    const env = { PATH: 'system-python' };
    appendPythonRuntimeToEnv(env);

    expect(env).toEqual({ PATH: 'system-python', [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });
  });

  test('retains managed runtime precedence and the existing PATH while adding defaults', () => {
    const root = getUserPythonRoot();
    vi.mocked(fs.existsSync).mockImplementation(candidate => candidate === root);
    const env = { PATH: 'system-python' };
    appendPythonRuntimeToEnv(env);

    expect(env).toEqual({
      PATH: [root, path.join(root, 'Scripts'), 'system-python'].join(';'),
      LOBSTERAI_PYTHON_ROOT: root,
      [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8',
    });
  });

  test('preserves explicit encoding values from the caller', () => {
    const env = { pythonutf8: '0', pythonioencoding: 'gbk' };
    appendPythonRuntimeToEnv(env);

    expect(env).toEqual({ [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk' });
  });

  test.each(['darwin', 'linux'] as const)('leaves %s unchanged', platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    const env = { PATH: 'system-python', pythonutf8: '' };
    appendPythonRuntimeToEnv(env);

    expect(env).toEqual({ PATH: 'system-python', pythonutf8: '' });
  });
});
