import { spawnSync } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { getElectronNodeRuntimePath } from './coworkUtil';

export interface NodeRuntimeCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface NodePackageCliCommand {
  command: string;
  baseArgs: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

type CommandLookup = (
  command: string,
  env?: NodeJS.ProcessEnv,
) => string[];

function normalizeWindowsPathForCompare(value: string): string {
  return path.win32.resolve(value).toLowerCase();
}

function isInsideWindowsDirectory(candidate: string, parent: string): boolean {
  const resolvedCandidate = normalizeWindowsPathForCompare(candidate);
  const resolvedParent = normalizeWindowsPathForCompare(parent);
  return resolvedCandidate === resolvedParent
    || resolvedCandidate.startsWith(`${resolvedParent}${path.win32.sep}`);
}

function getUserDataNodeShimDir(): string | null {
  try {
    return path.join(app.getPath('userData'), 'cowork', 'bin');
  } catch {
    return null;
  }
}

function defaultCommandLookup(command: string, env?: NodeJS.ProcessEnv): string[] {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(checker, [command], {
      encoding: 'utf-8',
      env,
      timeout: 5000,
      windowsHide: process.platform === 'win32',
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function isSpawnableWindowsNode(candidate: string, userDataPath?: string | null): boolean {
  if (!candidate.trim().toLowerCase().endsWith('.exe')) return false;
  if (path.win32.basename(candidate).toLowerCase() !== 'node.exe') return false;

  const shimDir = userDataPath
    ? path.win32.join(userDataPath, 'cowork', 'bin')
    : getUserDataNodeShimDir();
  if (shimDir && isInsideWindowsDirectory(candidate, shimDir)) return false;

  return true;
}

export function selectSpawnableNodeCandidate(
  candidates: string[],
  platform = process.platform,
  userDataPath?: string | null,
): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (platform === 'win32') {
      if (isSpawnableWindowsNode(trimmed, userDataPath)) return trimmed;
      continue;
    }
    return trimmed;
  }
  return null;
}

export function findSpawnableSystemNodePath(
  env: NodeJS.ProcessEnv = process.env,
  lookup: CommandLookup = defaultCommandLookup,
): string | null {
  return selectSpawnableNodeCandidate(lookup('node', env));
}

export function resolveNodeRuntimeForSpawn(
  env: NodeJS.ProcessEnv = process.env,
  lookup?: CommandLookup,
): NodeRuntimeCommand {
  const systemNode = findSpawnableSystemNodePath(env, lookup);
  if (systemNode) {
    return {
      command: systemNode,
      args: [],
      env: {},
    };
  }

  return {
    command: getElectronNodeRuntimePath(),
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export function resolveBundledNodePackageCli(cliName: 'npm' | 'npx'): string | null {
  const cliFile = `${cliName}-cli.js`;
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin', cliFile)]
    : [
        path.join(app.getAppPath(), 'node_modules', 'npm', 'bin', cliFile),
        path.join(process.cwd(), 'node_modules', 'npm', 'bin', cliFile),
      ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

export function resolveNodePackageCliCommand(
  cliName: 'npm' | 'npx',
  env: NodeJS.ProcessEnv = process.env,
): NodePackageCliCommand {
  const bundledCli = resolveBundledNodePackageCli(cliName);
  if (bundledCli) {
    return {
      command: getElectronNodeRuntimePath(),
      baseArgs: [bundledCli],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
    };
  }

  const isWin = process.platform === 'win32';
  return {
    command: isWin ? `${cliName}.cmd` : cliName,
    baseArgs: [],
    env: { ...env },
    shell: isWin,
  };
}
