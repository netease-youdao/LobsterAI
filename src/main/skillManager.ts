import { app, BrowserWindow, session } from 'electron';
import { execSync, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import extractZip from 'extract-zip';
import { SqliteStore } from './sqliteStore';
import { cpRecursiveSync } from './fsCompat';
import { getElectronNodeRuntimePath } from './libs/coworkUtil';
import { appendPythonRuntimeToEnv } from './libs/pythonRuntime';
import { scanSkillSecurity, scanMultipleSkillDirs, mergeReports } from './libs/skillSecurity/skillSecurityScanner';
import type { SkillSecurityReport, SecurityReportAction } from './libs/skillSecurity/skillSecurityTypes';
import { t } from './i18n';

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm won't be in PATH unless we resolve it explicitly.
 */
function resolveUserShellPath(): string | null {
  if (process.platform === 'win32') return null;

  try {
    const shell = process.env.SHELL || '/bin/bash';
    // Use non-interactive login shell to avoid side effects in interactive startup scripts.
    const result = execSync(`${shell} -lc 'echo __PATH__=$PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
    });
    const match = result.match(/__PATH__=(.+)/);
    return match ? match[1].trim() : null;
  } catch (error) {
    console.warn('[skills] Failed to resolve user shell PATH:', error);
    return null;
  }
}

/**
 * Check if a command exists in the given environment.
 */
function hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  const isWin = process.platform === 'win32';
  const checker = isWin ? 'where' : 'which';
  // On Windows, use shell: true so cmd.exe resolves PATH correctly
  // (avoids issues with duplicated PATH/Path keys in env)
  const result = spawnSync(checker, [command], {
    stdio: 'pipe',
    env,
    shell: isWin,
    timeout: 5000,
  });
  if (result.status !== 0) {
    console.log(`[skills] hasCommand('${command}'): not found (status=${result.status}, error=${result.error?.message || 'none'})`);
  }
  return result.status === 0;
}

/**
 * Normalize the PATH key in an env object on Windows.
 * Windows env vars are case-insensitive, but JS objects are case-sensitive.
 * After spreading process.env, the key might be "Path" or "PATH".
 * We normalize to "PATH" to avoid issues with duplicate keys.
 */
function normalizePathKey(env: Record<string, string | undefined>): void {
  if (process.platform !== 'win32') return;

  const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
  if (pathKeys.length <= 1) return;

  // Merge all PATH-like values (separated by ;), then remove duplicates
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const key of pathKeys) {
    const value = env[key];
    if (!value) continue;
    for (const entry of value.split(';')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase().replace(/[\\/]+$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(trimmed);
    }
    if (key !== 'PATH') {
      delete env[key];
    }
  }
  env.PATH = merged.join(';');
}

/**
 * Resolve the latest Windows system PATH from the registry.
 * When an Electron app is launched from Start Menu or Explorer,
 * process.env.PATH may be stale (missing tools installed after Explorer started).
 */
function resolveWindowsRegistryPath(): string | null {
  if (process.platform !== 'win32') return null;

  try {
    const machinePath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const userPath = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const extract = (output: string): string => {
      const match = output.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      return match ? match[1].trim() : '';
    };

    const combined = [extract(machinePath), extract(userPath)].filter(Boolean).join(';');
    return combined || null;
  } catch {
    return null;
  }
}

/**
 * Build an environment for spawning skill scripts.
 * Merges the user's shell PATH with the current process environment.
 */
function buildSkillEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // Normalize PATH key casing on Windows to avoid duplicate PATH/Path issues
  normalizePathKey(env);

  if (app.isPackaged) {
    // Ensure HOME is set (crucial for npm to find its config)
    if (!env.HOME) {
      env.HOME = app.getPath('home');
    }

    if (process.platform === 'win32') {
      // On Windows, merge the latest PATH from the registry to pick up
      // tools installed after the Electron app (or Explorer) was started.
      const registryPath = resolveWindowsRegistryPath();
      if (registryPath) {
        const currentPath = env.PATH || '';
        const seen = new Set(currentPath.toLowerCase().split(';').map(s => s.trim().replace(/[\\/]+$/, '')).filter(Boolean));
        const extra: string[] = [];
        for (const entry of registryPath.split(';')) {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase().replace(/[\\/]+$/, '');
          if (!seen.has(key)) {
            seen.add(key);
            extra.push(trimmed);
          }
        }
        if (extra.length > 0) {
          env.PATH = currentPath ? `${currentPath};${extra.join(';')}` : extra.join(';');
          console.log('[skills] Merged registry PATH entries for skill scripts');
        }
      }

      // Append common Windows Node.js installation paths as fallback
      const commonWinPaths = [
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        `${env.APPDATA || ''}\\npm`,
        `${env.LOCALAPPDATA || ''}\\Programs\\nodejs`,
      ].filter(Boolean);

      const pathSet = new Set((env.PATH || '').toLowerCase().split(';').map(s => s.trim().replace(/[\\/]+$/, '')));
      const missingPaths = commonWinPaths.filter(p => !pathSet.has(p.toLowerCase().replace(/[\\/]+$/, '')));
      if (missingPaths.length > 0) {
        env.PATH = env.PATH ? `${env.PATH};${missingPaths.join(';')}` : missingPaths.join(';');
      }
    } else {
      // Resolve user's shell PATH to find npm/node (macOS/Linux)
      const userPath = resolveUserShellPath();
      if (userPath) {
        env.PATH = userPath;
        console.log('[skills] Resolved user shell PATH for skill scripts');
      } else {
        // Fallback: append common node installation paths
        const commonPaths = [
          '/usr/local/bin',
          '/opt/homebrew/bin',
          `${env.HOME}/.nvm/current/bin`,
          `${env.HOME}/.volta/bin`,
          `${env.HOME}/.fnm/current/bin`,
        ];
        env.PATH = [env.PATH, ...commonPaths].filter(Boolean).join(':');
        console.log('[skills] Using fallback PATH for skill scripts');
      }
    }
  }

  // Expose Electron executable so skill scripts can run JS with ELECTRON_RUN_AS_NODE
  // even when system Node.js is not installed.
  env.LOBSTERAI_ELECTRON_PATH = getElectronNodeRuntimePath();
  appendPythonRuntimeToEnv(env);

  // Re-normalize after appendPythonRuntimeToEnv may have added a PATH key
  normalizePathKey(env);

  return env;
}

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
  version?: string;
};

type SkillStateMap = Record<string, { enabled: boolean }>;

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

type EmailConnectivityCheck = {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
};

type SkillDefaultConfig = {
  order?: number;
  enabled?: boolean;
};

type SkillsConfig = {
  version: number;
  description?: string;
  defaults: Record<string, SkillDefaultConfig>;
};

const SKILLS_DIR_NAME = 'SKILLs';
const SKILL_FILE_NAME = 'SKILL.md';
const SKILLS_CONFIG_FILE = 'skills.config.json';
const SKILL_STATE_KEY = 'skills_state';
const WATCH_DEBOUNCE_MS = 250;
const CLAUDE_SKILLS_DIR_NAME = '.claude';
const CLAUDE_SKILLS_SUBDIR = 'skills';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const parseFrontmatter = (raw: string): { frontmatter: Record<string, unknown>; content: string } => {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, content: normalized };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[skills] Failed to parse YAML frontmatter:', e);
  }

  const content = normalized.slice(match[0].length);
  return { frontmatter, content };
};

const isTruthy = (value?: unknown): boolean => {
  if (value === true) return true;
  if (!value) return false;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
};

const extractDescription = (content: string): string => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '');
  }
  return '';
};

const normalizeFolderName = (name: string): string => {
  const normalized = name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'skill';
};

const isZipFile = (filePath: string): boolean => path.extname(filePath).toLowerCase() === '.zip';

/**
 * Compare two semver-like version strings (e.g. "1.0.0" vs "1.0.1").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Non-numeric segments are treated as 0.
 */
const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
};

const resolveWithin = (root: string, target: string): string => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);
  if (resolvedTarget === resolvedRoot) return resolvedTarget;
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Invalid target path');
  }
  return resolvedTarget;
};

const appendEnvPath = (current: string | undefined, entries: string[]): string => {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const existing = (current || '').split(delimiter).filter(Boolean);
  const merged = [...existing];
  entries.forEach(entry => {
    if (!entry || merged.includes(entry)) return;
    merged.push(entry);
  });
  return merged.join(delimiter);
};

const listWindowsCommandPaths = (command: string): string[] => {
  if (process.platform !== 'win32') return [];

  try {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const resolveWindowsGitExecutable = (): string | null => {
  if (process.platform !== 'win32') return null;

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const installedCandidates = [
    path.join(programFiles, 'Git', 'cmd', 'git.exe'),
    path.join(programFiles, 'Git', 'bin', 'git.exe'),
    path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'git.exe'),
    'C:\\Git\\cmd\\git.exe',
    'C:\\Git\\bin\\git.exe',
  ];

  for (const candidate of installedCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const whereCandidates = listWindowsCommandPaths('where git');
  for (const candidate of whereCandidates) {
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (normalized.toLowerCase().endsWith('git.exe') && fs.existsSync(normalized)) {
      return normalized;
    }
  }

  const bundledRoots = app.isPackaged
    ? [path.join(process.resourcesPath, 'mingit')]
    : [
      path.join(__dirname, '..', '..', 'resources', 'mingit'),
      path.join(process.cwd(), 'resources', 'mingit'),
    ];

  for (const root of bundledRoots) {
    const bundledCandidates = [
      path.join(root, 'cmd', 'git.exe'),
      path.join(root, 'bin', 'git.exe'),
      path.join(root, 'mingw64', 'bin', 'git.exe'),
      path.join(root, 'usr', 'bin', 'git.exe'),
    ];
    for (const candidate of bundledCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

const resolveGitCommand = (): { command: string; env?: NodeJS.ProcessEnv } => {
  if (process.platform !== 'win32') {
    return { command: 'git' };
  }

  const gitExe = resolveWindowsGitExecutable();
  if (!gitExe) {
    return { command: 'git' };
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  const gitDir = path.dirname(gitExe);
  const gitRoot = path.dirname(gitDir);
  const candidateDirs = [
    gitDir,
    path.join(gitRoot, 'cmd'),
    path.join(gitRoot, 'bin'),
    path.join(gitRoot, 'mingw64', 'bin'),
    path.join(gitRoot, 'usr', 'bin'),
  ].filter(dir => fs.existsSync(dir));

  env.PATH = appendEnvPath(env.PATH, candidateDirs);
  return { command: gitExe, env };
};

const runCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', error => reject(error));
  child.on('close', code => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
  });
});

type SkillScriptRunResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  spawnErrorCode?: string;
};

const runScriptWithTimeout = (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SkillScriptRunResult> => new Promise((resolve) => {
  const startedAt = Date.now();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let forceKillTimer: NodeJS.Timeout | null = null;

  const settle = (result: SkillScriptRunResult) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2000);
  }, options.timeoutMs);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    settle({
      success: false,
      exitCode: null,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
      timedOut,
      error: error.message,
      spawnErrorCode: error.code,
    });
  });

  child.on('close', (exitCode) => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    settle({
      success: !timedOut && exitCode === 0,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
      timedOut,
      error: timedOut ? `Command timed out after ${options.timeoutMs}ms` : undefined,
    });
  });
});

const cleanupPathSafely = (targetPath: string | null): void => {
  if (!targetPath) return;
  try {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 5 : 0,
      retryDelay: process.platform === 'win32' ? 200 : 0,
    });
  } catch (error) {
    console.warn('[skills] Failed to cleanup temporary directory:', targetPath, error);
  }
};

const listSkillDirs = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const skillFile = path.join(root, SKILL_FILE_NAME);
  if (fs.existsSync(skillFile)) {
    return [root];
  }

  const entries = fs.readdirSync(root);
  return entries
    .map(entry => path.join(root, entry))
    .filter((entryPath) => {
      try {
        const stat = fs.lstatSync(entryPath);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          return false;
        }
        return fs.existsSync(path.join(entryPath, SKILL_FILE_NAME));
      } catch {
        return false;
      }
    });
};

const collectSkillDirsFromSource = (source: string): string[] => {
  const resolved = path.resolve(source);
  if (fs.existsSync(path.join(resolved, SKILL_FILE_NAME))) {
    return [resolved];
  }

  const nestedRoot = path.join(resolved, SKILLS_DIR_NAME);
  if (fs.existsSync(nestedRoot) && fs.statSync(nestedRoot).isDirectory()) {
    const nestedSkills = listSkillDirs(nestedRoot);
    if (nestedSkills.length > 0) {
      return nestedSkills;
    }
  }

  const directSkills = listSkillDirs(resolved);
  if (directSkills.length > 0) {
    return directSkills;
  }

  return collectSkillDirsRecursively(resolved);
};

const collectSkillDirsRecursively = (root: string): string[] => {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return [];

  const matchedDirs: string[] = [];
  const queue: string[] = [resolvedRoot];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const normalized = path.resolve(current);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(normalized);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

    if (fs.existsSync(path.join(normalized, SKILL_FILE_NAME))) {
      matchedDirs.push(normalized);
      continue;
    }

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(normalized);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry || entry === '.git' || entry === 'node_modules') continue;
      queue.push(path.join(normalized, entry));
    }
  }

  return matchedDirs;
};

const deriveRepoName = (source: string): string => {
  const cleaned = source.replace(/[#?].*$/, '');
  const base = cleaned.split('/').filter(Boolean).pop() || 'skill';
  return normalizeFolderName(base.replace(/\.git$/, ''));
};

type NormalizedGitSource = {
  repoUrl: string;
  sourceSubpath?: string;
  ref?: string;
  repoNameHint?: string;
};

type GithubRepoSource = {
  owner: string;
  repo: string;
};

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const parseGithubRepoSource = (repoUrl: string): GithubRepoSource | null => {
  const trimmed = repoUrl.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(trimmed);
    if (!['github.com', 'www.github.com'].includes(parsedUrl.hostname.toLowerCase())) {
      return null;
    }

    const segments = parsedUrl.pathname
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    return {
      owner: segments[0],
      repo: segments[1],
    };
  } catch {
    return null;
  }
};

const downloadGithubArchive = async (
  source: GithubRepoSource,
  tempRoot: string,
  ref?: string
): Promise<string> => {
  const encodedRef = ref ? encodeURIComponent(ref) : '';
  const archiveUrlCandidates: Array<{ url: string; headers: Record<string, string> }> = [];

  if (encodedRef) {
    archiveUrlCandidates.push(
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/refs/heads/${encodedRef}.zip`,
        headers: { 'User-Agent': 'LobsterAI Skill Downloader' },
      },
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/refs/tags/${encodedRef}.zip`,
        headers: { 'User-Agent': 'LobsterAI Skill Downloader' },
      },
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/${encodedRef}.zip`,
        headers: { 'User-Agent': 'LobsterAI Skill Downloader' },
      }
    );
  }

  archiveUrlCandidates.push({
    url: `https://api.github.com/repos/${source.owner}/${source.repo}/zipball${encodedRef ? `/${encodedRef}` : ''}`,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'LobsterAI Skill Downloader',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  let buffer: Buffer | null = null;
  let lastError: string | null = null;

  for (const candidate of archiveUrlCandidates) {
    try {
      const response = await session.defaultSession.fetch(candidate.url, {
        method: 'GET',
        headers: candidate.headers,
      });

      if (!response.ok) {
        const detail = (await response.text()).trim();
        lastError = `Archive download failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`;
        continue;
      }

      buffer = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      lastError = extractErrorMessage(error);
    }
  }

  if (!buffer) {
    throw new Error(lastError || 'Archive download failed');
  }

  const zipPath = path.join(tempRoot, 'github-archive.zip');
  const extractRoot = path.join(tempRoot, 'github-archive');
  fs.writeFileSync(zipPath, buffer);
  fs.mkdirSync(extractRoot, { recursive: true });
  await extractZip(zipPath, { dir: extractRoot });

  const extractedDirs = fs.readdirSync(extractRoot)
    .map(entry => path.join(extractRoot, entry))
    .filter(entryPath => {
      try {
        return fs.statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    });

  if (extractedDirs.length === 1) {
    return extractedDirs[0];
  }

  return extractRoot;
};

/**
 * Check if a source string looks like an npm package spec.
 * Supports: package-name, @scope/package, package@version, @scope/package@version
 */
const isNpmPackageSpec = (source: string): boolean => {
  // Must not be a local path, URL, or GitHub shorthand (owner/repo)
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('~')) return false;
  try { new URL(source); return false; } catch { /* not a URL, good */ }

  // Scoped package: @scope/name or @scope/name@version
  if (/^@[\w-]+\/[\w.-]+(@[\w.^~>=<*-]+)?$/.test(source)) return true;
  // Unscoped package: name or name@version (must not contain '/' which would be owner/repo)
  if (/^[\w.-]+(@[\w.^~>=<*-]+)?$/.test(source) && !source.includes('/')) return true;

  return false;
};

/**
 * Resolve the bundled npm-cli.js path for running npm commands.
 */
const resolveNpmCliJs = (): string | null => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [
        path.join(app.getAppPath(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(process.cwd(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ];
  return candidates.find(c => fs.existsSync(c)) || null;
};

/**
 * Download and extract an npm package using `npm pack`.
 * Similar to openclaw's plugin install: npm pack → extract .tgz → return path.
 */
const downloadNpmPackage = async (spec: string, tempRoot: string): Promise<string> => {
  const npmCliJs = resolveNpmCliJs();
  const electronPath = getElectronNodeRuntimePath();

  // Determine how to invoke npm
  let npmCommand: string;
  let npmArgs: string[];
  if (npmCliJs) {
    npmCommand = electronPath;
    npmArgs = [npmCliJs, 'pack', spec, '--ignore-scripts', '--json'];
  } else {
    npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    npmArgs = ['pack', spec, '--ignore-scripts', '--json'];
  }

  const packResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(npmCommand, npmArgs, {
      cwd: tempRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
  });

  if (packResult.code !== 0) {
    const detail = packResult.stderr.trim() || packResult.stdout.trim();
    throw new Error(`npm pack failed for "${spec}": ${detail}`);
  }

  // Find the .tgz file
  const tgzFiles = fs.readdirSync(tempRoot).filter(f => f.endsWith('.tgz'));
  if (tgzFiles.length === 0) {
    // Try parsing JSON output for filename
    try {
      const parsed = JSON.parse(packResult.stdout);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (entry.filename && fs.existsSync(path.join(tempRoot, entry.filename))) {
          tgzFiles.push(entry.filename);
          break;
        }
      }
    } catch { /* ignore */ }
  }

  if (tgzFiles.length === 0) {
    throw new Error(`npm pack produced no .tgz archive for "${spec}"`);
  }

  // Extract .tgz (which is a gzip'd tar containing a 'package/' directory)
  const tgzPath = path.join(tempRoot, tgzFiles[0]);
  const extractDir = path.join(tempRoot, 'npm-extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  // Use tar to extract (Node.js built-in zlib + tar via npm's own bundled tar)
  const tarExtract = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const tarCommand = npmCliJs ? electronPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const tarArgs = npmCliJs
      ? [npmCliJs, 'exec', '--', 'tar', 'xzf', tgzPath, '-C', extractDir]
      : ['exec', '--', 'tar', 'xzf', tgzPath, '-C', extractDir];

    // Try system tar first (available on all platforms including Windows 10+)
    const child = spawn('tar', ['xzf', tgzPath, '-C', extractDir], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    child.on('error', () => resolve({ code: 1, stderr: 'tar not found' }));
  });

  if (tarExtract.code !== 0) {
    throw new Error(`Failed to extract npm package: ${tarExtract.stderr}`);
  }

  // npm pack extracts to a 'package/' subdirectory
  const packageDir = path.join(extractDir, 'package');
  if (fs.existsSync(packageDir)) {
    return packageDir;
  }

  // Fallback: return first directory in extract dir
  const dirs = fs.readdirSync(extractDir)
    .map(name => path.join(extractDir, name))
    .filter(p => fs.statSync(p).isDirectory());
  return dirs[0] || extractDir;
};

const isRemoteZipUrl = (source: string): boolean => {
  try {
    const url = new URL(source);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.pathname.toLowerCase().endsWith('.zip');
  } catch {
    return false;
  }
};

const downloadZipUrl = async (zipUrl: string, tempRoot: string): Promise<string> => {
  const response = await session.defaultSession.fetch(zipUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'LobsterAI Skill Downloader' },
  });

  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const zipPath = path.join(tempRoot, 'remote-skill.zip');
  const extractRoot = path.join(tempRoot, 'remote-skill');
  fs.writeFileSync(zipPath, buffer);
  fs.mkdirSync(extractRoot, { recursive: true });
  await extractZip(zipPath, { dir: extractRoot });

  const extractedDirs = fs.readdirSync(extractRoot)
    .map(entry => path.join(extractRoot, entry))
    .filter(entryPath => {
      try {
        return fs.statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    });

  if (extractedDirs.length === 1) {
    return extractedDirs[0];
  }

  return extractRoot;
};

const normalizeGithubSubpath = (value: string): string | null => {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;
  const segments = trimmed
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
};

const parseGithubTreeOrBlobUrl = (source: string): NormalizedGitSource | null => {
  try {
    const parsedUrl = new URL(source);
    if (!['github.com', 'www.github.com'].includes(parsedUrl.hostname)) {
      return null;
    }

    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    if (segments.length < 5) {
      return null;
    }

    const [owner, repoRaw, mode, ref, ...rest] = segments;
    if (!owner || !repoRaw || !ref || (mode !== 'tree' && mode !== 'blob')) {
      return null;
    }

    const repo = repoRaw.replace(/\.git$/i, '');
    const sourceSubpath = normalizeGithubSubpath(rest.join('/'));
    if (!repo || !sourceSubpath) {
      return null;
    }

    return {
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      sourceSubpath,
      ref: decodeURIComponent(ref),
      repoNameHint: repo,
    };
  } catch {
    return null;
  }
};

const isWebSearchSkillBroken = (skillRoot: string): boolean => {
  const startServerScript = path.join(skillRoot, 'scripts', 'start-server.sh');
  const searchScript = path.join(skillRoot, 'scripts', 'search.sh');
  const serverEntry = path.join(skillRoot, 'dist', 'server', 'index.js');
  const requiredPaths = [
    startServerScript,
    searchScript,
    serverEntry,
    path.join(skillRoot, 'node_modules', 'iconv-lite', 'encodings', 'index.js'),
  ];

  if (requiredPaths.some(requiredPath => !fs.existsSync(requiredPath))) {
    return true;
  }

  try {
    const startScript = fs.readFileSync(startServerScript, 'utf-8');
    const searchScriptContent = fs.readFileSync(searchScript, 'utf-8');
    const serverEntryContent = fs.readFileSync(serverEntry, 'utf-8');
    if (!startScript.includes('WEB_SEARCH_FORCE_REPAIR')) {
      return true;
    }
    if (!startScript.includes('detect_healthy_bridge_server')) {
      return true;
    }
    if (!searchScriptContent.includes('ACTIVE_SERVER_URL')) {
      return true;
    }
    if (!searchScriptContent.includes('try_switch_to_local_server')) {
      return true;
    }
    if (!searchScriptContent.includes('build_search_payload')) {
      return true;
    }
    if (!searchScriptContent.includes('@query_file')) {
      return true;
    }
    if (!serverEntryContent.includes('decodeJsonRequestBody')) {
      return true;
    }
    if (!serverEntryContent.includes("TextDecoder('gb18030'")) {
      return true;
    }
    if (serverEntryContent.includes('scoreDecodedJsonText') && serverEntryContent.includes('Request body decoded using gb18030 (score')) {
      return true;
    }
  } catch {
    return true;
  }

  return false;
};

export class SkillManager {
  private watchers: fs.FSWatcher[] = [];
  private notifyTimer: NodeJS.Timeout | null = null;
  private changeListeners: Array<() => void> = [];
  private pendingInstalls = new Map<string, {
    tempDir: string;
    cleanupPath: string | null;
    root: string;
    skillDirs: string[];
    timer: NodeJS.Timeout;
    isUpgrade?: boolean;
    existingSkillDir?: string;
  }>();
  private upgradingSkillIds = new Set<string>();

  constructor(private getStore: () => SqliteStore) {}

  getSkillsRoot(): string {
    return path.resolve(app.getPath('userData'), SKILLS_DIR_NAME);
  }

  ensureSkillsRoot(): string {
    const root = this.getSkillsRoot();
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    return root;
  }

  recoverInterruptedUpgrades(): void {
    const root = this.getSkillsRoot();
    if (!fs.existsSync(root)) return;

    try {
      const entries = fs.readdirSync(root);
      for (const entry of entries) {
        if (!entry.endsWith('.upgrading')) continue;
        const backupDir = path.join(root, entry);
        const stat = fs.statSync(backupDir);
        if (!stat.isDirectory()) continue;

        const originalName = entry.replace(/\.upgrading$/, '');
        const originalDir = path.join(root, originalName);

        try {
          if (fs.existsSync(originalDir) && fs.existsSync(path.join(originalDir, SKILL_FILE_NAME))) {
            // Upgrade completed successfully, clean up backup
            console.log(`[SkillManager] cleaning up completed upgrade backup: ${entry}`);
            fs.rmSync(backupDir, { recursive: true, force: true });
          } else {
            // Upgrade was interrupted, roll back
            console.log(`[SkillManager] rolling back interrupted upgrade: ${entry} → ${originalName}`);
            if (fs.existsSync(originalDir)) {
              fs.rmSync(originalDir, { recursive: true, force: true });
            }
            fs.renameSync(backupDir, originalDir);
          }
        } catch (error) {
          console.warn(`[SkillManager] failed to recover upgrade for ${entry}:`, error);
        }
      }
    } catch (error) {
      console.warn('[SkillManager] failed to recover interrupted upgrades:', error);
    }
  }

  syncBundledSkillsToUserData(): void {
    if (!app.isPackaged) {
      return;
    }

    console.log('[skills] syncBundledSkillsToUserData: start');
    const userRoot = this.ensureSkillsRoot();
    console.log('[skills] syncBundledSkillsToUserData: userRoot =', userRoot);
    const bundledRoot = this.getBundledSkillsRoot();
    console.log('[skills] syncBundledSkillsToUserData: bundledRoot =', bundledRoot);
    if (!bundledRoot || bundledRoot === userRoot || !fs.existsSync(bundledRoot)) {
      console.log('[skills] syncBundledSkillsToUserData: bundledRoot skipped (missing or same as userRoot)');
      return;
    }

    try {
      const bundledSkillDirs = listSkillDirs(bundledRoot);
      console.log('[skills] syncBundledSkillsToUserData: found', bundledSkillDirs.length, 'bundled skills');
      bundledSkillDirs.forEach((dir) => {
        const id = path.basename(dir);
        const targetDir = path.join(userRoot, id);
        const targetExists = fs.existsSync(targetDir);

        // Check if skill needs repair
        let shouldRepair = false;
        let needsCleanCopy = false;
        if (targetExists) {
          // Version-based update: if bundled has a version and it's newer, force update
          const bundledVer = this.getSkillVersion(dir);
          if (bundledVer && compareVersions(bundledVer, this.getSkillVersion(targetDir) || '0.0.0') > 0) {
            shouldRepair = true;
            needsCleanCopy = true;
          }
          // web-search has specific broken checks
          else if (id === 'web-search' && isWebSearchSkillBroken(targetDir)) {
            shouldRepair = true;
          }
          // Generic check: if bundled has node_modules but target doesn't, repair it
          else if (!this.isSkillRuntimeHealthy(targetDir, dir)) {
            shouldRepair = true;
          }
        }

        if (targetExists && !shouldRepair) return;
        try {
          console.log(`[skills] syncBundledSkillsToUserData: copying "${id}" from ${dir} to ${targetDir}`);

          // Preserve .env file before clean copy
          let envBackup: Buffer | null = null;
          const envPath = path.join(targetDir, '.env');
          if (needsCleanCopy && fs.existsSync(envPath)) {
            envBackup = fs.readFileSync(envPath);
          }

          // Version-based update: delete target dir first to remove stale files
          // (e.g. old .py scripts, __pycache__, leftover package-lock.json)
          if (needsCleanCopy) {
            fs.rmSync(targetDir, { recursive: true, force: true });
          }

          cpRecursiveSync(dir, targetDir, {
            dereference: true,
            force: shouldRepair,
          });

          // Restore .env file after clean copy
          if (envBackup !== null) {
            fs.writeFileSync(envPath, envBackup);
          }

          console.log(`[skills] syncBundledSkillsToUserData: copied "${id}" successfully`);
          if (shouldRepair) {
            console.log(`[skills] Repaired bundled skill "${id}" in user data`);
          }
        } catch (error) {
          console.warn(`[skills] Failed to sync bundled skill "${id}":`, error);
        }
      });

      const bundledConfig = path.join(bundledRoot, SKILLS_CONFIG_FILE);
      const targetConfig = path.join(userRoot, SKILLS_CONFIG_FILE);
      if (fs.existsSync(bundledConfig)) {
        if (!fs.existsSync(targetConfig)) {
          console.log('[skills] syncBundledSkillsToUserData: copying skills.config.json');
          cpRecursiveSync(bundledConfig, targetConfig);
        } else {
          this.mergeSkillsConfig(bundledConfig, targetConfig);
        }
      }
      console.log('[skills] syncBundledSkillsToUserData: done');
    } catch (error) {
      console.warn('[skills] Failed to sync bundled skills:', error);
    }
  }

  /**
   * Check if a skill's runtime is healthy by comparing with bundled version.
   * Returns false if bundled has dependencies but target doesn't.
   */
  private isSkillRuntimeHealthy(targetDir: string, bundledDir: string): boolean {
    const bundledNodeModules = path.join(bundledDir, 'node_modules');
    const targetNodeModules = path.join(targetDir, 'node_modules');
    const targetPackageJson = path.join(targetDir, 'package.json');

    // If target has no package.json, it's a simple skill (no deps needed)
    if (!fs.existsSync(targetPackageJson)) {
      return true;
    }

    // If bundled doesn't have node_modules, no deps to sync
    if (!fs.existsSync(bundledNodeModules)) {
      return true;
    }

    // If bundled has node_modules but target doesn't, needs repair
    if (!fs.existsSync(targetNodeModules)) {
      return false;
    }

    return true;
  }

  private getSkillVersion(skillDir: string): string {
    try {
      const raw = fs.readFileSync(path.join(skillDir, SKILL_FILE_NAME), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const meta = frontmatter.metadata as Record<string, unknown> | undefined;
      const v = frontmatter.version ?? meta?.version;
      return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    } catch {
      return '';
    }
  }

  private mergeSkillsConfig(bundledPath: string, targetPath: string): void {
    try {
      const bundled = JSON.parse(fs.readFileSync(bundledPath, 'utf-8'));
      const target = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      if (!bundled.defaults || !target.defaults) return;
      let changed = false;
      for (const [id, config] of Object.entries(bundled.defaults)) {
        if (!(id in target.defaults)) {
          target.defaults[id] = config;
          changed = true;
        }
      }
      if (changed) {
        // Write to temp file first, then rename for atomic update
        const tmpPath = targetPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(target, null, 2) + '\n', 'utf-8');
        fs.renameSync(tmpPath, targetPath);
        console.log('[skills] mergeSkillsConfig: merged new skill entries into user config');
      }
    } catch (e) {
      console.warn('[skills] Failed to merge skills config:', e);
    }
  }

  listSkills(): SkillRecord[] {
    const primaryRoot = this.ensureSkillsRoot();
    const state = this.loadSkillStateMap();
    const roots = this.getSkillRoots(primaryRoot);
    const orderedRoots = roots.filter(root => root !== primaryRoot).concat(primaryRoot);
    const defaults = this.loadSkillsDefaults(roots);
    const builtInSkillIds = this.listBuiltInSkillIds();
    const skillMap = new Map<string, SkillRecord>();

    orderedRoots.forEach(root => {
      if (!fs.existsSync(root)) return;
      const skillDirs = listSkillDirs(root);
      skillDirs.forEach(dir => {
        const skill = this.parseSkillDir(dir, state, defaults, builtInSkillIds.has(path.basename(dir)));
        if (!skill) return;
        skillMap.set(skill.id, skill);
      });
    });

    const skills = Array.from(skillMap.values());

    skills.sort((a, b) => {
      const orderA = defaults[a.id]?.order ?? 999;
      const orderB = defaults[b.id]?.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    return skills;
  }

  buildAutoRoutingPrompt(): string | null {
    const skills = this.listSkills();
    const enabled = skills.filter(s => s.enabled && s.prompt);
    if (enabled.length === 0) return null;

    const skillEntries = enabled
      .map(s => `  <skill><id>${s.id}</id><name>${s.name}</name><description>${s.description}</description><location>${s.skillPath}</location></skill>`)
      .join('\n');

    return [
      '## Skills (mandatory)',
      'Before replying: scan <available_skills> <description> entries.',
      '- If exactly one skill clearly applies: read its SKILL.md at <location> with the Read tool, then follow it.',
      '- If multiple could apply: choose the most specific one, then read/follow it.',
      '- If none clearly apply: do not read any SKILL.md.',
      '- IMPORTANT: If a description contains "Do NOT use" constraints, strictly respect them. If the user\'s request falls into a "Do NOT" category, treat that skill as non-matching — do NOT read its SKILL.md.',
      '- For the selected skill, treat <location> as the canonical SKILL.md path.',
      '- Resolve relative paths mentioned by that SKILL.md against its directory (dirname(<location>)), not the workspace root.',
      'Constraints: never read more than one skill up front; only read additional skills if the first one explicitly references them.',
      '',
      '<available_skills>',
      skillEntries,
      '</available_skills>',
    ].join('\n');
  }

  setSkillEnabled(id: string, enabled: boolean): SkillRecord[] {
    const state = this.loadSkillStateMap();
    state[id] = { enabled };
    this.saveSkillStateMap(state);
    this.notifySkillsChanged();
    return this.listSkills();
  }

  deleteSkill(id: string): SkillRecord[] {
    const root = this.ensureSkillsRoot();
    if (id !== path.basename(id)) {
      throw new Error('Invalid skill id');
    }
    if (this.isBuiltInSkillId(id)) {
      throw new Error('Built-in skills cannot be deleted');
    }

    const targetDir = resolveWithin(root, id);
    if (!fs.existsSync(targetDir)) {
      throw new Error('Skill not found');
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    const state = this.loadSkillStateMap();
    delete state[id];
    this.saveSkillStateMap(state);
    this.startWatching();
    this.notifySkillsChanged();
    return this.listSkills();
  }

  async downloadSkill(source: string): Promise<{
    success: boolean;
    skills?: SkillRecord[];
    error?: string;
    auditReport?: SkillSecurityReport;
    pendingInstallId?: string;
  }> {
    let cleanupPath: string | null = null;
    try {
      const trimmed = source.trim();
      if (!trimmed) {
        return { success: false, error: 'Missing skill source' };
      }

      console.log(`[SkillManager] downloadSkill: source="${trimmed}"`);
      const root = this.ensureSkillsRoot();
      let localSource = trimmed;
      if (fs.existsSync(localSource)) {
        const stat = fs.statSync(localSource);
        if (stat.isFile()) {
          if (isZipFile(localSource)) {
            console.log('[SkillManager] downloadSkill: detected local zip file');
            const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lobsterai-skill-zip-'));
            await extractZip(localSource, { dir: tempRoot });
            localSource = tempRoot;
            cleanupPath = tempRoot;
          } else if (path.basename(localSource) === SKILL_FILE_NAME) {
            console.log('[SkillManager] downloadSkill: detected local SKILL.md file');
            localSource = path.dirname(localSource);
          } else {
            return { success: false, error: 'Skill source must be a directory, zip file, or SKILL.md file' };
          }
        } else {
          console.log('[SkillManager] downloadSkill: detected local directory');
        }
      } else if (isRemoteZipUrl(trimmed)) {
        console.log('[SkillManager] downloadSkill: detected remote zip URL');
        const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lobsterai-skill-zip-'));
        cleanupPath = tempRoot;
        localSource = await downloadZipUrl(trimmed, tempRoot);
      } else if (isNpmPackageSpec(trimmed)) {
        console.log(`[SkillManager] downloadSkill: detected npm package spec "${trimmed}"`);
        const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lobsterai-skill-npm-'));
        cleanupPath = tempRoot;
        localSource = await downloadNpmPackage(trimmed, tempRoot);
        console.log(`[SkillManager] downloadSkill: npm package extracted to ${localSource}`);
      } else {
        const normalized = this.normalizeGitSource(trimmed);
        if (!normalized) {
          return { success: false, error: 'Invalid skill source. Use owner/repo, repo URL, npm package spec, or a GitHub tree/blob URL.' };
        }
        const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lobsterai-skill-'));
        cleanupPath = tempRoot;
        const repoName = normalizeFolderName(normalized.repoNameHint || deriveRepoName(normalized.repoUrl));
        const clonePath = path.join(tempRoot, repoName);
        const githubSource = parseGithubRepoSource(normalized.repoUrl);
        let downloadedSourceRoot = clonePath;

        // Prefer HTTP zip download for GitHub repos (no git dependency required).
        // Fall back to git clone only for non-GitHub sources or if download fails.
        let downloaded = false;
        if (githubSource) {
          console.log(`[SkillManager] downloadSkill: trying GitHub HTTP zip download for ${githubSource.owner}/${githubSource.repo}`);
          try {
            downloadedSourceRoot = await downloadGithubArchive(githubSource, tempRoot, normalized.ref);
            downloaded = true;
            console.log(`[SkillManager] downloadSkill: GitHub HTTP download succeeded → ${downloadedSourceRoot}`);
          } catch (err) {
            console.log(`[SkillManager] downloadSkill: GitHub HTTP download failed: ${err instanceof Error ? err.message : err}, falling back to git clone`);
          }
        }

        if (!downloaded) {
          console.log(`[SkillManager] downloadSkill: using git clone for ${normalized.repoUrl}`);
          const cloneArgs = ['clone', '--depth', '1'];
          if (normalized.ref) {
            cloneArgs.push('--branch', normalized.ref);
          }
          cloneArgs.push(normalized.repoUrl, clonePath);
          const gitRuntime = resolveGitCommand();
          try {
            await runCommand(gitRuntime.command, cloneArgs, { env: gitRuntime.env });
          } catch (error) {
            const errno = (error as NodeJS.ErrnoException | null)?.code;
            if (errno === 'ENOENT' && process.platform === 'win32') {
              throw new Error(
                'Failed to download skill. Git is not installed.'
                + ' Please install Git for Windows, or use a GitHub URL (HTTP download).'
              );
            }
            throw error;
          }
        }

        if (normalized.sourceSubpath) {
          const scopedSource = resolveWithin(downloadedSourceRoot, normalized.sourceSubpath);
          if (!fs.existsSync(scopedSource)) {
            return { success: false, error: `Path "${normalized.sourceSubpath}" not found in repository` };
          }
          const scopedStat = fs.statSync(scopedSource);
          if (scopedStat.isFile()) {
            if (path.basename(scopedSource) === SKILL_FILE_NAME) {
              localSource = path.dirname(scopedSource);
            } else {
              return { success: false, error: 'GitHub path must point to a directory or SKILL.md file' };
            }
          } else {
            localSource = scopedSource;
          }
        } else {
          localSource = downloadedSourceRoot;
        }

      }

      const skillDirs = collectSkillDirsFromSource(localSource);
      if (skillDirs.length === 0) {
        cleanupPathSafely(cleanupPath);
        cleanupPath = null;
        return { success: false, error: t('skillErrNoSkillMd') };
      }

      // Security scan before installation
      let auditReport: SkillSecurityReport | null = null;
      try {
        console.log(`[SkillManager] Starting security scan for ${skillDirs.length} skill dir(s)...`);
        const reports = await scanMultipleSkillDirs(skillDirs);
        auditReport = mergeReports(reports);
        if (auditReport) {
          console.log(`[SkillManager] Security scan complete: riskLevel=${auditReport.riskLevel}, score=${auditReport.riskScore}, findings=${auditReport.findings.length}, duration=${auditReport.scanDurationMs}ms`);
          for (const f of auditReport.findings) {
            console.log(`[SkillManager]   [${f.severity}] ${f.dimension} | ${f.ruleId} → ${f.file}${f.line ? ':' + f.line : ''}`);
          }
        }
      } catch (err) {
        console.warn('[SkillManager] Security scan failed (non-blocking):', err);
      }

      // If risk detected, cache for user confirmation instead of auto-installing
      if (auditReport && auditReport.riskLevel !== 'safe') {
        const pendingId = crypto.randomUUID();
        console.log(`[SkillManager] Risk detected (${auditReport.riskLevel}), pending user confirmation: ${pendingId}`);
        const timer = setTimeout(() => {
          const pending = this.pendingInstalls.get(pendingId);
          if (pending) {
            cleanupPathSafely(pending.cleanupPath);
            this.pendingInstalls.delete(pendingId);
            console.log(`[SkillManager] Pending install ${pendingId} expired (TTL)`);
          }
        }, 5 * 60 * 1000);

        this.pendingInstalls.set(pendingId, {
          tempDir: localSource,
          cleanupPath,
          root,
          skillDirs,
          timer,
        });

        return {
          success: true,
          auditReport,
          pendingInstallId: pendingId,
        };
      }

      // Safe or scan failed — install directly
      console.log(`[SkillManager] Skill is safe (or scan failed), installing directly`);
      for (const skillDir of skillDirs) {
        const folderName = normalizeFolderName(path.basename(skillDir));
        let targetDir = resolveWithin(root, folderName);
        let suffix = 1;
        while (fs.existsSync(targetDir)) {
          targetDir = resolveWithin(root, `${folderName}-${suffix}`);
          suffix += 1;
        }
        cpRecursiveSync(skillDir, targetDir);
      }

      cleanupPathSafely(cleanupPath);
      cleanupPath = null;

      this.startWatching();
      this.notifySkillsChanged();
      return { success: true, skills: this.listSkills() };
    } catch (error) {
      cleanupPathSafely(cleanupPath);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to download skill' };
    }
  }

  async upgradeSkill(skillId: string, downloadUrl: string): Promise<{
    success: boolean;
    skills?: SkillRecord[];
    error?: string;
    auditReport?: SkillSecurityReport;
    pendingInstallId?: string;
  }> {
    // Prevent concurrent upgrades of the same skill
    if (this.upgradingSkillIds.has(skillId)) {
      return { success: false, error: `Skill "${skillId}" is already being upgraded` };
    }

    // Find the installed skill
    const installedSkills = this.listSkills();
    const installed = installedSkills.find(s => s.id === skillId);
    if (!installed) {
      return { success: false, error: `Skill "${skillId}" is not installed` };
    }

    const existingSkillDir = path.dirname(installed.skillPath);
    if (!fs.existsSync(existingSkillDir)) {
      return { success: false, error: `Skill directory not found: ${existingSkillDir}` };
    }

    this.upgradingSkillIds.add(skillId);
    try {
      return await this.performUpgradeDownload(skillId, downloadUrl, existingSkillDir);
    } finally {
      this.upgradingSkillIds.delete(skillId);
    }
  }

  private async performUpgradeDownload(skillId: string, downloadUrl: string, existingSkillDir: string): Promise<{
    success: boolean;
    skills?: SkillRecord[];
    error?: string;
    auditReport?: SkillSecurityReport;
    pendingInstallId?: string;
  }> {    let cleanupPath: string | null = null;
    try {
      console.log(`[SkillManager] starting upgrade for skill "${skillId}"`);
      const root = this.ensureSkillsRoot();

      // Download new version (reuse downloadSkill's download logic)
      const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lobsterai-skill-upgrade-'));
      cleanupPath = tempRoot;

      let localSource: string;
      if (isRemoteZipUrl(downloadUrl)) {
        localSource = await downloadZipUrl(downloadUrl, tempRoot);
      } else {
        const normalized = this.normalizeGitSource(downloadUrl);
        if (!normalized) {
          cleanupPathSafely(cleanupPath);
          return { success: false, error: 'Invalid download URL' };
        }
        const repoName = normalizeFolderName(normalized.repoNameHint || deriveRepoName(normalized.repoUrl));
        const clonePath = path.join(tempRoot, repoName);
        const githubSource = parseGithubRepoSource(normalized.repoUrl);
        let downloadedSourceRoot = clonePath;
        let downloaded = false;

        if (githubSource) {
          try {
            downloadedSourceRoot = await downloadGithubArchive(githubSource, tempRoot, normalized.ref);
            downloaded = true;
          } catch {
            // Fall through to git clone
          }
        }

        if (!downloaded) {
          const cloneArgs = ['clone', '--depth', '1'];
          if (normalized.ref) cloneArgs.push('--branch', normalized.ref);
          cloneArgs.push(normalized.repoUrl, clonePath);
          const gitRuntime = resolveGitCommand();
          await runCommand(gitRuntime.command, cloneArgs, { env: gitRuntime.env });
        }

        if (normalized.sourceSubpath) {
          const scopedSource = resolveWithin(downloadedSourceRoot, normalized.sourceSubpath);
          if (!fs.existsSync(scopedSource)) {
            cleanupPathSafely(cleanupPath);
            return { success: false, error: `Path "${normalized.sourceSubpath}" not found` };
          }
          localSource = fs.statSync(scopedSource).isFile() && path.basename(scopedSource) === SKILL_FILE_NAME
            ? path.dirname(scopedSource)
            : scopedSource;
        } else {
          localSource = downloadedSourceRoot;
        }
      }

      const skillDirs = collectSkillDirsFromSource(localSource);
      if (skillDirs.length === 0) {
        cleanupPathSafely(cleanupPath);
        return { success: false, error: t('skillErrNoSkillMd') };
      }

      // Find the matching skill dir for this ID
      const matchingSkillDir = skillDirs.find(d => normalizeFolderName(path.basename(d)) === skillId) || skillDirs[0];

      // Security scan
      let auditReport: SkillSecurityReport | null = null;
      try {
        const reports = await scanMultipleSkillDirs([matchingSkillDir]);
        auditReport = mergeReports(reports);
      } catch (err) {
        console.warn('[SkillManager] Security scan failed (non-blocking):', err);
      }

      // If risk detected, cache for user confirmation
      if (auditReport && auditReport.riskLevel !== 'safe') {
        const pendingId = crypto.randomUUID();
        console.log(`[SkillManager] Upgrade risk detected (${auditReport.riskLevel}), pending confirmation: ${pendingId}`);
        const timer = setTimeout(() => {
          const pending = this.pendingInstalls.get(pendingId);
          if (pending) {
            cleanupPathSafely(pending.cleanupPath);
            this.pendingInstalls.delete(pendingId);
          }
        }, 5 * 60 * 1000);

        this.pendingInstalls.set(pendingId, {
          tempDir: localSource,
          cleanupPath,
          root,
          skillDirs: [matchingSkillDir],
          timer,
          isUpgrade: true,
          existingSkillDir,
        });

        // Ownership of cleanupPath transferred to pendingInstalls
        cleanupPath = null;
        return { success: true, auditReport, pendingInstallId: pendingId };
      }

      // Safe — perform upgrade
      this.performSkillUpgrade(matchingSkillDir, existingSkillDir);

      cleanupPathSafely(cleanupPath);
      cleanupPath = null;

      this.startWatching();
      this.notifySkillsChanged();
      return { success: true, skills: this.listSkills() };
    } catch (error) {
      cleanupPathSafely(cleanupPath);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to upgrade skill' };
    }
  }

  private performSkillUpgrade(newSkillDir: string, existingSkillDir: string): void {
    const upgradingDir = existingSkillDir + '.upgrading';

    // Back up .env and _meta.json
    let envBackup: Buffer | null = null;
    let metaBackup: Buffer | null = null;
    const envPath = path.join(existingSkillDir, '.env');
    const metaPath = path.join(existingSkillDir, '_meta.json');
    if (fs.existsSync(envPath)) {
      envBackup = fs.readFileSync(envPath);
    }
    if (fs.existsSync(metaPath)) {
      metaBackup = fs.readFileSync(metaPath);
    }

    // Atomic rename old dir to .upgrading backup
    fs.renameSync(existingSkillDir, upgradingDir);

    try {
      // Copy new version to original path
      cpRecursiveSync(newSkillDir, existingSkillDir);

      // Restore .env and _meta.json
      if (envBackup !== null) {
        fs.writeFileSync(path.join(existingSkillDir, '.env'), envBackup);
      }
      if (metaBackup !== null) {
        fs.writeFileSync(path.join(existingSkillDir, '_meta.json'), metaBackup);
      }
    } catch (error) {
      // Roll back: remove partial new dir and restore backup
      console.error('[SkillManager] upgrade copy failed, rolling back:', error);
      if (fs.existsSync(existingSkillDir)) {
        fs.rmSync(existingSkillDir, { recursive: true, force: true });
      }
      fs.renameSync(upgradingDir, existingSkillDir);
      throw error;
    }

    // Remove backup
    fs.rmSync(upgradingDir, { recursive: true, force: true });
  }

  confirmPendingInstall(
    pendingId: string,
    action: SecurityReportAction
  ): { success: boolean; skills?: SkillRecord[]; error?: string } {
    console.log(`[SkillManager] confirmPendingInstall: id=${pendingId}, action=${action}`);
    const pending = this.pendingInstalls.get(pendingId);
    if (!pending) {
      console.warn(`[SkillManager] Pending install not found: ${pendingId}`);
      return { success: false, error: 'No pending install found' };
    }

    clearTimeout(pending.timer);
    this.pendingInstalls.delete(pendingId);

    if (action === 'cancel') {
      cleanupPathSafely(pending.cleanupPath);
      return { success: true };
    }

    // Install the skill(s)
    const installedIds: string[] = [];

    // Upgrade path: overwrite existing skill directory
    if (pending.isUpgrade && pending.existingSkillDir) {
      for (const skillDir of pending.skillDirs) {
        this.performSkillUpgrade(skillDir, pending.existingSkillDir);
        installedIds.push(path.basename(pending.existingSkillDir));
      }
    } else {
      // Fresh install path: find unique directory name
      for (const skillDir of pending.skillDirs) {
        const folderName = normalizeFolderName(path.basename(skillDir));
        let targetDir = resolveWithin(pending.root, folderName);
        let suffix = 1;
        while (fs.existsSync(targetDir)) {
          targetDir = resolveWithin(pending.root, `${folderName}-${suffix}`);
          suffix += 1;
        }
        cpRecursiveSync(skillDir, targetDir);
        installedIds.push(path.basename(targetDir));
      }
    }

    cleanupPathSafely(pending.cleanupPath);

    // If user chose 'installDisabled', disable all newly installed skills
    if (action === 'installDisabled') {
      for (const id of installedIds) {
        try {
          this.setSkillEnabled(id, false);
        } catch {
          // Non-critical
        }
      }
    }

    this.startWatching();
    this.notifySkillsChanged();
    return { success: true, skills: this.listSkills() };
  }

  startWatching(): void {
    this.stopWatching();
    const primaryRoot = this.ensureSkillsRoot();
    const roots = this.getSkillRoots(primaryRoot);

    const watchHandler = () => this.scheduleNotify();
    roots.forEach(root => {
      if (!fs.existsSync(root)) return;
      try {
        this.watchers.push(fs.watch(root, watchHandler));
      } catch (error) {
        console.warn('[skills] Failed to watch skills root:', root, error);
      }

      const skillDirs = listSkillDirs(root);
      skillDirs.forEach(dir => {
        try {
          this.watchers.push(fs.watch(dir, watchHandler));
        } catch (error) {
          console.warn('[skills] Failed to watch skill directory:', dir, error);
        }
      });
    });
  }

  stopWatching(): void {
    this.watchers.forEach(watcher => watcher.close());
    this.watchers = [];
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  handleWorkingDirectoryChange(): void {
    this.startWatching();
    this.notifySkillsChanged();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.startWatching();
      this.notifySkillsChanged();
    }, WATCH_DEBOUNCE_MS);
  }

  private notifySkillsChanged(): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('skills:changed');
      }
    });
    // Notify external listeners (e.g. OpenClaw AGENTS.md sync)
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[skills] onSkillsChanged listener error:', error);
      }
    }
  }

  onSkillsChanged(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter(l => l !== listener);
    };
  }

  private parseSkillDir(
    dir: string,
    state: SkillStateMap,
    defaults: Record<string, SkillDefaultConfig>,
    isBuiltIn: boolean
  ): SkillRecord | null {
    const skillFile = path.join(dir, SKILL_FILE_NAME);
    if (!fs.existsSync(skillFile)) return null;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const { frontmatter, content } = parseFrontmatter(raw);
      const name = (String(frontmatter.name || '') || path.basename(dir)).trim() || path.basename(dir);
      const description = (String(frontmatter.description || '') || extractDescription(content) || name).trim();
      const isOfficial = isTruthy(frontmatter.official) || isTruthy(frontmatter.isOfficial);
      const meta = frontmatter.metadata as Record<string, unknown> | undefined;
      const v = frontmatter.version ?? meta?.version;
      const version = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
      const updatedAt = fs.statSync(skillFile).mtimeMs;
      const id = path.basename(dir);
      const prompt = content.trim();
      const defaultEnabled = defaults[id]?.enabled ?? true;
      const enabled = state[id]?.enabled ?? defaultEnabled;
      return { id, name, description, enabled, isOfficial, isBuiltIn, updatedAt, prompt, skillPath: skillFile, version };
    } catch (error) {
      console.warn('[skills] Failed to parse skill:', dir, error);
      return null;
    }
  }

  private listBuiltInSkillIds(): Set<string> {
    const builtInRoot = this.getBundledSkillsRoot();
    if (!builtInRoot || !fs.existsSync(builtInRoot)) {
      return new Set();
    }
    return new Set(listSkillDirs(builtInRoot).map(dir => path.basename(dir)));
  }

  private isBuiltInSkillId(id: string): boolean {
    return this.listBuiltInSkillIds().has(id);
  }

  private loadSkillStateMap(): SkillStateMap {
    const store = this.getStore();
    const raw = store.get(SKILL_STATE_KEY) as SkillStateMap | SkillRecord[] | undefined;
    if (Array.isArray(raw)) {
      const migrated: SkillStateMap = {};
      raw.forEach(skill => {
        migrated[skill.id] = { enabled: skill.enabled };
      });
      store.set(SKILL_STATE_KEY, migrated);
      return migrated;
    }
    return raw ?? {};
  }

  private saveSkillStateMap(map: SkillStateMap): void {
    this.getStore().set(SKILL_STATE_KEY, map);
  }

  private loadSkillsDefaults(roots: string[]): Record<string, SkillDefaultConfig> {
    const merged: Record<string, SkillDefaultConfig> = {};

    // Load from roots in reverse order so higher priority roots override lower ones
    // roots[0] is user directory (highest priority), roots[1] is app-bundled (lower priority)
    const reversedRoots = [...roots].reverse();

    for (const root of reversedRoots) {
      const configPath = path.join(root, SKILLS_CONFIG_FILE);
      if (!fs.existsSync(configPath)) continue;

      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw) as SkillsConfig;
        if (config.defaults && typeof config.defaults === 'object') {
          for (const [id, settings] of Object.entries(config.defaults)) {
            merged[id] = { ...merged[id], ...settings };
          }
        }
      } catch (error) {
        console.warn('[skills] Failed to load skills config:', configPath, error);
      }
    }

    return merged;
  }

  private getSkillRoots(primaryRoot?: string): string[] {
    const resolvedPrimary = primaryRoot ?? this.getSkillsRoot();
    const roots: string[] = [resolvedPrimary];

    const claudeSkillsRoot = this.getClaudeSkillsRoot();
    if (claudeSkillsRoot && fs.existsSync(claudeSkillsRoot)) {
      roots.push(claudeSkillsRoot);
    }

    const appRoot = this.getBundledSkillsRoot();
    if (appRoot !== resolvedPrimary && fs.existsSync(appRoot)) {
      roots.push(appRoot);
    }
    return roots;
  }

  private getClaudeSkillsRoot(): string | null {
    const homeDir = app.getPath('home');
    return path.join(homeDir, CLAUDE_SKILLS_DIR_NAME, CLAUDE_SKILLS_SUBDIR);
  }

  private getBundledSkillsRoot(): string {
    if (app.isPackaged) {
      // In production, bundled SKILLs should be in Resources/SKILLs.
      const resourcesRoot = path.resolve(process.resourcesPath, SKILLS_DIR_NAME);
      if (fs.existsSync(resourcesRoot)) {
        return resourcesRoot;
      }

      // Fallback for older packages where SKILLs are inside app.asar.
      return path.resolve(app.getAppPath(), SKILLS_DIR_NAME);
    }

    // In development, use the project root (parent of dist-electron).
    // __dirname is dist-electron/, so we need to go up one level to get to project root
    const projectRoot = path.resolve(__dirname, '..');
    return path.resolve(projectRoot, SKILLS_DIR_NAME);
  }

  getSkillConfig(skillId: string): { success: boolean; config?: Record<string, string>; error?: string } {
    try {
      const skillDir = this.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      if (!fs.existsSync(envPath)) {
        return { success: true, config: {} };
      }
      const raw = fs.readFileSync(envPath, 'utf8');
      const config: Record<string, string> = {};
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes added by setSkillConfig / manual edits.
        // Double-quoted values may contain escape sequences (\", \\) that need reversal.
        // Single-quoted values are taken literally (no escape processing), matching dotenv behavior.
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        config[key] = value;
      }
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read skill config' };
    }
  }

  setSkillConfig(skillId: string, config: Record<string, string>): { success: boolean; error?: string } {
    try {
      const skillDir = this.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      const lines = Object.entries(config)
        .filter(([key]) => key.trim())
        .map(([key, value]) => {
          // Wrap value in double quotes if it contains characters that dotenv
          // would misinterpret (e.g. # treated as inline comment, or spaces)
          if (value.includes('#') || value.includes(' ') || value.includes('"') || value.includes("'")) {
            // Escape any existing double quotes inside the value
            const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `${key}="${escaped}"`;
          }
          return `${key}=${value}`;
        });
      fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write skill config' };
    }
  }

  private repairSkillFromBundled(skillId: string, skillPath: string): boolean {
    if (!app.isPackaged) return false;

    const bundledRoot = this.getBundledSkillsRoot();
    if (!bundledRoot || !fs.existsSync(bundledRoot)) {
      return false;
    }

    const bundledPath = path.join(bundledRoot, skillId);
    if (!fs.existsSync(bundledPath) || bundledPath === skillPath) {
      return false;
    }

    // Check if bundled version has node_modules
    const bundledNodeModules = path.join(bundledPath, 'node_modules');
    if (!fs.existsSync(bundledNodeModules)) {
      console.log(`[skills] Bundled ${skillId} does not have node_modules, skipping repair`);
      return false;
    }

    try {
      console.log(`[skills] Repairing ${skillId} from bundled resources...`);
      fs.cpSync(bundledPath, skillPath, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
      });
      console.log(`[skills] Repaired ${skillId} from bundled resources`);
      return true;
    } catch (error) {
      console.warn(`[skills] Failed to repair ${skillId} from bundled resources:`, error);
      return false;
    }
  }

  private ensureSkillDependencies(skillDir: string): { success: boolean; error?: string } {
    const nodeModulesPath = path.join(skillDir, 'node_modules');
    const packageJsonPath = path.join(skillDir, 'package.json');
    const skillId = path.basename(skillDir);

    console.log(`[skills] Checking dependencies for ${skillId}...`);
    console.log(`[skills]   node_modules exists: ${fs.existsSync(nodeModulesPath)}`);
    console.log(`[skills]   package.json exists: ${fs.existsSync(packageJsonPath)}`);
    console.log(`[skills]   skillDir: ${skillDir}`);

    // If node_modules exists, assume dependencies are installed
    if (fs.existsSync(nodeModulesPath)) {
      console.log(`[skills] Dependencies already installed for ${skillId}`);
      return { success: true };
    }

    // If no package.json, nothing to install
    if (!fs.existsSync(packageJsonPath)) {
      console.log(`[skills] No package.json found for ${skillId}, skipping install`);
      return { success: true };
    }

    // Try to repair from bundled resources first (works without npm)
    if (this.repairSkillFromBundled(skillId, skillDir)) {
      if (fs.existsSync(nodeModulesPath)) {
        console.log(`[skills] Dependencies restored from bundled resources for ${skillId}`);
        return { success: true };
      }
    }

    // Build environment with user's shell PATH (crucial for packaged apps)
    const env = buildSkillEnv() as NodeJS.ProcessEnv;
    const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
    console.log(`[skills]   PATH keys in env: ${JSON.stringify(pathKeys)}`);
    console.log(`[skills]   PATH (first 300 chars): ${env.PATH?.substring(0, 300)}`);

    // Check if npm is available
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (!hasCommand(npmCommand, env) && !hasCommand('npm', env)) {
      const errorMsg = 'npm is not available and skill cannot be repaired from bundled resources. Please install Node.js from https://nodejs.org/';
      console.error(`[skills] ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    console.log(`[skills] npm is available`);

    // Try to install dependencies
    console.log(`[skills] Installing dependencies for ${skillId}...`);
    console.log(`[skills]   Working directory: ${skillDir}`);

    try {
      // On Windows, use shell: true so cmd.exe resolves npm.cmd correctly
      const isWin = process.platform === 'win32';
      const result = spawnSync('npm', ['install'], {
        cwd: skillDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 120000, // 2 minute timeout
        env,
        shell: isWin,
      });

      console.log(`[skills] npm install exit code: ${result.status}`);
      if (result.stdout) {
        console.log(`[skills] npm install stdout: ${result.stdout.substring(0, 500)}`);
      }
      if (result.stderr) {
        console.log(`[skills] npm install stderr: ${result.stderr.substring(0, 500)}`);
      }

      if (result.status !== 0) {
        const errorMsg = result.stderr || result.stdout || 'npm install failed';
        console.error(`[skills] Failed to install dependencies for ${skillId}:`, errorMsg);
        return { success: false, error: `Failed to install dependencies: ${errorMsg}` };
      }

      // Verify node_modules was created
      if (!fs.existsSync(nodeModulesPath)) {
        const errorMsg = 'npm install appeared to succeed but node_modules was not created';
        console.error(`[skills] ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      console.log(`[skills] Dependencies installed successfully for ${skillId}`);
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[skills] Error installing dependencies for ${skillId}:`, errorMsg);
      return { success: false, error: `Failed to install dependencies: ${errorMsg}` };
    }
  }

  async testEmailConnectivity(
    skillId: string,
    config: Record<string, string>
  ): Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }> {
    try {
      const skillDir = this.resolveSkillDir(skillId);

      // Ensure dependencies are installed before running scripts
      const depsResult = this.ensureSkillDependencies(skillDir);
      if (!depsResult.success) {
        console.error('[email-connectivity] Dependency install failed:', depsResult.error);
        return { success: false, error: depsResult.error };
      }

      const imapScript = path.join(skillDir, 'scripts', 'imap.js');
      const smtpScript = path.join(skillDir, 'scripts', 'smtp.js');
      if (!fs.existsSync(imapScript) || !fs.existsSync(smtpScript)) {
        console.error('[email-connectivity] Scripts not found:', { imapScript, smtpScript });
        return { success: false, error: 'Email connectivity scripts not found' };
      }

      // Mask password for logging
      const safeConfig = { ...config };
      if (safeConfig.IMAP_PASS) safeConfig.IMAP_PASS = '***';
      if (safeConfig.SMTP_PASS) safeConfig.SMTP_PASS = '***';
      console.log('[email-connectivity] Testing with config:', JSON.stringify(safeConfig, null, 2));

      const envOverrides = Object.fromEntries(
        Object.entries(config ?? {})
          .filter(([key]) => key.trim())
          .map(([key, value]) => [key, String(value ?? '')])
      );

      console.log('[email-connectivity] Running IMAP test (list-mailboxes)...');
      const imapResult = await this.runSkillScriptWithEnv(
        skillDir,
        imapScript,
        ['list-mailboxes'],
        envOverrides,
        20000
      );
      console.log('[email-connectivity] IMAP result:', JSON.stringify({
        success: imapResult.success,
        exitCode: imapResult.exitCode,
        timedOut: imapResult.timedOut,
        durationMs: imapResult.durationMs,
        stdout: imapResult.stdout?.slice(0, 500),
        stderr: imapResult.stderr?.slice(0, 500),
        error: imapResult.error,
        spawnErrorCode: imapResult.spawnErrorCode,
      }, null, 2));

      console.log('[email-connectivity] Running SMTP test (verify)...');
      const smtpResult = await this.runSkillScriptWithEnv(
        skillDir,
        smtpScript,
        ['verify'],
        envOverrides,
        20000
      );
      console.log('[email-connectivity] SMTP result:', JSON.stringify({
        success: smtpResult.success,
        exitCode: smtpResult.exitCode,
        timedOut: smtpResult.timedOut,
        durationMs: smtpResult.durationMs,
        stdout: smtpResult.stdout?.slice(0, 500),
        stderr: smtpResult.stderr?.slice(0, 500),
        error: smtpResult.error,
        spawnErrorCode: smtpResult.spawnErrorCode,
      }, null, 2));

      const checks: EmailConnectivityCheck[] = [
        this.buildEmailConnectivityCheck('imap_connection', imapResult),
        this.buildEmailConnectivityCheck('smtp_connection', smtpResult),
      ];
      const verdict: EmailConnectivityVerdict = checks.every(check => check.level === 'pass') ? 'pass' : 'fail';

      console.log('[email-connectivity] Final verdict:', verdict, 'checks:', JSON.stringify(checks, null, 2));

      return {
        success: true,
        result: {
          testedAt: Date.now(),
          verdict,
          checks,
        },
      };
    } catch (error) {
      console.error('[email-connectivity] Unexpected error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test email connectivity',
      };
    }
  }

  private resolveSkillDir(skillId: string): string {
    const skills = this.listSkills();
    const skill = skills.find(s => s.id === skillId);
    if (!skill) {
      throw new Error('Skill not found');
    }
    return path.dirname(skill.skillPath);
  }

  private getScriptRuntimeCandidates(env: NodeJS.ProcessEnv): Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> {
    const candidates: Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> = [];
    if (hasCommand('node', env)) {
      candidates.push({ command: 'node' });
    }
    candidates.push({
      command: getElectronNodeRuntimePath(),
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
    return candidates;
  }

  private async runSkillScriptWithEnv(
    skillDir: string,
    scriptPath: string,
    scriptArgs: string[],
    envOverrides: Record<string, string>,
    timeoutMs: number
  ): Promise<SkillScriptRunResult> {
    let lastResult: SkillScriptRunResult | null = null;

    // Build base environment with user's shell PATH
    const baseEnv = buildSkillEnv();

    for (const runtime of this.getScriptRuntimeCandidates(baseEnv as NodeJS.ProcessEnv)) {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...runtime.extraEnv,
        ...envOverrides,
      };
      const result = await runScriptWithTimeout({
        command: runtime.command,
        args: [scriptPath, ...scriptArgs],
        cwd: skillDir,
        env,
        timeoutMs,
      });
      lastResult = result;

      if (result.spawnErrorCode === 'ENOENT') {
        continue;
      }
      return result;
    }

    return lastResult ?? {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      error: 'Failed to run skill script',
    };
  }

  private parseScriptMessage(stdout: string): string | null {
    if (!stdout) {
      return null;
    }
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  private getLastOutputLine(text: string): string {
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(-1)[0] || '';
  }

  private buildEmailConnectivityCheck(
    code: EmailConnectivityCheckCode,
    result: SkillScriptRunResult
  ): EmailConnectivityCheck {
    const label = code === 'imap_connection' ? 'IMAP' : 'SMTP';

    if (result.success) {
      const parsedMessage = this.parseScriptMessage(result.stdout);
      return {
        code,
        level: 'pass',
        message: parsedMessage || `${label} connection successful`,
        durationMs: result.durationMs,
      };
    }

    const message = result.timedOut
      ? `${label} connectivity check timed out`
      : result.error
        || this.getLastOutputLine(result.stderr)
        || this.getLastOutputLine(result.stdout)
        || `${label} connection failed`;

    return {
      code,
      level: 'fail',
      message,
      durationMs: result.durationMs,
    };
  }

  private normalizeGitSource(source: string): NormalizedGitSource | null {
    const githubTreeOrBlob = parseGithubTreeOrBlobUrl(source);
    if (githubTreeOrBlob) {
      return githubTreeOrBlob;
    }

    if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
      return {
        repoUrl: `https://github.com/${source}.git`,
      };
    }
    if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@')) {
      return {
        repoUrl: source,
      };
    }
    if (source.endsWith('.git')) {
      return {
        repoUrl: source,
      };
    }
    return null;
  }
}

export const __skillManagerTestUtils = {
  parseFrontmatter,
  isTruthy,
  extractDescription,
};
