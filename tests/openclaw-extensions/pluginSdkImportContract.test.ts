import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

type PluginSdkImport = {
  file: string;
  line: number;
  specifier: string;
  name: string | null;
};

type PluginSdkExportsSnapshot = {
  openclawVersion: string;
  modules: Record<string, { target: string | null; exports: string[] }>;
};

type PluginSdkContractModule = {
  SNAPSHOT_RELATIVE_PATH: string;
  EXTENSIONS_RELATIVE_DIR: string;
  buildPluginSdkExportsSnapshot: (params: {
    runtimeRoot: string;
    imports: PluginSdkImport[];
    openclawVersion: string;
  }) => PluginSdkExportsSnapshot;
  collectLocalExtensionPluginSdkImports: (extensionsDir: string, baseDir?: string) => PluginSdkImport[];
  collectPluginSdkImportsFromSource: (sourceText: string, fileName: string) => PluginSdkImport[];
  findBuiltOpenClawRuntimeRoot: (projectRoot: string) => string | null;
  normalizePluginSdkSpecifier: (specifier: unknown) => string | null;
  readPinnedOpenClawVersion: (projectRoot: string) => string;
  readPluginSdkExportTables: (runtimeRoot: string, targets: string[]) => Map<string, string[]>;
  readPluginSdkExportsSnapshot: (projectRoot: string) => PluginSdkExportsSnapshot | null;
  readRuntimeBuildInfo: (runtimeRoot: string) => { openclawVersion?: string } | null;
  resolvePluginSdkTarget: (
    hostPackage: { exports?: Record<string, unknown> },
    specifier: string,
  ) => string | null;
  verifyPluginSdkImports: (imports: PluginSdkImport[], snapshot: PluginSdkExportsSnapshot) => string[];
};

const require = createRequire(import.meta.url);
const contract: PluginSdkContractModule = require('../../scripts/openclaw-plugin-sdk-contract.cjs');

const repoRoot = path.resolve(__dirname, '../..');
const extensionsDir = path.join(repoRoot, contract.EXTENSIONS_RELATIVE_DIR);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const scan = (source: string, fileName = 'openclaw-extensions/example/index.ts') => (
  contract.collectPluginSdkImportsFromSource(source, fileName)
    .map(({ specifier, name }) => ({ specifier, name }))
);

describe('plugin SDK import scanner', () => {
  test('collects runtime-linked value imports and ignores type-only ones', () => {
    expect(scan(`
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import defaultExport, { one, two as alias, type OnlyType } from 'openclaw/plugin-sdk/core';
import * as everything from 'openclaw/plugin-sdk/runtime';
import { unrelated } from 'some-other-package';
import './side-effect';
`)).toEqual([
      { specifier: 'openclaw/plugin-sdk/core', name: 'default' },
      { specifier: 'openclaw/plugin-sdk/core', name: 'one' },
      { specifier: 'openclaw/plugin-sdk/core', name: 'two' },
      { specifier: 'openclaw/plugin-sdk/runtime', name: null },
    ]);
  });

  test('collects re-exports and destructured dynamic imports', () => {
    expect(scan(`
export { first as renamed, type Shape } from 'openclaw/plugin-sdk/provider-model-shared';
export * from 'openclaw/plugin-sdk/health';
export type { Ignored } from 'openclaw/plugin-sdk/setup';
const { streamSimple, complete: run } = await import('openclaw/plugin-sdk/llm');
const lazy = await import('openclaw/plugin-sdk/routing');
import('openclaw/plugin-sdk/archive').then(() => undefined);
void run;
void lazy;
void streamSimple;
`)).toEqual([
      { specifier: 'openclaw/plugin-sdk/provider-model-shared', name: 'first' },
      { specifier: 'openclaw/plugin-sdk/health', name: null },
      { specifier: 'openclaw/plugin-sdk/llm', name: 'streamSimple' },
      { specifier: 'openclaw/plugin-sdk/llm', name: 'complete' },
      { specifier: 'openclaw/plugin-sdk/routing', name: null },
      { specifier: 'openclaw/plugin-sdk/archive', name: null },
    ]);
  });

  test('records the file and line of every import', () => {
    expect(contract.collectPluginSdkImportsFromSource(
      "import { a } from 'openclaw/plugin-sdk/core';\n\nimport { b } from 'openclaw/plugin-sdk/llm';\n",
      'openclaw-extensions/example/index.ts',
    )).toEqual([
      { file: 'openclaw-extensions/example/index.ts', line: 1, specifier: 'openclaw/plugin-sdk/core', name: 'a' },
      { file: 'openclaw-extensions/example/index.ts', line: 3, specifier: 'openclaw/plugin-sdk/llm', name: 'b' },
    ]);
  });

  test('normalizes the legacy clawdbot alias and ignores other packages', () => {
    expect(contract.normalizePluginSdkSpecifier('clawdbot/plugin-sdk/llm')).toBe('openclaw/plugin-sdk/llm');
    expect(contract.normalizePluginSdkSpecifier('openclaw/plugin-sdk')).toBe('openclaw/plugin-sdk');
    expect(contract.normalizePluginSdkSpecifier('openclaw/plugin-sdk/provider-stream-shared'))
      .toBe('openclaw/plugin-sdk/provider-stream-shared');
    expect(contract.normalizePluginSdkSpecifier('openclaw/other')).toBeNull();
    expect(contract.normalizePluginSdkSpecifier('@openclaw/plugin-sdk')).toBeNull();
    expect(contract.normalizePluginSdkSpecifier(undefined)).toBeNull();
  });

  test('scans the checked-in local extensions', () => {
    const found = contract.collectLocalExtensionPluginSdkImports(extensionsDir, repoRoot);
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(entry.file.startsWith('openclaw-extensions/')).toBe(true);
      expect(entry.specifier.startsWith('openclaw/plugin-sdk')).toBe(true);
    }
    // The runtime has no `openclaw/plugin-sdk` root module; only type imports use it.
    expect(found.filter(entry => entry.specifier === 'openclaw/plugin-sdk')).toEqual([]);
  });
});

describe('plugin SDK export resolution', () => {
  test('resolves subpaths through the host exports map like the SDK bridge', () => {
    const host = {
      exports: {
        './plugin-sdk/llm': { default: './dist/plugin-sdk/llm.js' },
        './plugin-sdk/core': { types: './dist/plugin-sdk/core.d.ts', default: './dist/plugin-sdk/core.js' },
        './plugin-sdk/direct': './dist/plugin-sdk/direct.mjs',
        './plugin-sdk/conditional': { import: './dist/plugin-sdk/conditional.js' },
        './plugin-sdk/escaped': { default: '../outside/escaped.js' },
      },
    };
    expect(contract.resolvePluginSdkTarget(host, 'openclaw/plugin-sdk/llm')).toBe('dist/plugin-sdk/llm.js');
    expect(contract.resolvePluginSdkTarget(host, 'openclaw/plugin-sdk/core')).toBe('dist/plugin-sdk/core.js');
    expect(contract.resolvePluginSdkTarget(host, 'openclaw/plugin-sdk/direct')).toBe('dist/plugin-sdk/direct.mjs');
    expect(contract.resolvePluginSdkTarget(host, 'openclaw/plugin-sdk')).toBeNull();
    expect(contract.resolvePluginSdkTarget(host, 'openclaw/plugin-sdk/missing')).toBeNull();
    expect(() => contract.resolvePluginSdkTarget(host, 'openclaw/plugin-sdk/conditional'))
      .toThrow(/Unsupported SDK export/);
    expect(() => contract.resolvePluginSdkTarget(host, 'openclaw/plugin-sdk/escaped'))
      .toThrow(/Invalid SDK target/);
  });

  test('reads export tables from ESM modules without evaluating them', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-sdk-contract-'));
    tempDirs.push(runtimeRoot);
    const moduleDir = path.join(runtimeRoot, 'dist', 'plugin-sdk');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'probe.js'), [
      "throw new Error('the export table must be read statically');",
      'const zeta = 1;',
      'const alpha = 2;',
      'export { zeta as renamed, alpha };',
      'export default alpha;',
      '',
    ].join('\n'));

    const tables = contract.readPluginSdkExportTables(runtimeRoot, ['dist/plugin-sdk/probe.js']);

    expect(tables.get('dist/plugin-sdk/probe.js')).toEqual(['alpha', 'default', 'renamed']);
  });
});

describe('plugin SDK import verification', () => {
  const snapshot: PluginSdkExportsSnapshot = {
    openclawVersion: 'v2026.8.1',
    modules: {
      'openclaw/plugin-sdk/provider-stream-shared': {
        target: 'dist/plugin-sdk/provider-stream-shared.js',
        exports: ['createMoonshotThinkingWrapper'],
      },
      'openclaw/plugin-sdk': { target: null, exports: [] },
    },
  };

  test('accepts imports the pinned runtime exports', () => {
    expect(contract.verifyPluginSdkImports(
      scanFull("import { createMoonshotThinkingWrapper } from 'openclaw/plugin-sdk/provider-stream-shared';"),
      snapshot,
    )).toEqual([]);
  });

  test('reports the retired Kimi K3 wrapper import that broke the v2026.8.1 upgrade', () => {
    expect(contract.verifyPluginSdkImports(
      scanFull("import { createMoonshotKimiK3Wrapper } from 'openclaw/plugin-sdk/provider-stream-shared';"),
      snapshot,
    )).toEqual([
      'openclaw-extensions/example/index.ts:1: "openclaw/plugin-sdk/provider-stream-shared" does not export '
      + '"createMoonshotKimiK3Wrapper" in the pinned OpenClaw runtime.',
    ]);
  });

  test('reports modules missing from the snapshot or from the runtime', () => {
    expect(contract.verifyPluginSdkImports(
      scanFull([
        "import { something } from 'openclaw/plugin-sdk/not-snapshotted';",
        "import { defineSomething } from 'openclaw/plugin-sdk';",
      ].join('\n')),
      snapshot,
    )).toEqual([
      'openclaw-extensions/example/index.ts:1: "openclaw/plugin-sdk/not-snapshotted" is not in '
      + `${contract.SNAPSHOT_RELATIVE_PATH}; rebuild the runtime and run \`npm run openclaw:sdk-contract\`.`,
      'openclaw-extensions/example/index.ts:2: the pinned OpenClaw runtime does not export the plugin SDK '
      + 'module "openclaw/plugin-sdk".',
    ]);
  });
});

describe('plugin SDK export snapshot', () => {
  const pinnedVersion = contract.readPinnedOpenClawVersion(repoRoot);
  const snapshot = contract.readPluginSdkExportsSnapshot(repoRoot);
  const extensionImports = contract.collectLocalExtensionPluginSdkImports(extensionsDir, repoRoot);
  const runtimeRoot = contract.findBuiltOpenClawRuntimeRoot(repoRoot);
  const runtimeVersion = runtimeRoot
    ? contract.readRuntimeBuildInfo(runtimeRoot)?.openclawVersion
    : undefined;

  test('is generated for the pinned OpenClaw version', () => {
    expect(
      snapshot,
      `${contract.SNAPSHOT_RELATIVE_PATH} is missing; run \`npm run openclaw:sdk-contract\``,
    ).not.toBeNull();
    expect(snapshot?.openclawVersion).toBe(pinnedVersion);
  });

  test('local extensions import only names the pinned plugin SDK exports', () => {
    expect(snapshot).not.toBeNull();
    expect(contract.verifyPluginSdkImports(extensionImports, snapshot!)).toEqual([]);
  });

  test.skipIf(!runtimeRoot || runtimeVersion !== pinnedVersion)(
    'matches the built OpenClaw runtime when one is present',
    () => {
      const fresh = contract.buildPluginSdkExportsSnapshot({
        runtimeRoot: runtimeRoot!,
        imports: extensionImports,
        openclawVersion: pinnedVersion,
      });
      expect(fresh, 'snapshot is stale; run `npm run openclaw:sdk-contract`').toEqual(snapshot);
    },
  );
});

function scanFull(source: string): PluginSdkImport[] {
  return contract.collectPluginSdkImportsFromSource(source, 'openclaw-extensions/example/index.ts');
}
