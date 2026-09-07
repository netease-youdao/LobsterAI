import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  collectHostPeerLeftovers,
  pruneHostPeerLeftovers,
  resolveDependencyLocation,
} = require('../scripts/openclaw-plugin-host-peer-leftovers.cjs');

type LockPackages = Record<string, Record<string, unknown>>;

// Mirrors what npm leaves behind after installing a plugin whose required
// `openclaw` peer was auto-installed and hoisted: the plugin's own tree
// (alpha -> beta -> nested gamma@2, shared) plus the peer tree (openclaw,
// hoisted gamma@1, claude-agent-sdk and its platform binary).
const FIXTURE_PACKAGES: LockPackages = {
  'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^1.0.0', shared: '^1.0.0' } },
  'node_modules/beta': { version: '1.0.0', dependencies: { gamma: '^2.0.0' } },
  'node_modules/beta/node_modules/gamma': { version: '2.0.0' },
  'node_modules/gamma': { version: '1.0.0', peer: true },
  'node_modules/shared': { version: '1.0.0' },
  'node_modules/openclaw': {
    version: '2026.8.2',
    peer: true,
    dependencies: { gamma: '^1.0.0', shared: '^1.0.0', '@anthropic-ai/claude-agent-sdk': '0.3.241' },
  },
  'node_modules/@anthropic-ai/claude-agent-sdk': {
    version: '0.3.241',
    peer: true,
    optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': '0.3.241' },
  },
  'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': { version: '0.3.241', peer: true, optional: true },
};

function createPluginFixture(options: { withLockfile?: boolean } = {}): string {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-leftovers-'));
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'fixture-plugin',
      version: '1.0.0',
      dependencies: { alpha: '^1.0.0' },
      peerDependencies: { openclaw: '>=2026.3.22' },
      devDependencies: { devtool: '^1.0.0' },
    }),
  );

  for (const location of Object.keys(FIXTURE_PACKAGES)) {
    const packageDir = path.join(pluginDir, location);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: path.basename(location) }));
    fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(packageDir, 'cli.js'), '#!/usr/bin/env node\n');
  }

  const binDir = path.join(pluginDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join('..', 'alpha', 'cli.js'), path.join(binDir, 'alpha-cli'));
  fs.symlinkSync(path.join('..', 'gamma', 'cli.js'), path.join(binDir, 'gamma-cli'));

  if (options.withLockfile !== false) {
    fs.writeFileSync(
      path.join(pluginDir, 'node_modules', '.package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, requires: true, packages: FIXTURE_PACKAGES }, null, 2),
    );
  }
  return pluginDir;
}

function readHiddenLockLocations(pluginDir: string): string[] {
  const lock = JSON.parse(fs.readFileSync(path.join(pluginDir, 'node_modules', '.package-lock.json'), 'utf-8'));
  return Object.keys(lock.packages);
}

describe('openclaw-plugin-host-peer-leftovers', () => {
  test('resolves dependency names like Node does, walking up nested node_modules', () => {
    expect(resolveDependencyLocation('node_modules/beta', 'gamma', FIXTURE_PACKAGES))
      .toBe('node_modules/beta/node_modules/gamma');
    expect(resolveDependencyLocation('node_modules/alpha', 'gamma', FIXTURE_PACKAGES))
      .toBe('node_modules/gamma');
    expect(resolveDependencyLocation('', 'alpha', FIXTURE_PACKAGES)).toBe('node_modules/alpha');
    expect(resolveDependencyLocation('node_modules/beta/node_modules/gamma', 'missing', FIXTURE_PACKAGES))
      .toBeNull();
  });

  test('flags only packages that are unreachable without the openclaw peer', () => {
    const pluginDir = createPluginFixture();

    const leftovers = collectHostPeerLeftovers(pluginDir).map((item: { location: string }) => item.location);
    expect(leftovers).toEqual([
      'node_modules/@anthropic-ai/claude-agent-sdk',
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64',
      'node_modules/gamma',
      'node_modules/openclaw',
    ]);

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  test('prunes the leftover tree and keeps the plugin dependencies intact', () => {
    const pluginDir = createPluginFixture();
    const nodeModulesDir = path.join(pluginDir, 'node_modules');

    const result = pruneHostPeerLeftovers(pluginDir);
    expect(result.removed).toEqual([
      'node_modules/@anthropic-ai/claude-agent-sdk',
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64',
      'node_modules/gamma',
      'node_modules/openclaw',
    ]);
    expect(result.bytesFreed).toBeGreaterThan(0);

    for (const kept of ['alpha', 'beta', 'beta/node_modules/gamma', 'shared']) {
      expect(fs.existsSync(path.join(nodeModulesDir, kept, 'index.js'))).toBe(true);
    }
    for (const removed of ['openclaw', 'gamma', '@anthropic-ai']) {
      expect(fs.existsSync(path.join(nodeModulesDir, removed))).toBe(false);
    }
    expect(fs.existsSync(path.join(nodeModulesDir, '.bin', 'alpha-cli'))).toBe(true);
    expect(fs.lstatSync(path.join(nodeModulesDir, '.bin', 'alpha-cli')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(nodeModulesDir, '.bin', 'gamma-cli'))).toBe(false);
    expect(readHiddenLockLocations(pluginDir)).toEqual([
      'node_modules/alpha',
      'node_modules/beta',
      'node_modules/beta/node_modules/gamma',
      'node_modules/shared',
    ]);

    expect(pruneHostPeerLeftovers(pluginDir)).toEqual({ removed: [], bytesFreed: 0 });
    expect(collectHostPeerLeftovers(pluginDir)).toEqual([]);

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  test('falls back to well-known peer-only packages when no hidden lockfile exists', () => {
    const pluginDir = createPluginFixture({ withLockfile: false });

    const leftovers = collectHostPeerLeftovers(pluginDir).map((item: { location: string }) => item.location);
    expect(leftovers).toEqual([
      'node_modules/@anthropic-ai/claude-agent-sdk',
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64',
      'node_modules/openclaw',
    ]);

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  test('removes a linked host package without touching the link target', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-link-'));
    const pluginDir = path.join(tempDir, 'plugin');
    const hostDir = path.join(tempDir, 'host-openclaw');
    fs.mkdirSync(path.join(pluginDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'linked', version: '1.0.0' }));
    fs.writeFileSync(path.join(hostDir, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.6.1' }));
    fs.symlinkSync(hostDir, path.join(pluginDir, 'node_modules', 'openclaw'), 'junction');

    expect(pruneHostPeerLeftovers(pluginDir).removed).toEqual(['node_modules/openclaw']);
    expect(fs.existsSync(path.join(pluginDir, 'node_modules', 'openclaw'))).toBe(false);
    expect(fs.existsSync(path.join(hostDir, 'package.json'))).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('never inspects or prunes through a symlinked node_modules', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-shared-'));
    const pluginDir = path.join(tempDir, 'plugin');
    const sharedNodeModules = path.join(tempDir, 'shared-node-modules');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(path.join(sharedNodeModules, 'openclaw'), { recursive: true });
    fs.mkdirSync(path.join(sharedNodeModules, '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'shared', version: '1.0.0' }));
    fs.writeFileSync(path.join(sharedNodeModules, 'openclaw', 'package.json'), '{"name":"openclaw"}');
    fs.symlinkSync(sharedNodeModules, path.join(pluginDir, 'node_modules'), 'junction');

    expect(collectHostPeerLeftovers(pluginDir)).toEqual([]);
    expect(pruneHostPeerLeftovers(pluginDir)).toEqual({ removed: [], bytesFreed: 0 });
    expect(fs.existsSync(path.join(sharedNodeModules, 'openclaw', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(sharedNodeModules, '@anthropic-ai', 'claude-agent-sdk'))).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reports nothing for plugins without node_modules', () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-empty-'));
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0' }));

    expect(collectHostPeerLeftovers(pluginDir)).toEqual([]);
    expect(pruneHostPeerLeftovers(pluginDir)).toEqual({ removed: [], bytesFreed: 0 });

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });
});
