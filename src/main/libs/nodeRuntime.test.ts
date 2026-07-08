import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockElectronState = vi.hoisted(() => ({
  appPath: process.cwd(),
  isPackaged: false,
  userData: `${process.cwd()}\\.test-node-runtime-user-data`,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => mockElectronState.appPath,
    getName: () => 'LobsterAI',
    getPath: (name: string) => (name === 'userData' ? mockElectronState.userData : os.tmpdir()),
    isPackaged: mockElectronState.isPackaged,
  },
}));

import {
  resolveNodePackageCliCommand,
  resolveNodeRuntimeForSpawn,
  selectSpawnableNodeCandidate,
} from './nodeRuntime';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

beforeEach(() => {
  mockElectronState.appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-node-runtime-'));
  mockElectronState.isPackaged = false;
  mockElectronState.userData = path.join(os.tmpdir(), 'lobsterai-user-data');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  fs.rmSync(mockElectronState.appPath, { recursive: true, force: true });
});

describe('selectSpawnableNodeCandidate', () => {
  test('skips LobsterAI bash and cmd shims on Windows and returns node.exe', () => {
    expect(selectSpawnableNodeCandidate([
      'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\cowork\\bin\\node',
      'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\cowork\\bin\\node.cmd',
      'C:\\Program Files\\nodejs\\node.exe',
    ], 'win32', 'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI')).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    );
  });

  test('returns null on Windows when only non-native shims are available', () => {
    expect(selectSpawnableNodeCandidate([
      'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\cowork\\bin\\node',
      'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\cowork\\bin\\node.cmd',
    ], 'win32', 'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI')).toBeNull();
  });

  test('keeps the first command candidate on macOS', () => {
    expect(selectSpawnableNodeCandidate(['/opt/homebrew/bin/node'], 'darwin')).toBe('/opt/homebrew/bin/node');
  });
});

describe('resolveNodeRuntimeForSpawn', () => {
  test('uses real node.exe on Windows when present after LobsterAI shims', () => {
    setPlatform('win32');

    const runtime = resolveNodeRuntimeForSpawn({}, () => [
      'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\cowork\\bin\\node',
      'C:\\Program Files\\nodejs\\node.exe',
    ]);

    expect(runtime).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [],
      env: {},
    });
  });

  test('falls back to Electron-as-node when Windows only finds the bash shim', () => {
    setPlatform('win32');

    const runtime = resolveNodeRuntimeForSpawn({}, () => [
      'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\cowork\\bin\\node',
    ]);

    expect(runtime.command).toBe(process.execPath);
    expect(runtime.args).toEqual([]);
    expect(runtime.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('resolveNodePackageCliCommand', () => {
  test('prefers bundled npm-cli.js through Electron-as-node', () => {
    const npmCli = path.join(mockElectronState.appPath, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, '');

    const command = resolveNodePackageCliCommand('npm', { PATH: 'ignored' });

    expect(command.command).toBe(process.execPath);
    expect(command.baseArgs).toEqual([npmCli]);
    expect(command.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(command.shell).toBe(false);
  });
});
