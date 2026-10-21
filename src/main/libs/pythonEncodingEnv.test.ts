import { describe, expect, test } from 'vitest';

import { applyPythonEncodingDefaults, PythonEncodingEnv } from './pythonEncodingEnv';

describe('Windows Python encoding defaults', () => {
  test('fills missing and empty values without changing unrelated environment entries', () => {
    const env = { PATH: 'custom-path', [PythonEncodingEnv.Utf8]: '', [PythonEncodingEnv.IoEncoding]: undefined };
    applyPythonEncodingDefaults(env, { platform: 'win32' });

    expect(env).toEqual({ PATH: 'custom-path', [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });
  });

  test('preserves an explicit opt-out and a custom encoding with its error handler', () => {
    const env = { [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk:backslashreplace' };
    applyPythonEncodingDefaults(env, { platform: 'win32' });

    expect(env).toEqual({ [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk:backslashreplace' });
  });

  test('normalizes case variants and removes duplicate Windows keys', () => {
    const env = { pythonutf8: '0', PythonIoEncoding: 'gbk' };
    applyPythonEncodingDefaults(env, { platform: 'win32' });

    expect(env).toEqual({ [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk' });
  });

  test('prefers the canonical spelling if one source contains conflicting variants', () => {
    const env = { pythonutf8: '0', [PythonEncodingEnv.Utf8]: '1' };
    applyPythonEncodingDefaults(env, { platform: 'win32' });

    expect(env).toEqual({ [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });
  });

  test('later source overrides win across spelling differences without inheriting unrelated values', () => {
    const parent = { [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'latin-1', PRIVATE_TOKEN: 'parent-only' };
    const resolved = { [PythonEncodingEnv.IoEncoding]: 'utf-8:surrogateescape' };
    const server = { pythonioencoding: 'gbk' };
    const env = { ...resolved, ...server };
    applyPythonEncodingDefaults(env, { platform: 'win32', sources: [parent, undefined, resolved, server] });

    expect(env).toEqual({ [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk' });
    expect(parent.PRIVATE_TOKEN).toBe('parent-only');
    expect(server).toEqual({ pythonioencoding: 'gbk' });
  });

  test('an explicit empty override restores the default instead of the inherited legacy encoding', () => {
    const env = { pythonioencoding: '' };
    applyPythonEncodingDefaults(env, {
      platform: 'win32',
      sources: [{ [PythonEncodingEnv.IoEncoding]: 'gbk' }, env],
    });

    expect(env).toEqual({ [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });
  });

  test('repeated application is stable', () => {
    const env = { pythonutf8: '0' };
    applyPythonEncodingDefaults(env, { platform: 'win32' });
    const first = { ...env };
    applyPythonEncodingDefaults(env, { platform: 'win32' });

    expect(env).toEqual(first);
  });

  test.each(['darwin', 'linux'] as const)('does not change %s environments or import parent values', platform => {
    const env = { pythonutf8: '', PATH: 'custom-path' };
    applyPythonEncodingDefaults(env, {
      platform,
      sources: [{ [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' }],
    });

    expect(env).toEqual({ pythonutf8: '', PATH: 'custom-path' });
  });
});
