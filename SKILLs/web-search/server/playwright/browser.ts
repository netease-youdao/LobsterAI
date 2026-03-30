/**
 * Browser Launcher - Manages Chrome browser lifecycle
 */

import { spawn, ChildProcess, execFileSync } from 'child_process';
import { existsSync, mkdirSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BrowserConfig } from '../config';

export interface BrowserInstance {
  process: ChildProcess;
  pid: number;
  cdpPort: number;
  startTime: number;
}

/**
 * Chromium-based browser executable names used to validate Windows registry results
 */
const CHROMIUM_EXE_NAMES = new Set([
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'chromium.exe',
  'vivaldi.exe',
  'opera.exe',
]);

/**
 * Read a Windows registry value using reg.exe.
 * Pass an empty string as valueName to query the default (unnamed) value.
 * Returns the value string or null if not found / on error.
 */
function readWindowsRegistryValue(key: string, valueName: string): string | null {
  try {
    const args = valueName
      ? ['query', key, '/v', valueName]
      : ['query', key, '/ve'];
    const output = execFileSync('reg', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    // Output format: "    ValueName    REG_SZ    <value>"
    const match = output.match(/REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Expand Windows environment variable strings like %SystemRoot%\foo
 */
function expandWindowsEnvVars(str: string): string {
  return str.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
}

/**
 * Extract the executable path from a Windows shell command string.
 * Handles both quoted ("C:\\path\\to\\exe.exe" ...) and unquoted forms.
 */
function extractExePath(command: string): string {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end !== -1 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx !== -1 ? trimmed.slice(0, spaceIdx) : trimmed;
}

/**
 * Detect the system default Chromium-based browser on Windows via the registry.
 *
 * Windows stores the user's default browser choice in:
 *   HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice
 * We read the ProgId from there, then look up its shell open command to get the
 * actual executable path.
 *
 * Returns the executable path, or null if unavailable / not a Chromium browser.
 */
function detectWindowsDefaultBrowser(): string | null {
  try {
    // 1. Read ProgId - HTTPS handler takes precedence over HTTP
    const progId =
      readWindowsRegistryValue(
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
        'ProgId'
      ) ||
      readWindowsRegistryValue(
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
        'ProgId'
      );

    if (!progId) {
      return null;
    }

    // 2. Look up the shell open command for that ProgId
    const command =
      readWindowsRegistryValue(`HKCR\\${progId}\\shell\\open\\command`, '') ||
      readWindowsRegistryValue(`HKLM\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`, '');

    if (!command) {
      return null;
    }

    // 3. Extract and expand the executable path
    const exePath = extractExePath(expandWindowsEnvVars(command));
    if (!exePath) {
      return null;
    }

    // 4. Validate it is a known Chromium-based browser and that the file exists
    const exeName = exePath.split('\\').pop()?.toLowerCase() ?? '';
    if (CHROMIUM_EXE_NAMES.has(exeName) && existsSync(exePath)) {
      console.log(`[Browser] Detected system default browser via registry: ${exePath}`);
      return exePath;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect Chromium-based browser executable path across platforms.
 *
 * On Windows the system default browser (read from the registry) is tried first
 * so that the user's explicit browser choice is always respected before falling
 * back to fixed-path scanning.
 */
export function getChromePath(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    // --- Priority 1: honour the system default browser set by the user ---
    const defaultBrowser = detectWindowsDefaultBrowser();
    if (defaultBrowser) {
      return defaultBrowser;
    }

    // --- Priority 2: fixed-path scan (Chrome always before Edge) ---
    const programFiles    = process.env['ProgramFiles']      || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData    = process.env['LOCALAPPDATA']       || '';

    const paths = [
      join(programFiles,    'Google\\Chrome\\Application\\chrome.exe'),
      join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      join(localAppData,    'Google\\Chrome\\Application\\chrome.exe'),
      join(programFiles,    'Microsoft\\Edge\\Application\\msedge.exe'),
      join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(localAppData,    'Microsoft\\Edge\\Application\\msedge.exe'),
    ];

    for (const p of paths) {
      if (existsSync(p)) {
        return p;
      }
    }

    throw new Error(
      'No Chromium-based browser found (Chrome/Edge/Chromium). Please install one and retry.'
    );
  }

  const paths: string[] = [];

  if (platform === 'darwin') {
    // macOS
    paths.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    );
  } else {
    // Linux
    paths.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/snap/bin/chromium'
    );
  }

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error(
    'No Chromium-based browser found (Chrome/Edge/Chromium). Please install one and retry.'
  );
}

function isDirectoryWritable(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }

  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeChromeFlags(configFlags: string[] = []): string[] {
  const runtimeFlags = [...configFlags];

  if (process.platform === 'linux') {
    if (!isDirectoryWritable('/dev/shm')) {
      console.warn('[Browser] /dev/shm is unavailable, enabling --disable-dev-shm-usage');
      runtimeFlags.push('--disable-dev-shm-usage');
    }

    if (!isDirectoryWritable('/dev/mqueue')) {
      console.warn('[Browser] /dev/mqueue is unavailable in this environment');
    }

    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.warn('[Browser] Running as root, enabling --no-sandbox');
      runtimeFlags.push('--no-sandbox');
    }
  }

  return Array.from(new Set(runtimeFlags));
}

function resolveHeadlessMode(configHeadless: boolean): boolean {
  if (configHeadless) {
    return true;
  }

  if (process.platform !== 'linux') {
    return false;
  }

  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.MIR_SOCKET);
  if (hasDisplay) {
    return false;
  }

  console.warn('[Browser] No Linux display detected, forcing headless mode');
  return true;
}

/**
 * Wait for CDP port to become available
 */
async function waitForCDP(port: number, browserProcess: ChildProcess, timeoutMs: number = 10000): Promise<void> {
  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < timeoutMs) {
    if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) {
      const exitCode = browserProcess.exitCode ?? 'null';
      const signal = browserProcess.signalCode ?? 'none';
      throw new Error(`Chrome process exited before CDP was ready (exitCode=${exitCode}, signal=${signal})`);
    }

    attempts++;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) {
        console.log(`[Browser] CDP ready after ${attempts} attempts (${Date.now() - startTime}ms)`);
        return;
      }
      console.log(`[Browser] CDP attempt ${attempts}: response not OK (status ${response.status})`);
    } catch {
      // Port not ready yet, continue waiting
      if (attempts % 5 === 0) {
        console.log(`[Browser] CDP attempt ${attempts}: still waiting... (${Date.now() - startTime}ms elapsed)`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`CDP port ${port} not ready after ${timeoutMs}ms (${attempts} attempts)`);
}

/**
 * Launch Chrome browser with CDP enabled
 */
export async function launchBrowser(config: BrowserConfig): Promise<BrowserInstance> {
  const chromePath = config.chromePath || getChromePath();
  const cdpPort = config.cdpPort;
  const runtimeChromeFlags = resolveRuntimeChromeFlags(config.chromeFlags || []);
  const runtimeHeadless = resolveHeadlessMode(config.headless);

  // Create a temporary user data directory if not provided
  const userDataDir = config.userDataDir || join(tmpdir(), `chrome-cdp-${Date.now()}`);
  if (!existsSync(userDataDir)) {
    mkdirSync(userDataDir, { recursive: true });
  }

  // Build Chrome arguments
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`, // Always use isolated user data dir
    ...runtimeChromeFlags
  ];

  if (runtimeHeadless) {
    args.push('--headless=new');
  }

  console.log(`[Browser] Launching Chrome at: ${chromePath}`);
  console.log(`[Browser] CDP port: ${cdpPort}`);
  console.log(`[Browser] User data dir: ${userDataDir}`);
  console.log(`[Browser] Headless: ${runtimeHeadless}`);
  console.log(`[Browser] Flags: ${runtimeChromeFlags.join(' ') || '(none)'}`);

  // Spawn Chrome process
  const browserProcess = spawn(chromePath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'] // Capture stdout and stderr
  });
  const recentStderr: string[] = [];

  // Log Chrome output for debugging
  if (browserProcess.stdout) {
    browserProcess.stdout.on('data', (data) => {
      console.log(`[Browser stdout] ${data.toString().trim()}`);
    });
  }
  if (browserProcess.stderr) {
    browserProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      console.log(`[Browser stderr] ${message}`);
      if (!message) {
        return;
      }

      for (const line of message.split('\n').map((item: string) => item.trim()).filter(Boolean)) {
        recentStderr.push(line);
      }
      while (recentStderr.length > 12) {
        recentStderr.shift();
      }
    });
  }

  if (!browserProcess.pid) {
    throw new Error('Failed to start Chrome process');
  }

  console.log(`[Browser] Chrome started with PID: ${browserProcess.pid}`);

  // Wait for CDP to be ready
  try {
    await waitForCDP(cdpPort, browserProcess, 20000); // Increased timeout to 20 seconds
    console.log(`[Browser] CDP ready on port ${cdpPort}`);
  } catch (error) {
    browserProcess.kill();
    const baseMessage = error instanceof Error ? error.message : String(error);
    if (recentStderr.length > 0) {
      const tail = recentStderr.slice(-5).join(' | ');
      throw new Error(`${baseMessage}. Recent browser stderr: ${tail}`);
    }
    throw error;
  }

  return {
    process: browserProcess,
    pid: browserProcess.pid,
    cdpPort,
    startTime: Date.now()
  };
}

/**
 * Close browser instance
 */
export async function closeBrowser(instance: BrowserInstance): Promise<void> {
  if (instance.process && !instance.process.killed) {
    console.log(`[Browser] Closing browser (PID: ${instance.pid})`);
    instance.process.kill('SIGTERM');

    // Wait for graceful shutdown
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        if (!instance.process.killed) {
          console.log(`[Browser] Force killing browser (PID: ${instance.pid})`);
          instance.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      instance.process.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    console.log('[Browser] Browser closed');
  }
}

/**
 * Check if browser is running
 */
export function isBrowserRunning(instance: BrowserInstance | null): boolean {
  if (!instance) {
    return false;
  }
  return instance.process && !instance.process.killed;
}
