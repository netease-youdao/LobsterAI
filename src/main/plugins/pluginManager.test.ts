import { afterEach, expect, test, vi } from 'vitest';

const nodeRuntimeMocks = vi.hoisted(() => ({
  resolveNodePackageCliCommand: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('../libs/nodeRuntime', () => nodeRuntimeMocks);

import { __pluginManagerTestUtils, isHiddenUserPluginId } from './pluginManager';

afterEach(() => {
  nodeRuntimeMocks.resolveNodePackageCliCommand.mockReset();
});

test('resolveNpmCommand delegates to shared npm runtime resolution', () => {
  const resolved = {
    command: 'C:\\LobsterAI\\LobsterAI.exe',
    baseArgs: ['C:\\LobsterAI\\resources\\app.asar.unpacked\\node_modules\\npm\\bin\\npm-cli.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    shell: false,
  };
  nodeRuntimeMocks.resolveNodePackageCliCommand.mockReturnValue(resolved);

  expect(__pluginManagerTestUtils.resolveNpmCommand()).toBe(resolved);
  expect(nodeRuntimeMocks.resolveNodePackageCliCommand).toHaveBeenCalledWith('npm');
});

test('passes explicit capability consent to OpenClaw plugin installs', () => {
  expect(
    __pluginManagerTestUtils.buildOpenClawPluginInstallArgs(
      'C:\\LobsterAI\\openclaw.mjs',
      'C:\\staging\\plugin.tgz',
    ),
  ).toEqual([
    'C:\\LobsterAI\\openclaw.mjs',
    'plugins',
    'install',
    'C:\\staging\\plugin.tgz',
    '--force',
    '--accept-capabilities',
  ]);
  expect(__pluginManagerTestUtils.openClawPluginInstallTimeoutMs).toBe(
    process.platform === 'win32' ? 20 * 60 * 1000 : 5 * 60 * 1000,
  );
});

test('hides OpenClaw built-in xai provider plugin from user plugin sync', () => {
  expect(isHiddenUserPluginId('xai')).toBe(true);
});
