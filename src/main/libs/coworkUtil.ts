import { app } from 'electron';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadClaudeSdk } from './claudeSdk';
import { buildEnvForConfig, getClaudeCodePath, getCurrentApiConfig } from './claudeSettings';
import type { OpenAICompatProxyTarget } from './coworkOpenAICompatProxy';
import { getInternalApiBaseURL } from './coworkOpenAICompatProxy';
import { coworkLog } from './coworkLogger';
import { appendPythonRuntimeToEnv } from './pythonRuntime';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

function appendEnvPath(current: string | undefined, additions: string[]): string | undefined {
  const items = new Set<string>();

  for (const entry of additions) {
    if (entry) {
      items.add(entry);
    }
  }

  if (current) {
    for (const entry of current.split(delimiter)) {
      if (entry) {
        items.add(entry);
      }
    }
  }

  return items.size > 0 ? Array.from(items).join(delimiter) : current;
}

/**
 * Cached user shell PATH. Resolved once and reused across calls.
 */
let cachedUserShellPath: string | null | undefined;

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm and other tools won't be in PATH unless we resolve it.
 */
function resolveUserShellPath(): string | null {
  if (cachedUserShellPath !== undefined) return cachedUserShellPath;

  if (process.platform === 'win32') {
    cachedUserShellPath = null;
    return null;
  }

  try {
    const shell = process.env.SHELL || '/bin/bash';
    const result = execSync(`${shell} -ilc 'echo __PATH__=$PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
    });
    const match = result.match(/__PATH__=(.+)/);
    cachedUserShellPath = match ? match[1].trim() : null;
  } catch (error) {
    console.warn('[coworkUtil] Failed to resolve user shell PATH:', error);
    cachedUserShellPath = null;
  }

  return cachedUserShellPath;
}

/**
 * Cached Windows registry PATH. Resolved once and reused.
 */
let cachedWindowsRegistryPath: string | null | undefined;

/**
 * Resolve the latest PATH from the Windows registry (Machine + User).
 *
 * When a packaged Electron app is launched from the Start Menu, desktop shortcut,
 * or Explorer, its `process.env.PATH` is inherited from the Explorer shell process.
 * If the user installed tools (Python, Node.js, npm, etc.) after Explorer started
 * — or without restarting Explorer — those new PATH entries won't be in
 * `process.env.PATH`. This causes commands like `python`, `npm`, `pip` to be
 * missing from the cowork session even though they work fine in a freshly opened
 * terminal (which reads the latest registry values).
 *
 * This function reads the current Machine and User PATH directly from the registry
 * to get the most up-to-date values, similar to how `resolveUserShellPath()` works
 * for macOS/Linux.
 */
function resolveWindowsRegistryPath(): string | null {
  if (cachedWindowsRegistryPath !== undefined) return cachedWindowsRegistryPath;

  if (process.platform !== 'win32') {
    cachedWindowsRegistryPath = null;
    return null;
  }

  try {
    // Use PowerShell to read both Machine and User PATH from registry.
    // [Environment]::GetEnvironmentVariable reads directly from the registry,
    // not from the current process environment, so it always returns the latest values.
    //
    // Use -EncodedCommand with Base64 to avoid quote-escaping issues.
    // When Node.js calls execSync, outer double quotes for `-Command "..."` can
    // conflict with inner double quotes needed by PowerShell string arguments.
    // -EncodedCommand bypasses all quoting problems entirely.
    const psScript = [
      '$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")',
      '$userPath = [Environment]::GetEnvironmentVariable("Path", "User")',
      '[Console]::Write("$machinePath;$userPath")',
    ].join('; ');
    // PowerShell -EncodedCommand expects a Base64-encoded UTF-16LE string
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    const result = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encodedCommand}`, {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });

    const registryPath = result.trim();
    if (registryPath) {
      // Deduplicate and remove empty entries
      const entries = registryPath
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const unique = Array.from(new Set(entries));
      cachedWindowsRegistryPath = unique.join(';');
      coworkLog('INFO', 'resolveWindowsRegistryPath', `Resolved ${unique.length} PATH entries from Windows registry`);
    } else {
      cachedWindowsRegistryPath = null;
    }
  } catch (error) {
    coworkLog('WARN', 'resolveWindowsRegistryPath', `Failed to read PATH from Windows registry: ${error instanceof Error ? error.message : String(error)}`);
    cachedWindowsRegistryPath = null;
  }

  return cachedWindowsRegistryPath;
}

/**
 * Merge the current process PATH with registry-resolved PATH on Windows.
 *
 * This ensures that any PATH entries the user has added (e.g. Python, Node.js,
 * npm, pip) are available even if the Electron app inherited a stale PATH from
 * Explorer. The registry PATH entries are appended after the current entries
 * so that any overrides already in the env (like Git toolchain, shims) take priority.
 */
function ensureWindowsRegistryPathEntries(env: Record<string, string | undefined>): void {
  const registryPath = resolveWindowsRegistryPath();
  if (!registryPath) return;

  const currentPath = env.PATH || '';
  const currentEntriesLower = new Set(
    currentPath.split(delimiter).map((entry) => entry.toLowerCase().replace(/\\$/, ''))
  );

  const missingEntries: string[] = [];
  for (const entry of registryPath.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Normalize: remove trailing backslash for comparison
    const normalizedLower = trimmed.toLowerCase().replace(/\\$/, '');
    if (!currentEntriesLower.has(normalizedLower)) {
      missingEntries.push(trimmed);
      currentEntriesLower.add(normalizedLower); // prevent duplicates within registry entries
    }
  }

  if (missingEntries.length > 0) {
    // Append registry entries at the END so existing overrides (Git, shims) take priority
    env.PATH = currentPath ? `${currentPath}${delimiter}${missingEntries.join(delimiter)}` : missingEntries.join(delimiter);
    coworkLog('INFO', 'ensureWindowsRegistryPathEntries', `Appended ${missingEntries.length} missing PATH entries from Windows registry: ${missingEntries.join(', ')}`);
  }
}

/**
 * Cached git-bash path on Windows. Resolved once and reused.
 */
let cachedGitBashPath: string | null | undefined;

function normalizeWindowsPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/\r/g, '');
  if (!trimmed) return null;

  const unquoted = trimmed.replace(/^["']+|["']+$/g, '');
  if (!unquoted) return null;

  return unquoted.replace(/\//g, '\\');
}

function listWindowsCommandPaths(command: string): string[] {
  try {
    const output = execSync(command, { encoding: 'utf-8', timeout: 5000 });
    const parsed = output
      .split(/\r?\n/)
      .map((line) => normalizeWindowsPath(line))
      .filter((line): line is string => Boolean(line && existsSync(line)));
    return Array.from(new Set(parsed));
  } catch {
    return [];
  }
}

function listGitInstallPathsFromRegistry(): string[] {
  const registryKeys = [
    'HKCU\\Software\\GitForWindows',
    'HKLM\\Software\\GitForWindows',
    'HKLM\\Software\\WOW6432Node\\GitForWindows',
  ];

  const installRoots: string[] = [];

  for (const key of registryKeys) {
    try {
      const output = execSync(`reg query "${key}" /v InstallPath`, { encoding: 'utf-8', timeout: 5000 });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/InstallPath\s+REG_\w+\s+(.+)$/i);
        const root = normalizeWindowsPath(match?.[1]);
        if (root) {
          installRoots.push(root);
        }
      }
    } catch {
      // registry key might not exist
    }
  }

  return Array.from(new Set(installRoots));
}

function getWindowsGitToolDirs(bashPath: string): string[] {
  const normalized = bashPath.replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  let gitRoot: string | null = null;

  if (lower.endsWith('\\usr\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\usr\\bin\\bash.exe'.length);
  } else if (lower.endsWith('\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\bin\\bash.exe'.length);
  }

  if (!gitRoot) {
    const bashDir = dirname(normalized);
    return [bashDir].filter((dir) => existsSync(dir));
  }

  const candidates = [
    join(gitRoot, 'cmd'),
    join(gitRoot, 'mingw64', 'bin'),
    join(gitRoot, 'usr', 'bin'),
    join(gitRoot, 'bin'),
  ];

  return candidates.filter((dir) => existsSync(dir));
}

function ensureWindowsElectronNodeShim(electronPath: string): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const shimDir = join(app.getPath('userData'), 'cowork', 'bin');
    mkdirSync(shimDir, { recursive: true });

    const nodeSh = join(shimDir, 'node');
    const nodeCmd = join(shimDir, 'node.cmd');

    const nodeShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${LOBSTERAI_ELECTRON_PATH:-}" ]; then',
      '  echo "LOBSTERAI_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${LOBSTERAI_ELECTRON_PATH}" "$@"',
      '',
    ].join('\n');

    const nodeCmdContent = [
      '@echo off',
      'if "%LOBSTERAI_ELECTRON_PATH%"=="" (',
      '  echo LOBSTERAI_ELECTRON_PATH is not set 1>&2',
      '  exit /b 127',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%LOBSTERAI_ELECTRON_PATH%" %*',
      '',
    ].join('\r\n');

    writeFileSync(nodeSh, nodeShContent, 'utf8');
    writeFileSync(nodeCmd, nodeCmdContent, 'utf8');
    try {
      chmodSync(nodeSh, 0o755);
    } catch {
      // Ignore chmod errors on Windows file systems that do not support POSIX modes.
    }

    return shimDir;
  } catch (error) {
    coworkLog('WARN', 'resolveNodeShim', `Failed to prepare Electron Node shim: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolve git-bash path on Windows.
 * Claude Code CLI requires git-bash for shell tool execution.
 * Checks: env var > common install paths > PATH lookup > bundled PortableGit fallback.
 */
function resolveWindowsGitBashPath(): string | null {
  if (cachedGitBashPath !== undefined) return cachedGitBashPath;

  if (process.platform !== 'win32') {
    cachedGitBashPath = null;
    return null;
  }

  // 1. Explicit env var (user override)
  const envPath = normalizeWindowsPath(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  if (envPath && existsSync(envPath)) {
    coworkLog('INFO', 'resolveGitBash', `Using CLAUDE_CODE_GIT_BASH_PATH: ${envPath}`);
    cachedGitBashPath = envPath;
    return envPath;
  }

  // 2. Common Git for Windows installation paths (prefer user/system install first)
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const candidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
    'C:\\Git\\bin\\bash.exe',
    'C:\\Git\\usr\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      coworkLog('INFO', 'resolveGitBash', `Found git-bash at: ${candidate}`);
      cachedGitBashPath = candidate;
      return candidate;
    }
  }

  // 3. Query Git for Windows install root from registry
  const registryInstallRoots = listGitInstallPathsFromRegistry();
  for (const installRoot of registryInstallRoots) {
    const registryCandidates = [
      join(installRoot, 'bin', 'bash.exe'),
      join(installRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const candidate of registryCandidates) {
      if (existsSync(candidate)) {
        coworkLog('INFO', 'resolveGitBash', `Found git-bash via registry: ${candidate}`);
        cachedGitBashPath = candidate;
        return candidate;
      }
    }
  }

  // 4. Try `where bash`
  const bashPaths = listWindowsCommandPaths('where bash');
  for (const bashPath of bashPaths) {
    if (bashPath.toLowerCase().endsWith('\\bash.exe')) {
      coworkLog('INFO', 'resolveGitBash', `Found bash via PATH: ${bashPath}`);
      cachedGitBashPath = bashPath;
      return bashPath;
    }
  }

  // 5. Try `where git` and derive bash from git location
  const gitPaths = listWindowsCommandPaths('where git');
  for (const gitPath of gitPaths) {
    const gitRoot = dirname(dirname(gitPath));
    const bashCandidates = [
      join(gitRoot, 'bin', 'bash.exe'),
      join(gitRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const candidate of bashCandidates) {
      if (existsSync(candidate)) {
        coworkLog('INFO', 'resolveGitBash', `Found bash via PATH git: ${candidate}`);
        cachedGitBashPath = candidate;
        return candidate;
      }
    }
  }

  // 6. Bundled PortableGit fallback.
  // - Packaged app: resources/mingit
  // - Development mode: project resources/mingit (for local Windows dev without system Git install)
  const bundledRoots = app.isPackaged
    ? [join(process.resourcesPath, 'mingit')]
    : [
      join(__dirname, '..', '..', 'resources', 'mingit'),
      join(process.cwd(), 'resources', 'mingit'),
    ];
  for (const root of bundledRoots) {
    // Prefer bin/bash.exe on Windows; invoking usr/bin/bash.exe directly may miss Git toolchain PATH.
    const bundledPaths = [
      join(root, 'bin', 'bash.exe'),
      join(root, 'usr', 'bin', 'bash.exe'),
    ];
    for (const p of bundledPaths) {
      if (existsSync(p)) {
        coworkLog('INFO', 'resolveGitBash', `Using bundled PortableGit: ${p}`);
        cachedGitBashPath = p;
        return p;
      }
    }
  }

  coworkLog('WARN', 'resolveGitBash', 'git-bash not found on this system');
  cachedGitBashPath = null;
  return null;
}

/**
 * Windows system directories that must be in PATH for built-in commands
 * (ipconfig, systeminfo, netstat, ping, nslookup, etc.) to work.
 */
const WINDOWS_SYSTEM_PATH_ENTRIES = [
  'System32',
  'System32\\Wbem',
  'System32\\WindowsPowerShell\\v1.0',
  'System32\\OpenSSH',
];

/**
 * Critical Windows environment variables that some system commands and DLLs depend on.
 * Without these, commands like ipconfig may fail even if System32 is in PATH.
 */
const WINDOWS_CRITICAL_ENV_VARS: Record<string, () => string | undefined> = {
  SystemRoot: () => process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\windows',
  windir: () => process.env.windir || process.env.WINDIR || process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\windows',
  COMSPEC: () => process.env.COMSPEC || process.env.comspec || 'C:\\windows\\system32\\cmd.exe',
  SYSTEMDRIVE: () => process.env.SYSTEMDRIVE || process.env.SystemDrive || 'C:',
};

/**
 * Ensure critical Windows system environment variables are present in the env object.
 *
 * Packaged Electron apps or certain launch contexts may strip environment variables
 * like SystemRoot, windir, COMSPEC, and SYSTEMDRIVE. Many Windows system commands
 * and DLLs depend on these variables to locate system resources.
 *
 * Additionally, the Claude Agent SDK's shell snapshot mechanism runs `echo $PATH`
 * via `shell: true`, which on Windows uses cmd.exe. The captured PATH is then
 * baked into the snapshot file. If these critical variables are missing, the shell
 * environment may be broken and commands fail silently.
 */
function ensureWindowsSystemEnvVars(env: Record<string, string | undefined>): void {
  const injected: string[] = [];

  for (const [key, resolver] of Object.entries(WINDOWS_CRITICAL_ENV_VARS)) {
    // Check both the exact case and common variants (Windows env vars are case-insensitive
    // but Node.js process.env on Windows normalizes to the original casing)
    if (!env[key]) {
      const value = resolver();
      if (value) {
        env[key] = value;
        injected.push(`${key}=${value}`);
      }
    }
  }

  if (injected.length > 0) {
    coworkLog('INFO', 'ensureWindowsSystemEnvVars', `Injected missing Windows system env vars: ${injected.join(', ')}`);
  }
}

/**
 * Ensure Windows system directories (System32, etc.) are present in PATH.
 *
 * When the Electron app launches, process.env.PATH normally includes System32.
 * However, the Claude Agent SDK creates a "shell snapshot" by running git-bash
 * with `-c -l` (login shell). The git-bash `/etc/profile` rebuilds PATH based on
 * MSYS2_PATH_TYPE (default: "inherit"), which preserves ORIGINAL_PATH from the
 * inherited environment. If System32 entries are somehow missing from the inherited
 * PATH, they won't appear in the snapshot either.
 *
 * This function ensures that essential Windows system directories are always
 * present in PATH before the environment is handed to the SDK.
 */
function ensureWindowsSystemPathEntries(env: Record<string, string | undefined>): void {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\windows';
  const currentPath = env.PATH || '';
  const currentEntries = currentPath.split(delimiter).map((entry) => entry.toLowerCase());

  const missingDirs: string[] = [];
  for (const relDir of WINDOWS_SYSTEM_PATH_ENTRIES) {
    const fullDir = join(systemRoot, relDir);
    if (!currentEntries.includes(fullDir.toLowerCase()) && existsSync(fullDir)) {
      missingDirs.push(fullDir);
    }
  }

  // Also ensure the systemRoot itself (e.g. C:\windows) is in PATH
  if (!currentEntries.includes(systemRoot.toLowerCase()) && existsSync(systemRoot)) {
    missingDirs.push(systemRoot);
  }

  if (missingDirs.length > 0) {
    // Append system dirs at the END so they don't override user tools
    env.PATH = currentPath ? `${currentPath}${delimiter}${missingDirs.join(delimiter)}` : missingDirs.join(delimiter);
    coworkLog('INFO', 'ensureWindowsSystemPathEntries', `Appended missing Windows system PATH entries: ${missingDirs.join(', ')}`);
  }
}

/**
 * Convert a Windows-format PATH string to MSYS2/POSIX format for git-bash.
 *
 * Windows PATH uses semicolons (;) as delimiters and backslash paths (C:\...),
 * while MSYS2 bash expects colons (:) and forward-slash POSIX paths (/c/...).
 *
 * When Node.js passes env vars to a forked process, PATH stays in Windows format.
 * If the CLI later spawns git-bash, the /etc/profile uses ORIGINAL_PATH="${PATH}"
 * and appends it to the new PATH with a colon. But since the Windows PATH still
 * has semicolons inside, it becomes one giant invalid path entry.
 *
 * This function converts each semicolon-separated Windows path entry to its
 * POSIX equivalent so that git-bash can correctly parse all entries.
 */
function convertWindowsPathToMsys(windowsPath: string): string {
  if (!windowsPath) return windowsPath;

  const entries = windowsPath.split(';').filter(Boolean);
  const converted: string[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Convert Windows path to POSIX: C:\foo\bar → /c/foo/bar
    // Drive letter pattern: X:\ or X:/
    const driveMatch = trimmed.match(/^([A-Za-z]):[/\\](.*)/);
    if (driveMatch) {
      const driveLetter = driveMatch[1].toLowerCase();
      const rest = driveMatch[2].replace(/\\/g, '/').replace(/\/+$/, '');
      converted.push(`/${driveLetter}${rest ? '/' + rest : ''}`);
    } else if (trimmed.startsWith('/')) {
      // Already POSIX-style
      converted.push(trimmed);
    } else {
      // Relative path or unknown format, convert backslashes
      converted.push(trimmed.replace(/\\/g, '/'));
    }
  }

  return converted.join(':');
}

/**
 * Set ORIGINAL_PATH with POSIX-converted PATH for git-bash to inherit.
 *
 * Git-bash's /etc/profile (with MSYS2_PATH_TYPE=inherit) reads ORIGINAL_PATH
 * and appends it to the MSYS2 PATH. However, if ORIGINAL_PATH contains
 * Windows-format paths (semicolons, backslashes), bash treats them as a single
 * invalid entry because it uses colons as the PATH delimiter.
 *
 * By pre-setting ORIGINAL_PATH to the POSIX-converted version of our PATH,
 * we ensure that /etc/profile appends properly formatted, colon-separated
 * paths that bash can actually use.
 */
function ensureWindowsOriginalPath(env: Record<string, string | undefined>): void {
  const currentPath = env.PATH || '';
  if (!currentPath) return;

  const posixPath = convertWindowsPathToMsys(currentPath);
  env.ORIGINAL_PATH = posixPath;
  coworkLog('INFO', 'ensureWindowsOriginalPath', `Set ORIGINAL_PATH with ${posixPath.split(':').length} POSIX-format entries`);
}

function applyPackagedEnvOverrides(env: Record<string, string | undefined>): void {
  // On Windows, resolve git-bash and ensure Git toolchain directories are available in PATH.
  if (process.platform === 'win32') {
    env.LOBSTERAI_ELECTRON_PATH = process.execPath;

    // Ensure critical Windows system environment variables are always present.
    // Packaged Electron apps or certain launch contexts may lack these variables,
    // which causes Windows built-in commands (ipconfig, systeminfo, netstat, etc.)
    // to fail when executed inside git-bash via the Claude Agent SDK.
    ensureWindowsSystemEnvVars(env);

    // Ensure Windows system directories (System32, etc.) are always in PATH.
    // The Claude Agent SDK's shell snapshot mechanism captures PATH and may lose
    // system directories if they were missing from the inherited environment.
    ensureWindowsSystemPathEntries(env);

    // Merge the latest PATH entries from the Windows registry (Machine + User).
    // When the Electron app is launched from Explorer/Start Menu, process.env.PATH
    // may be stale and missing tools installed after Explorer started (e.g. Python,
    // Node.js, npm). Reading from the registry ensures we get the latest values,
    // similar to how a freshly opened terminal would.
    ensureWindowsRegistryPathEntries(env);

    const configuredBashPath = normalizeWindowsPath(env.CLAUDE_CODE_GIT_BASH_PATH);
    const bashPath = configuredBashPath && existsSync(configuredBashPath)
      ? configuredBashPath
      : resolveWindowsGitBashPath();

    if (bashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
      const gitToolDirs = getWindowsGitToolDirs(bashPath);
      env.PATH = appendEnvPath(env.PATH, gitToolDirs);
      coworkLog('INFO', 'resolveGitBash', `Injected Windows Git toolchain PATH entries: ${gitToolDirs.join(', ')}`);
    }

    appendPythonRuntimeToEnv(env);

    const shimDir = ensureWindowsElectronNodeShim(process.execPath);
    if (shimDir) {
      env.PATH = appendEnvPath(env.PATH, [shimDir]);
      coworkLog('INFO', 'resolveNodeShim', `Injected Electron Node shim PATH entry: ${shimDir}`);
    }

    // Tell git-bash to inherit the PATH from the parent process instead of
    // rebuilding it from scratch. Without this, git-bash's /etc/profile (login
    // shell) defaults to constructing a minimal PATH containing only Windows
    // system directories + MSYS2 tools, discarding user-installed tool paths
    // like Python, Node.js, npm, pip, etc. Setting MSYS2_PATH_TYPE=inherit
    // makes git-bash preserve the full PATH we've carefully constructed above.
    if (!env.MSYS2_PATH_TYPE) {
      env.MSYS2_PATH_TYPE = 'inherit';
      coworkLog('INFO', 'applyPackagedEnvOverrides', 'Set MSYS2_PATH_TYPE=inherit to preserve PATH in git-bash');
    }

    // Pre-set ORIGINAL_PATH in POSIX format so git-bash's /etc/profile can use it.
    //
    // ROOT CAUSE: Node.js env PATH on Windows uses semicolons (;) and backslash
    // paths (C:\...). When the Claude Agent SDK's CLI spawns git-bash with this env,
    // /etc/profile reads ORIGINAL_PATH="${ORIGINAL_PATH:-${PATH}}" and appends it
    // with a colon. But the semicolons in the Windows PATH are NOT converted to
    // colons, so "C:\nodejs;C:\python" becomes one giant invalid entry instead of
    // two separate paths. This causes `npm`, `python`, `pip` etc. to be unfindable.
    //
    // By pre-setting ORIGINAL_PATH to the POSIX-converted version (/c/nodejs:/c/python),
    // /etc/profile uses it directly and bash can correctly parse all PATH entries.
    // This MUST be done AFTER all PATH modifications above so the full PATH is captured.
    ensureWindowsOriginalPath(env);
  }

  if (!app.isPackaged) {
    return;
  }

  if (!env.HOME) {
    env.HOME = app.getPath('home');
  }

  // Resolve user's shell PATH so that node, npm, and other tools are findable
  const userPath = resolveUserShellPath();
  if (userPath) {
    env.PATH = userPath;
  } else {
    // Fallback: append common node installation paths
    const home = env.HOME || app.getPath('home');
    const commonPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      `${home}/.nvm/current/bin`,
      `${home}/.volta/bin`,
      `${home}/.fnm/current/bin`,
    ];
    env.PATH = [env.PATH, ...commonPaths].filter(Boolean).join(delimiter);
  }

  const resourcesPath = process.resourcesPath;
  const nodePaths = [
    join(resourcesPath, 'app.asar', 'node_modules'),
    join(resourcesPath, 'app.asar.unpacked', 'node_modules'),
  ].filter((nodePath) => existsSync(nodePath));

  if (nodePaths.length > 0) {
    env.NODE_PATH = appendEnvPath(env.NODE_PATH, nodePaths);
  }
}

/**
 * Get SKILLs directory path (handles both development and production)
 */
export function getSkillsRoot(): string {
  if (app.isPackaged) {
    // In production, SKILLs are copied to userData
    return join(app.getPath('userData'), 'SKILLs');
  }

  // In development, __dirname can vary with bundling output (e.g. dist-electron/ or dist-electron/libs/).
  // Resolve from several stable anchors and pick the first existing SKILLs directory.
  const envRoots = [process.env.LOBSTERAI_SKILLS_ROOT, process.env.SKILLS_ROOT]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const candidates = [
    ...envRoots,
    join(app.getAppPath(), 'SKILLs'),
    join(process.cwd(), 'SKILLs'),
    join(__dirname, '..', 'SKILLs'),
    join(__dirname, '..', '..', 'SKILLs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Final fallback for first-run dev environments where SKILLs may not exist yet.
  return join(app.getAppPath(), 'SKILLs');
}

/**
 * Get enhanced environment variables (including proxy configuration)
 * Async function to fetch system proxy and inject into environment variables
 */
export async function getEnhancedEnv(target: OpenAICompatProxyTarget = 'local'): Promise<Record<string, string | undefined>> {
  const config = getCurrentApiConfig(target);
  const env = config
    ? buildEnvForConfig(config)
    : { ...process.env };

  applyPackagedEnvOverrides(env);

  // Inject SKILLs directory path for skill scripts
  const skillsRoot = getSkillsRoot();
  env.SKILLS_ROOT = skillsRoot;
  env.LOBSTERAI_SKILLS_ROOT = skillsRoot; // Alternative name for clarity
  env.LOBSTERAI_ELECTRON_PATH = process.execPath;

  // Inject internal API base URL for skill scripts (e.g. scheduled-task creation)
  const internalApiBaseURL = getInternalApiBaseURL();
  if (internalApiBaseURL) {
    env.LOBSTERAI_API_BASE_URL = internalApiBaseURL;
  }

  // Skip system proxy resolution if proxy env vars already exist
  if (env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY) {
    return env;
  }

  // User can disable system proxy from settings.
  if (!isSystemProxyEnabled()) {
    return env;
  }

  // Resolve proxy from system settings
  const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
  if (proxyUrl) {
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    console.log('Injected system proxy for subprocess:', proxyUrl);
  }

  return env;
}

/**
 * Ensure the cowork temp directory exists in the given working directory
 * @param cwd Working directory path
 * @returns Path to the temp directory
 */
export function ensureCoworkTempDir(cwd: string): string {
  const tempDir = join(cwd, '.cowork-temp');
  if (!existsSync(tempDir)) {
    try {
      mkdirSync(tempDir, { recursive: true });
      console.log('Created cowork temp directory:', tempDir);
    } catch (error) {
      console.error('Failed to create cowork temp directory:', error);
      // Fall back to cwd if we can't create the temp dir
      return cwd;
    }
  }
  return tempDir;
}

/**
 * Get enhanced environment variables with TMPDIR set to the cowork temp directory
 * This ensures Claude Agent SDK creates temporary files in the user's working directory
 * @param cwd Working directory path
 */
export async function getEnhancedEnvWithTmpdir(
  cwd: string,
  target: OpenAICompatProxyTarget = 'local'
): Promise<Record<string, string | undefined>> {
  const env = await getEnhancedEnv(target);
  const tempDir = ensureCoworkTempDir(cwd);

  // Set temp directory environment variables for all platforms
  env.TMPDIR = tempDir;  // macOS, Linux
  env.TMP = tempDir;     // Windows
  env.TEMP = tempDir;    // Windows

  return env;
}

export async function generateSessionTitle(userIntent: string | null): Promise<string> {
  if (!userIntent) return 'New Session';

  const claudeCodePath = getClaudeCodePath();
  const currentEnv = await getEnhancedEnv();

  // Ensure child_process.fork() runs cli.js as Node, not as another Electron app
  if (app.isPackaged) {
    currentEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  try {
    const { unstable_v2_prompt } = await loadClaudeSdk();
    const promptOptions: Record<string, unknown> = {
      model: getCurrentApiConfig()?.model || 'claude-sonnet',
      env: currentEnv,
      pathToClaudeCodeExecutable: claudeCodePath,
    };

    const result: SDKResultMessage = await unstable_v2_prompt(
      `Generate a short, clear title (max 50 chars) for this conversation based on the user input below.
IMPORTANT: The title MUST be in the SAME language as the user input. If user writes in Chinese, output Chinese title. If user writes in English, output English title.
User input: ${userIntent}
Output only the title, nothing else.`,
      promptOptions as any
    );

    if (result.subtype === 'success') {
      return result.result;
    }

    console.error('Claude SDK returned non-success result:', result);
    return 'New Session';
  } catch (error) {
    console.error('Failed to generate session title:', error);
    console.error('Claude Code path:', claudeCodePath);
    console.error('Is packaged:', app.isPackaged);
    console.error('Resources path:', process.resourcesPath);

    if (userIntent) {
      const words = userIntent.trim().split(/\s+/).slice(0, 5);
      return words.join(' ').toUpperCase() + (userIntent.trim().split(/\s+/).length > 5 ? '...' : '');
    }

    return 'New Session';
  }
}
