import { describe, expect, test } from 'vitest';

import { McpNodeEnv } from '../../shared/mcp/constants';
import { applyNodeSystemCaDefault } from './nodeSystemCaEnv';

describe('applyNodeSystemCaDefault', () => {
  test('trusts the system certificate store by default', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin' };
    applyNodeSystemCaDefault(env, { platform: 'darwin' });
    expect(env).toEqual({ PATH: '/bin', [McpNodeEnv.UseSystemCa]: '1' });
  });

  test.each(['0', ''])('keeps an explicit value %j', value => {
    const env: Record<string, string | undefined> = { [McpNodeEnv.UseSystemCa]: value };
    applyNodeSystemCaDefault(env, { platform: 'linux' });
    expect(env).toEqual({ [McpNodeEnv.UseSystemCa]: value });
  });

  test('treats an undefined entry as unset', () => {
    const env: Record<string, string | undefined> = { [McpNodeEnv.UseSystemCa]: undefined };
    applyNodeSystemCaDefault(env, { platform: 'linux' });
    expect(env[McpNodeEnv.UseSystemCa]).toBe('1');
  });

  test('matches an explicit value case-insensitively on Windows', () => {
    const env: Record<string, string | undefined> = { node_use_system_ca: '0' };
    applyNodeSystemCaDefault(env, { platform: 'win32' });
    expect(env).toEqual({ node_use_system_ca: '0' });
  });

  test('matches the exact spelling elsewhere, where env names are case-sensitive', () => {
    const env: Record<string, string | undefined> = { node_use_system_ca: '0' };
    applyNodeSystemCaDefault(env, { platform: 'linux' });
    expect(env).toEqual({ node_use_system_ca: '0', [McpNodeEnv.UseSystemCa]: '1' });
  });
});
