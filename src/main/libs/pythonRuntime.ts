import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { cpRecursiveSync } from '../fsCompat';
import { repairPipShims } from './pythonPipShim';

const PYTHON_RUNTIME_DIR_NAME = 'python-win';
const PYTHON_RUNTIME_STATE_FILE = 'runtime.json';

const REQUIRED_FILES = [
  'python.exe',
  'python3.exe',
];
const PIP_EXECUTABLE_CANDIDATES = [
  path.join('Scripts', 'pip.exe'),
  path.join('Scripts', 'pip3.exe'),
  path.join('Scripts', 'pip.cmd'),
  path.join('Scripts', 'pip3.cmd'),
  path.join('Scripts', 'pip'),
  path.join('Scripts', 'pip3'),
];
const PIP_MODULE_MAIN_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__main__.py');
const PIP_MODULE_INIT_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__init__.py');

function hasPipExecutable(rootDir: string): boolean {
  return PIP_EXECUTABLE_CANDIDATES.some((relPath) => fs.existsSync(path.join(rootDir, relPath)));
}

function hasPipSupport(rootDir: string): boolean {
  const hasCommand = hasPipExecutable(rootDir);
  const hasModuleShim =
    fs.existsSync(path.join(rootDir, PIP_MODULE_MAIN_REL_PATH))
    || fs.existsSync(path.join(rootDir, PIP_MODULE_INIT_REL_PATH));
  return hasCommand && hasModuleShim;
}

function readEmbedPthFiles(rootDir: string): string[] {
  try {
    return fs.readdirSync(rootDir).filter((name) => name.endsWith('._pth'));
  } catch {
    return [];
  }
}

function ensureEmbedSitePackages(rootDir: string): void {
  const pthFiles = readEmbedPthFiles(rootDir);
  if (pthFiles.length === 0) {
    return;
  }

  const pthPath = path.join(rootDir, pthFiles[0]);
  const raw = fs.readFileSync(pthPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const updated: string[] = [];
  let hasSitePackages = false;
  let hasImportSite = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'import site' || trimmed === '#import site') {
      updated.push('import site');
      hasImportSite = true;
      continue;
    }
    if (trimmed.toLowerCase() === 'lib\\site-packages' || trimmed.toLowerCase() === 'lib/site-packages') {
      updated.push('Lib\\site-packages');
      hasSitePackages = true;
      continue;
    }
    updated.push(line);
  }

  if (!hasSitePackages) {
    updated.push('Lib\\site-packages');
  }
  if (!hasImportSite) {
    updated.push('import site');
  }

  const normalized = `${updated.join('\n').replace(/\n+$/g, '')}\n`;
  if (normalized !== raw) {
    fs.writeFileSync(pthPath, normalized, 'utf8');
  }
}

function appendWindowsPath(current: string | undefined, entries: string[]): string | undefined {
  const delimiter = ';';
  const seen = new Set<string>();
  const merged: string[] = [];

  const append = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = trimmed.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(trimmed);
  };

  entries.forEach(append);
  (current || '').split(delimiter).forEach(append);

  return merged.length > 0 ? merged.join(delimiter) : current;
}

function runtimeHealth(
  rootDir: string,
  options: { requireEmbedSiteConfig?: boolean; requirePip?: boolean } = {}
): { ok: boolean; missing: string[] } {
  const requireEmbedSiteConfig = options.requireEmbedSiteConfig !== false;
  const requirePip = options.requirePip === true;
  const missing: string[] = [];

  for (const relPath of REQUIRED_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(relPath);
    }
  }

  const hasPip = hasPipSupport(rootDir);
  if (requirePip && !hasPip) {
    if (!hasPipExecutable(rootDir)) {
      missing.push('Scripts/pip.exe (or Scripts/pip3.exe/pip.cmd)');
    }
    if (
      !fs.existsSync(path.join(rootDir, PIP_MODULE_MAIN_REL_PATH))
      && !fs.existsSync(path.join(rootDir, PIP_MODULE_INIT_REL_PATH))
    ) {
      missing.push(PIP_MODULE_MAIN_REL_PATH.replace(/\\/g, '/'));
    }
  }

  if (requireEmbedSiteConfig) {
    const pthFiles = readEmbedPthFiles(rootDir);
    if (pthFiles.length > 0) {
      const pthPath = path.join(rootDir, pthFiles[0]);
      try {
        const raw = fs.readFileSync(pthPath, 'utf8');
        const lines = raw.split(/\r?\n/).map((line) => line.trim().toLowerCase());
        const hasImportSite = lines.includes('import site');
        const hasSitePackages = lines.includes('lib\\site-packages') || lines.includes('lib/site-packages');
        if (!hasImportSite || !hasSitePackages) {
          missing.push(`${pthFiles[0]} config (require "Lib\\site-packages" and "import site")`);
        }
      } catch {
        missing.push(`${pthFiles[0]} read failed`);
      }
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function computeRuntimeSignature(rootDir: string): string {
  const parts: string[] = [];
  for (const relPath of REQUIRED_FILES) {
    const fullPath = path.join(rootDir, relPath);
    try {
      const stat = fs.statSync(fullPath);
      parts.push(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    } catch {
      parts.push(`${relPath}:missing`);
    }
  }
  return parts.join('|');
}

function ensureRuntimeStateFile(runtimeRoot: string, sourceRoot: string): void {
  const statePath = path.join(runtimeRoot, PYTHON_RUNTIME_STATE_FILE);
  const payload = {
    syncedAt: Date.now(),
    sourceRoot,
    signature: computeRuntimeSignature(runtimeRoot),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function resolveBundledCandidates(): string[] {
  if (app.isPackaged) {
    return [
      path.join(process.resourcesPath, PYTHON_RUNTIME_DIR_NAME),
      path.join(app.getAppPath(), PYTHON_RUNTIME_DIR_NAME),
    ];
  }

  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  return [
    path.join(projectRoot, 'resources', PYTHON_RUNTIME_DIR_NAME),
    path.join(process.cwd(), 'resources', PYTHON_RUNTIME_DIR_NAME),
    path.join(app.getAppPath(), 'resources', PYTHON_RUNTIME_DIR_NAME),
  ];
}

export function getBundledPythonRoot(): string | null {
  const candidates = resolveBundledCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

export function getUserPythonRoot(): string {
  return path.join(app.getPath('userData'), 'runtimes', PYTHON_RUNTIME_DIR_NAME);
}

export function appendPythonRuntimeToEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (process.platform !== 'win32') {
    return env;
  }

  const userRoot = getUserPythonRoot();
  const bundledRoot = getBundledPythonRoot();
  const candidates = [userRoot, bundledRoot].filter((value): value is string => Boolean(value));
  const pathEntries: string[] = [];
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    pathEntries.push(root, path.join(root, 'Scripts'));
  }

  if (pathEntries.length > 0) {
    env.PATH = appendWindowsPath(env.PATH, pathEntries);
    env.LOBSTERAI_PYTHON_ROOT = pathEntries[0];
  }

  return env;
}

function convergeUserPipShims(userRoot: string): void {
  try {
    const { changed } = repairPipShims(userRoot);
    if (changed.length > 0) {
      console.log(`[python-runtime] Converged pip shim files: ${changed.join(', ')}`);
    }
  } catch (error) {
    console.warn('[python-runtime] Failed to converge pip shim files:', error);
  }
}

export async function ensurePythonRuntimeReady(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { success: true };
  }

  try {
    const userRoot = getUserPythonRoot();
    if (fs.existsSync(userRoot)) {
      try {
        ensureEmbedSitePackages(userRoot);
      } catch (error) {
        console.warn('[python-runtime] Failed to normalize user runtime _pth:', error);
      }
      convergeUserPipShims(userRoot);
    }
    const userHealth = runtimeHealth(userRoot);
    if (userHealth.ok) {
      ensureRuntimeStateFile(userRoot, 'existing-user-runtime');
      if (!hasPipSupport(userRoot)) {
        console.warn('[python-runtime] User runtime is ready without full pip support; pip commands may fail.');
      }
      console.log('[python-runtime] User runtime already healthy');
      return { success: true };
    }

    const bundledRoot = getBundledPythonRoot();
    if (!bundledRoot) {
      const message = 'Bundled python runtime not found in application resources.';
      console.error(`[python-runtime] ${message}`);
      return { success: false, error: message };
    }

    const bundledHealth = runtimeHealth(bundledRoot, { requireEmbedSiteConfig: false });
    if (!bundledHealth.ok) {
      const message = `Bundled python runtime is unhealthy (missing: ${bundledHealth.missing.join(', ')})`;
      console.error(`[python-runtime] ${message}`);
      return { success: false, error: message };
    }

    console.log(`[python-runtime] Sync runtime to userData: ${userRoot}`);
    if (fs.existsSync(userRoot)) {
      fs.rmSync(userRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(userRoot), { recursive: true });
    cpRecursiveSync(bundledRoot, userRoot, { force: true, dereference: true });
    ensureEmbedSitePackages(userRoot);
    convergeUserPipShims(userRoot);

    const syncedHealth = runtimeHealth(userRoot);
    if (!syncedHealth.ok) {
      const message = `Synced python runtime is unhealthy (missing: ${syncedHealth.missing.join(', ')})`;
      console.error(`[python-runtime] ${message}`);
      return { success: false, error: message };
    }

    ensureRuntimeStateFile(userRoot, bundledRoot);
    if (!hasPipSupport(userRoot)) {
      console.warn('[python-runtime] Synced runtime does not include full pip support; pip commands may fail.');
    }
    console.log('[python-runtime] Runtime sync complete');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[python-runtime] Failed to ensure runtime ready:', message);
    return { success: false, error: message };
  }
}
