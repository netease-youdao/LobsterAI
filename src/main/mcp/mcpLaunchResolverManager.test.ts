import path from 'path';
import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getName: () => 'LobsterAI',
    getPath: () => process.cwd(),
    isPackaged: false,
  },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));

import { McpLaunchResolutionStatus, McpLaunchResolverKind } from './mcpLaunchResolution';
import {
  __mcpLaunchResolverTestUtils,
  isRecoverableNodeRuntimeResolutionError,
  isStaleInstallingResolution,
  packageRootFromInstallDir,
} from './mcpLaunchResolverManager';

test('packageRootFromInstallDir preserves scoped npm package paths', () => {
  expect(packageRootFromInstallDir('C:\\managed', '@upstash/context7-mcp')).toBe(
    path.join('C:\\managed', 'node_modules', '@upstash', 'context7-mcp'),
  );
});

test('packageRootFromInstallDir resolves unscoped npm package paths', () => {
  expect(packageRootFromInstallDir('C:\\managed', 'tavily-mcp')).toBe(
    path.join('C:\\managed', 'node_modules', 'tavily-mcp'),
  );
});

test('isStaleInstallingResolution detects abandoned installs', () => {
  const now = 1_000_000;

  expect(isStaleInstallingResolution({
    serverId: 'server-1',
    resolverKind: McpLaunchResolverKind.Npx,
    sourceFingerprint: 'fingerprint',
    status: McpLaunchResolutionStatus.Installing,
    updatedAt: now - 151_000,
  }, now)).toBe(true);

  expect(isStaleInstallingResolution({
    serverId: 'server-1',
    resolverKind: McpLaunchResolverKind.Npx,
    sourceFingerprint: 'fingerprint',
    status: McpLaunchResolutionStatus.Installing,
    updatedAt: now - 149_000,
  }, now)).toBe(false);
});

test('resolveNpmCommand prefers bundled npm-cli.js through Electron runtime', () => {
  const npmCommand = __mcpLaunchResolverTestUtils.resolveNpmCommand();

  expect(npmCommand.command).toBe(process.execPath);
  expect(npmCommand.baseArgs[0]).toContain(path.join('node_modules', 'npm', 'bin', 'npm-cli.js'));
  expect(npmCommand.env.ELECTRON_RUN_AS_NODE).toBe('1');
  expect(npmCommand.shell).toBe(false);
});

test('isRecoverableNodeRuntimeResolutionError detects Windows node shim ENOENT', () => {
  expect(isRecoverableNodeRuntimeResolutionError({
    serverId: 'server-1',
    resolverKind: McpLaunchResolverKind.Npx,
    sourceFingerprint: 'fingerprint',
    status: McpLaunchResolutionStatus.Failed,
    error: 'spawn C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\cowork\\bin\\node ENOENT',
    updatedAt: Date.now(),
  })).toBe(true);

  expect(isRecoverableNodeRuntimeResolutionError({
    serverId: 'server-1',
    resolverKind: McpLaunchResolverKind.Npx,
    sourceFingerprint: 'fingerprint',
    status: McpLaunchResolutionStatus.Failed,
    error: 'npm view exited with code 1',
    updatedAt: Date.now(),
  })).toBe(false);
});
