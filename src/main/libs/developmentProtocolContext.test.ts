import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  buildDevelopmentProtocolArgs,
  DevelopmentProtocolSwitch,
  resolveDevelopmentLaunchContext,
} from './developmentProtocolContext';

const profile = path.resolve('fixtures', 'expert profile');
const entryPoint = path.resolve('fixtures', 'LobsterAI');

describe('development protocol launch context', () => {
  test('ordinary source launches retain their existing environment and defaults without protocol arguments', () => {
    expect(resolveDevelopmentLaunchContext({ isPackaged: false, environment: {} })).toEqual({
      userDataDir: undefined,
      isDev: false,
      serverUrl: 'http://localhost:5175',
    });
    expect(resolveDevelopmentLaunchContext({
      isPackaged: false,
      environment: { NODE_ENV: 'development', ELECTRON_START_URL: 'http://localhost:5190' },
    })).toEqual({ userDataDir: undefined, isDev: true, serverUrl: 'http://localhost:5190' });
  });

  test('preserves the profile and Vite server when the OS drops the parent environment', () => {
    const original = resolveDevelopmentLaunchContext({
      isPackaged: false,
      environment: {
        NODE_ENV: 'development',
        ELECTRON_START_URL: 'http://localhost:5188',
        LOBSTERAI_DEV_USER_DATA_DIR: profile,
      },
    });
    const args = buildDevelopmentProtocolArgs({ ...original, entryPoint, userDataDir: original.userDataDir! });
    const argument = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
    const relaunched = resolveDevelopmentLaunchContext({
      isPackaged: false,
      environment: {},
      userDataDirArgument: argument(DevelopmentProtocolSwitch.UserDataDir),
      startUrlArgument: argument(DevelopmentProtocolSwitch.StartUrl),
    });
    expect(args[0]).toBe(entryPoint);
    expect(relaunched).toEqual(original);
    expect(relaunched.userDataDir).toBe(profile);
  });

  test('the registered profile takes precedence over a different inherited environment', () => {
    expect(resolveDevelopmentLaunchContext({
      isPackaged: false,
      environment: { LOBSTERAI_DEV_USER_DATA_DIR: path.resolve('another-profile') },
      userDataDirArgument: profile,
    }).userDataDir).toBe(profile);
  });

  test('packaged applications ignore development profile and renderer arguments', () => {
    const context = resolveDevelopmentLaunchContext({
      isPackaged: true,
      environment: { LOBSTERAI_DEV_USER_DATA_DIR: profile },
      userDataDirArgument: profile,
      startUrlArgument: 'http://localhost:5188',
    });
    expect(context.userDataDir).toBeUndefined();
    expect(context.isDev).toBe(false);
    expect(context.serverUrl).toBe('http://localhost:5175');
  });

  test('relative profile arguments cannot change the OS-launch data directory', () => {
    expect(resolveDevelopmentLaunchContext({
      isPackaged: false,
      environment: { LOBSTERAI_DEV_USER_DATA_DIR: profile },
      userDataDirArgument: '../profile',
    }).userDataDir).toBe(profile);
    expect(resolveDevelopmentLaunchContext({
      isPackaged: false,
      environment: { LOBSTERAI_DEV_USER_DATA_DIR: '../profile' },
    }).userDataDir).toBeUndefined();
  });

  test('a production renderer launched from source does not become a Vite client', () => {
    const context = resolveDevelopmentLaunchContext({ isPackaged: false, environment: {} });
    expect(buildDevelopmentProtocolArgs({ ...context, entryPoint, userDataDir: profile })).toEqual([
      entryPoint,
      `--${DevelopmentProtocolSwitch.UserDataDir}=${profile}`,
    ]);
  });

  test('rejects unsafe renderer URL arguments and does not persist them in protocol registration', () => {
    for (const serverUrl of [
      'https://remote.example:5175',
      'file:///tmp/page.html',
      'http://user:secret@localhost:5175',
      'http://localhost:5175/path',
      'http://localhost:5175?mode=other',
      'http://localhost:5175#other',
      'invalid-url',
    ]) {
      const context = resolveDevelopmentLaunchContext({ isPackaged: false, environment: {}, startUrlArgument: serverUrl });
      expect(context.isDev).toBe(false);
      expect(buildDevelopmentProtocolArgs({ entryPoint, userDataDir: profile, isDev: true, serverUrl })).toHaveLength(2);
    }
  });

  test('supports literal IPv4 and IPv6 loopback development servers', () => {
    for (const serverUrl of ['http://127.0.0.1:5175', 'https://[::1]:5175']) {
      expect(resolveDevelopmentLaunchContext({ isPackaged: false, environment: {}, startUrlArgument: serverUrl })).toMatchObject({
        isDev: true,
        serverUrl,
      });
    }
  });
});
