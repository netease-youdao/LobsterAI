import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  BUNDLED_SKILLS_TO_KEEP,
  KOFFI_BUILD_ONLY_PATHS,
  KOFFI_PACKAGE,
  LARK_SDK_PACKAGE,
  PACKAGES_TO_STUB,
  RUNTIME_UNUSED_PATHS,
  isWindowsRuntimeTarget,
  preferExternalLark,
  pruneBundledSkills,
  readRuntimeTarget,
  removeRuntimeUnusedPaths,
  resolvePackagesToStub,
  shouldDeleteFile,
  shouldKeepBundledExtension,
  shouldKeepBundledSkill,
  trimKoffiBuildFiles,
} = require('../scripts/prune-openclaw-runtime.cjs');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-prune-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content = 'fixture'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneOpenClawRuntime keeps required bundled extensions', () => {
  expect(shouldKeepBundledExtension('openai')).toBe(true);
  expect(shouldKeepBundledExtension('browser')).toBe(true);
  expect(shouldKeepBundledExtension('feishu')).toBe(true);
  expect(shouldKeepBundledExtension('xiaomi')).toBe(true);
});

test('pruneOpenClawRuntime removes explicitly unwanted bundled extensions', () => {
  expect(shouldKeepBundledExtension('amazon-bedrock')).toBe(false);
  expect(shouldKeepBundledExtension('amazon-bedrock-mantle')).toBe(false);
  expect(shouldKeepBundledExtension('slack')).toBe(false);
  expect(shouldKeepBundledExtension('diffs')).toBe(false);
});

test('pruneOpenClawRuntime keeps only allowlisted bundled skills', () => {
  expect(shouldKeepBundledSkill('diagram-maker')).toBe(true);
  // LobsterAI ships its own versions; the bundled copies would shadow them.
  expect(shouldKeepBundledSkill('skill-creator')).toBe(false);
  expect(shouldKeepBundledSkill('weather')).toBe(false);
  // Conflicts with LobsterAI's skill store and managed config.
  expect(shouldKeepBundledSkill('clawhub')).toBe(false);
  expect(shouldKeepBundledSkill('healthcheck')).toBe(false);
  // Requires binaries absent on most machines; probing them costs startup time.
  expect(shouldKeepBundledSkill('spotify-player')).toBe(false);
  expect(shouldKeepBundledSkill('python-debugpy')).toBe(false);
});

test('pruneOpenClawRuntime never keeps a bundled skill that LobsterAI ships itself', () => {
  // Bundled skills load after skills.load.extraDirs and win name collisions,
  // which would hide LobsterAI's own skill of the same name.
  const lobsterSkillsDir = path.join(__dirname, '..', 'SKILLs');
  const lobsterSkills = fs.readdirSync(lobsterSkillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  expect(lobsterSkills).toContain('skill-creator');
  expect(lobsterSkills.filter(name => BUNDLED_SKILLS_TO_KEEP.has(name))).toEqual([]);
});

test('pruneOpenClawRuntime removes unlisted bundled skills and all custodian skills', () => {
  const root = tempDir();
  write(root, 'skills/diagram-maker/SKILL.md');
  write(root, 'skills/diagram-maker/references/svg-template.md');
  write(root, 'skills/skill-creator/SKILL.md');
  write(root, 'skills/spotify-player/SKILL.md');
  write(root, 'skills/pyproject.toml');
  write(root, 'custodian-skills/configure-channel/SKILL.md');
  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0 };

  const removed = pruneBundledSkills(root, stats);

  expect(removed.sort()).toEqual(['custodian-skills', 'skill-creator', 'spotify-player']);
  expect(fs.readdirSync(path.join(root, 'skills')).sort()).toEqual(['diagram-maker', 'pyproject.toml']);
  expect(fs.existsSync(path.join(root, 'skills/diagram-maker/references/svg-template.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'custodian-skills'))).toBe(false);
  expect(stats.dirsRemoved).toBe(3);
  expect(stats.bytesFreed).toBeGreaterThan(0);

  expect(pruneBundledSkills(root, stats)).toEqual([]);
});

test('pruneOpenClawRuntime skill pruning tolerates runtimes without skill directories', () => {
  const root = tempDir();
  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0 };
  expect(pruneBundledSkills(root, stats)).toEqual([]);
  expect(stats.dirsRemoved).toBe(0);
});

test('pruneOpenClawRuntime keeps koffi only for Windows runtime targets', () => {
  expect(PACKAGES_TO_STUB).toContain(KOFFI_PACKAGE);
  expect(isWindowsRuntimeTarget('win-x64')).toBe(true);
  expect(isWindowsRuntimeTarget('win-arm64')).toBe(true);
  expect(isWindowsRuntimeTarget('mac-arm64')).toBe(false);
  expect(isWindowsRuntimeTarget('')).toBe(false);
  expect(isWindowsRuntimeTarget(undefined)).toBe(false);
  expect(resolvePackagesToStub('win-x64')).toEqual(PACKAGES_TO_STUB.filter((name: string) => name !== KOFFI_PACKAGE));
  expect(resolvePackagesToStub('mac-arm64')).toEqual(PACKAGES_TO_STUB);
  expect(resolvePackagesToStub('')).toEqual(PACKAGES_TO_STUB);
});

test('pruneOpenClawRuntime reads the runtime target from build metadata', () => {
  const root = tempDir();
  expect(readRuntimeTarget(root)).toBe('');
  write(root, 'runtime-build-info.json', JSON.stringify({ target: 'win-x64' }));
  expect(readRuntimeTarget(root)).toBe('win-x64');
  write(root, 'runtime-build-info.json', JSON.stringify({ target: 7 }));
  expect(readRuntimeTarget(root)).toBe('');
  write(root, 'runtime-build-info.json', '{not json');
  expect(readRuntimeTarget(root)).toBe('');
});

test('pruneOpenClawRuntime trims only build-time koffi content and keeps the loader', () => {
  const root = tempDir();
  const nodeModules = path.join(root, 'node_modules');
  const kept = [
    'koffi/index.cjs', 'koffi/index.js', 'koffi/package.json', 'koffi/src/koffi/index.cjs',
    'koffi/src/koffi/src/static.cjs', 'koffi/lib/native/base/api.h',
    '@koromix/koffi-win32-x64/index.js', '@koromix/koffi-win32-x64/win32_x64/koffi.node',
  ];
  const removed = ['koffi/doc/index.html', 'koffi/vendor/node-api-headers/node_api.h', 'koffi/CHANGELOG.md', 'koffi/cnoke.cjs'];
  for (const relative of [...kept, ...removed]) write(nodeModules, relative);
  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0 };
  expect([...trimKoffiBuildFiles(nodeModules, stats)].sort()).toEqual([...KOFFI_BUILD_ONLY_PATHS].sort());
  for (const relative of kept) expect(fs.existsSync(path.join(nodeModules, relative))).toBe(true);
  for (const relative of removed) expect(fs.existsSync(path.join(nodeModules, relative))).toBe(false);
  expect(stats.dirsRemoved).toBe(2);
  expect(stats.filesRemoved).toBe(2);
  expect(stats.bytesFreed).toBeGreaterThan(0);
  expect(trimKoffiBuildFiles(nodeModules, stats)).toEqual([]);
  expect(trimKoffiBuildFiles(path.join(root, 'missing'), stats)).toEqual([]);
});

test('pruneOpenClawRuntime keeps the loaded runtime files and drops unused package content', () => {
  const root = tempDir();
  const nodeModules = path.join(root, 'node_modules');
  const kept = [
    'tree-sitter-bash/package.json', 'tree-sitter-bash/tree-sitter-bash.wasm',
    'tree-sitter-bash/bindings/node/index.js', 'hono/package.json',
    'typescript/package.json', 'typescript/lib/typescript.js', 'typescript/lib/lib.es2022.d.ts',
  ];
  const removed = [
    'tree-sitter-bash/src/parser.c', 'tree-sitter-bash/prebuilds/darwin-arm64/tree-sitter-bash.node',
    '@cloudflare/workers-types/index.ts', 'bun-types/package.json', 'typescript/lib/_tsc.js',
    ...RUNTIME_UNUSED_PATHS
      .filter((relative: string) => /^typescript\/lib\/[a-z-]+$/.test(relative))
      .map((relative: string) => `${relative}/diagnosticMessages.generated.json`),
  ];
  for (const relative of [...kept, ...removed]) write(nodeModules, relative);
  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0 };
  expect([...removeRuntimeUnusedPaths(nodeModules, stats)].sort()).toEqual([...RUNTIME_UNUSED_PATHS].sort());
  for (const relative of kept) expect(fs.existsSync(path.join(nodeModules, relative))).toBe(true);
  for (const relative of removed) expect(fs.existsSync(path.join(nodeModules, relative))).toBe(false);
  expect(stats.filesRemoved).toBe(1);
  expect(stats.dirsRemoved).toBe(RUNTIME_UNUSED_PATHS.length - 1);
  expect(stats.bytesFreed).toBeGreaterThan(0);
  expect(removeRuntimeUnusedPaths(nodeModules, stats)).toEqual([]);
});

test('pruneOpenClawRuntime drops native debug symbols but keeps the binaries', () => {
  expect(shouldDeleteFile('conpty.pdb')).toBe(true);
  expect(shouldDeleteFile('conpty_console_list.PDB')).toBe(true);
  expect(shouldDeleteFile('conpty.node')).toBe(false);
  expect(shouldDeleteFile('conpty.dll')).toBe(false);
  expect(shouldDeleteFile('OpenConsole.exe')).toBe(false);
});

test('pruneOpenClawRuntime drops bundled feishu and its root Lark SDK when openclaw-lark is present', () => {
  const root = tempDir();
  const kept = [
    `third-party-extensions/openclaw-lark/node_modules/${LARK_SDK_PACKAGE}/index.js`,
    'dist/extensions/telegram/index.js',
    'node_modules/grammy/package.json',
  ];
  for (const relative of [...kept, 'dist/extensions/feishu/index.js', `node_modules/${LARK_SDK_PACKAGE}/index.js`]) {
    write(root, relative);
  }
  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0 };
  expect(preferExternalLark(root, stats)).toEqual(['bundled feishu', `root ${LARK_SDK_PACKAGE}`]);
  for (const relative of kept) expect(fs.existsSync(path.join(root, relative))).toBe(true);
  expect(fs.existsSync(path.join(root, 'dist/extensions/feishu'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'node_modules/@larksuiteoapi'))).toBe(false);
  expect(stats.dirsRemoved).toBe(2);
  expect(stats.bytesFreed).toBeGreaterThan(0);
  expect(preferExternalLark(root, stats)).toEqual([]);
});

test('pruneOpenClawRuntime keeps feishu and the Lark SDK without openclaw-lark', () => {
  const root = tempDir();
  const kept = ['dist/extensions/feishu/index.js', `node_modules/${LARK_SDK_PACKAGE}/index.js`];
  for (const relative of kept) write(root, relative);
  expect(preferExternalLark(root, { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0 })).toEqual([]);
  for (const relative of kept) expect(fs.existsSync(path.join(root, relative))).toBe(true);
});
