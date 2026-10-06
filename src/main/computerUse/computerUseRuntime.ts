import { execFile } from 'child_process';
import crypto from 'crypto';
import { app, session } from 'electron';
import extractZip from 'extract-zip';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

import { getLanguage, type LanguageType } from '../i18n';

export const ComputerUseRuntimeId = {
  BuiltIn: 'computer-use',
} as const;
export type ComputerUseRuntimeId =
  typeof ComputerUseRuntimeId[keyof typeof ComputerUseRuntimeId];

export const ComputerUseRuntimeTarget = {
  WindowsX64: 'win-x64',
  MacArm64: 'mac-arm64',
} as const;
export type ComputerUseRuntimeTarget =
  typeof ComputerUseRuntimeTarget[keyof typeof ComputerUseRuntimeTarget];

export const ComputerUseRuntimePlatform = {
  Windows: 'win32',
  MacOS: 'darwin',
} as const;
export type ComputerUseRuntimePlatform =
  typeof ComputerUseRuntimePlatform[keyof typeof ComputerUseRuntimePlatform];

export const ComputerUseRuntimeArch = {
  Arm64: 'arm64',
  X64: 'x64',
} as const;
export type ComputerUseRuntimeArch =
  typeof ComputerUseRuntimeArch[keyof typeof ComputerUseRuntimeArch];

export const ComputerUseRuntimeMode = {
  MacHelper: 'mac-helper',
  WindowsHelper: 'windows-helper',
} as const;
export type ComputerUseRuntimeMode =
  typeof ComputerUseRuntimeMode[keyof typeof ComputerUseRuntimeMode];

export interface ComputerUseRuntimeDescriptor {
  arch: ComputerUseRuntimeArch;
  archiveName: string;
  downloadUrl: string | null;
  id: typeof ComputerUseRuntimeId.BuiltIn;
  platform: ComputerUseRuntimePlatform;
  sha256: string;
  sizeBytes: number;
  target: ComputerUseRuntimeTarget;
  version: string;
}

export const ComputerUseRuntimes = {
  [ComputerUseRuntimeTarget.WindowsX64]: {
    id: ComputerUseRuntimeId.BuiltIn,
    version: '1.0.7',
    platform: ComputerUseRuntimePlatform.Windows,
    arch: ComputerUseRuntimeArch.X64,
    target: ComputerUseRuntimeTarget.WindowsX64,
    archiveName: 'lobsterai-computer-use-runtime-win-x64-1.0.7.zip',
    downloadUrl: 'https://ydhardwarebusiness.nosdn.127.net/806b908f1ba20905cc5c99495bccc69c.zip',
    sha256: 'd43c15cd69e10f0fbffe62f6c5ec947b4e61c5df84efbce46b6f73e28c9de30e',
    sizeBytes: 540139,
  },
  [ComputerUseRuntimeTarget.MacArm64]: {
    id: ComputerUseRuntimeId.BuiltIn,
    version: '0.2.2',
    platform: ComputerUseRuntimePlatform.MacOS,
    arch: ComputerUseRuntimeArch.Arm64,
    target: ComputerUseRuntimeTarget.MacArm64,
    archiveName: 'lobsterai-computer-use-runtime-mac-arm64-0.2.2.zip',
    downloadUrl: 'https://ydschool-video.nosdn.127.net/1791322101794lobsterai-computer-use-runtime-mac-arm64-0.2.2.zip',
    sha256: 'c46dd2f4a7786840336240dbd7795676b6e39171006914926f026995f286e0b2',
    sizeBytes: 211696,
  },
} as const satisfies Record<ComputerUseRuntimeTarget, ComputerUseRuntimeDescriptor>;

export const ComputerUseRuntimeStatus = {
  Unsupported: 'unsupported',
  NotInstalled: 'not_installed',
  Installed: 'installed',
  Invalid: 'invalid',
} as const;
export type ComputerUseRuntimeStatus =
  typeof ComputerUseRuntimeStatus[keyof typeof ComputerUseRuntimeStatus];

export const ComputerUseHelperConfig = {
  AccentColor: '#339cff',
  Direction: 'ltr',
} as const;
export type ComputerUseHelperConfig =
  typeof ComputerUseHelperConfig[keyof typeof ComputerUseHelperConfig];

/** Overlay strings shown by the platform helper while Computer Use is active. */
export const ComputerUseHelperStrings = {
  zh: {
    locale: 'zh-CN',
    escToCancel: '按 Esc 取消',
    usingComputer: 'LobsterAI正在使用你的电脑',
    stopped: '已停止电脑操作',
  },
  en: {
    locale: 'en-US',
    escToCancel: 'Press Esc to stop',
    usingComputer: 'LobsterAI is using your computer',
    stopped: 'Computer Use stopped',
  },
} as const satisfies Record<LanguageType, Record<string, string>>;

export interface ComputerUseRuntimePaths {
  clientModulePath?: string;
  helperExePath?: string;
  mode: ComputerUseRuntimeMode;
  rootDir: string;
  runtimePackageRoot?: string;
  /** Skill shipped inside the runtime, used to refresh an installed kit on upgrade. */
  skillDir?: string;
}

export interface ComputerUseRuntimeInspection {
  missing: string[];
  paths: ComputerUseRuntimePaths | null;
  status: ComputerUseRuntimeStatus;
}

export interface ComputerUseRuntimeDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
}

const RUNTIME_STATE_FILE = 'runtime.json';
const COMPUTER_USE_RESOURCE_DIR = 'computer-use';
const RUNTIME_ARCHIVE_ENV = 'LOBSTER_COMPUTER_USE_RUNTIME_ARCHIVE';
const SUPPORTED_PLATFORM_LABEL = 'Windows x64 or macOS arm64';
const STALE_STAGING_DIR_MS = 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function getCurrentComputerUseRuntimeDescriptor(): ComputerUseRuntimeDescriptor | null {
  const descriptors = Object.values(ComputerUseRuntimes);
  return descriptors.find(descriptor => (
    process.platform === descriptor.platform && process.arch === descriptor.arch
  )) ?? null;
}

export function getComputerUseSupportedPlatformLabel(): string {
  return SUPPORTED_PLATFORM_LABEL;
}

export function isComputerUseRuntimeSupportedPlatform(): boolean {
  return getCurrentComputerUseRuntimeDescriptor() !== null;
}

export function getCurrentComputerUseRuntimeVersion(): string | null {
  return getCurrentComputerUseRuntimeDescriptor()?.version ?? null;
}

function requireComputerUseRuntimeDescriptor(): ComputerUseRuntimeDescriptor {
  const descriptor = getCurrentComputerUseRuntimeDescriptor();
  if (!descriptor) {
    throw new Error(`Computer Use runtime is only available on ${SUPPORTED_PLATFORM_LABEL}.`);
  }
  return descriptor;
}

export function getComputerUseRuntimeBaseDir(): string {
  return path.join(app.getPath('userData'), 'runtimes', ComputerUseRuntimeId.BuiltIn);
}

export function getComputerUseRuntimeRoot(
  descriptor = requireComputerUseRuntimeDescriptor(),
): string {
  return path.join(
    getComputerUseRuntimeBaseDir(),
    descriptor.target,
    descriptor.version,
  );
}

export function getComputerUseHelperStateHome(): string {
  return path.join(app.getPath('userData'), 'computer-use-helper');
}

export function ensureComputerUseHelperStateHome(language: LanguageType = getLanguage()): string {
  const stateHome = getComputerUseHelperStateHome();
  const configDir = path.join(stateHome, 'computer-use');
  const configPath = path.join(configDir, 'config.json');
  const strings = ComputerUseHelperStrings[language] ?? ComputerUseHelperStrings.zh;
  const config = {
    accentColor: ComputerUseHelperConfig.AccentColor,
    direction: ComputerUseHelperConfig.Direction,
    locale: strings.locale,
    strings: {
      escToCancel: strings.escToCancel,
      usingComputer: strings.usingComputer,
      stopped: strings.stopped,
    },
  };
  const content = `${JSON.stringify(config, null, 2)}\n`;

  fs.mkdirSync(configDir, { recursive: true });
  const existing = isFile(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  if (existing !== content) {
    fs.writeFileSync(configPath, content, 'utf8');
  }

  return stateHome;
}

function readRuntimeManifest(rootDir: string): Record<string, unknown> | null {
  const manifestPath = path.join(rootDir, RUNTIME_STATE_FILE);
  if (!isFile(manifestPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function manifestMatches(
  manifest: Record<string, unknown> | null,
  descriptor: ComputerUseRuntimeDescriptor,
): boolean {
  return manifest?.id === descriptor.id
    && manifest.version === descriptor.version
    && manifest.platform === descriptor.platform
    && manifest.arch === descriptor.arch;
}

function readManifestRuntimeMode(
  manifest: Record<string, unknown> | null,
  descriptor: ComputerUseRuntimeDescriptor,
): ComputerUseRuntimeMode {
  const value = manifest?.mode;
  if (value === ComputerUseRuntimeMode.MacHelper || value === ComputerUseRuntimeMode.WindowsHelper) {
    return value;
  }
  return descriptor.platform === ComputerUseRuntimePlatform.MacOS
    ? ComputerUseRuntimeMode.MacHelper
    : ComputerUseRuntimeMode.WindowsHelper;
}

function readManifestRelativePath(
  manifest: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = manifest?.[key];
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || path.isAbsolute(normalized)) {
    return null;
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    return null;
  }

  return path.join(...parts);
}

function inspectHelperRuntime(
  rootDir: string,
  manifest: Record<string, unknown> | null,
  missing: string[],
  mode: ComputerUseRuntimeMode,
): ComputerUseRuntimePaths | null {
  const runtimePackageRootRelativePath = readManifestRelativePath(manifest, 'runtimePackageRoot');
  const helperRelativePath = readManifestRelativePath(manifest, 'helper');
  const clientModuleRelativePath = readManifestRelativePath(manifest, 'clientModule');

  if (!runtimePackageRootRelativePath) {
    missing.push(`${RUNTIME_STATE_FILE}:runtimePackageRoot`);
  }
  if (!helperRelativePath) {
    missing.push(`${RUNTIME_STATE_FILE}:helper`);
  }
  if (!clientModuleRelativePath) {
    missing.push(`${RUNTIME_STATE_FILE}:clientModule`);
  }

  const runtimePackageRoot = runtimePackageRootRelativePath
    ? path.join(rootDir, runtimePackageRootRelativePath)
    : '';
  const helperExePath = helperRelativePath ? path.join(rootDir, helperRelativePath) : '';
  const clientModulePath = clientModuleRelativePath
    ? path.join(rootDir, clientModuleRelativePath)
    : '';

  if (runtimePackageRootRelativePath && !isDirectory(runtimePackageRoot)) {
    missing.push(runtimePackageRootRelativePath);
  }
  if (helperRelativePath && !isFile(helperExePath)) {
    missing.push(helperRelativePath);
  }
  if (clientModuleRelativePath && !isFile(clientModulePath)) {
    missing.push(clientModuleRelativePath);
  }

  if (missing.length > 0) {
    return null;
  }

  const skillRelativePath = readManifestRelativePath(manifest, 'skill');
  const skillDir = skillRelativePath ? path.join(rootDir, skillRelativePath) : '';
  return {
    clientModulePath,
    helperExePath,
    mode,
    rootDir,
    runtimePackageRoot,
    ...(skillDir && isFile(path.join(skillDir, 'SKILL.md')) ? { skillDir } : {}),
  };
}

export function inspectComputerUseRuntime(
  rootDir?: string,
  descriptor = getCurrentComputerUseRuntimeDescriptor(),
): ComputerUseRuntimeInspection {
  if (!descriptor) {
    return {
      missing: [],
      paths: null,
      status: ComputerUseRuntimeStatus.Unsupported,
    };
  }

  const effectiveRootDir = rootDir ?? getComputerUseRuntimeRoot(descriptor);
  if (!isDirectory(effectiveRootDir)) {
    return {
      missing: [effectiveRootDir],
      paths: null,
      status: ComputerUseRuntimeStatus.NotInstalled,
    };
  }

  const missing: string[] = [];
  const manifest = readRuntimeManifest(effectiveRootDir);
  if (!manifestMatches(manifest, descriptor)) {
    missing.push(RUNTIME_STATE_FILE);
  }

  const mode = readManifestRuntimeMode(manifest, descriptor);
  const paths = inspectHelperRuntime(effectiveRootDir, manifest, missing, mode);

  if (!paths) {
    return {
      missing,
      paths: null,
      status: ComputerUseRuntimeStatus.Invalid,
    };
  }

  return {
    missing: [],
    paths,
    status: ComputerUseRuntimeStatus.Installed,
  };
}

export function resolveInstalledComputerUseRuntimePaths(): ComputerUseRuntimePaths | null {
  return inspectComputerUseRuntime().paths;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function resolveBundledRuntimeArchivePath(descriptor: ComputerUseRuntimeDescriptor): string | null {
  const envArchivePath = process.env[RUNTIME_ARCHIVE_ENV]?.trim();
  const candidates = [
    envArchivePath,
    path.join(process.resourcesPath ?? '', COMPUTER_USE_RESOURCE_DIR, descriptor.archiveName),
    path.join(app.getAppPath(), 'resources', COMPUTER_USE_RESOURCE_DIR, descriptor.archiveName),
    path.join(process.cwd(), 'resources', COMPUTER_USE_RESOURCE_DIR, descriptor.archiveName),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find(candidate => isFile(candidate)) ?? null;
}

async function copyRuntimeArchive(
  sourcePath: string,
  archivePath: string,
  onProgress?: (progress: ComputerUseRuntimeDownloadProgress) => void,
): Promise<void> {
  const total = fs.statSync(sourcePath).size;
  onProgress?.({ received: 0, total, percent: 0 });
  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.promises.copyFile(sourcePath, archivePath);
  onProgress?.({ received: total, total, percent: 1 });
}

async function downloadRuntimeArchive(
  descriptor: ComputerUseRuntimeDescriptor,
  archivePath: string,
  onProgress?: (progress: ComputerUseRuntimeDownloadProgress) => void,
): Promise<void> {
  if (!descriptor.downloadUrl) {
    throw new Error(
      `Computer Use runtime archive is not bundled for ${descriptor.target}. `
      + `Configure downloadUrl or set ${RUNTIME_ARCHIVE_ENV}.`,
    );
  }

  const response = await session.defaultSession.fetch(descriptor.downloadUrl);
  if (!response.ok) {
    throw new Error(`Computer Use runtime download failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Computer Use runtime download returned an empty body');
  }

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : undefined;
  let received = 0;
  onProgress?.({ received, total, percent: total ? 0 : undefined });

  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
  const nodeStream = Readable.fromWeb(response.body as any);
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.({
      received,
      total: total && Number.isFinite(total) ? total : undefined,
      percent: total && Number.isFinite(total) ? received / total : undefined,
    });
  });
  await pipeline(nodeStream, fs.createWriteStream(archivePath));
}

async function stageRuntimeArchive(
  descriptor: ComputerUseRuntimeDescriptor,
  archivePath: string,
  onProgress?: (progress: ComputerUseRuntimeDownloadProgress) => void,
): Promise<void> {
  const bundledArchivePath = resolveBundledRuntimeArchivePath(descriptor);
  if (bundledArchivePath) {
    await copyRuntimeArchive(bundledArchivePath, archivePath, onProgress);
    return;
  }

  await downloadRuntimeArchive(descriptor, archivePath, onProgress);
}

async function extractRuntimeArchive(
  descriptor: ComputerUseRuntimeDescriptor,
  archivePath: string,
  destinationDir: string,
): Promise<void> {
  if (descriptor.platform === ComputerUseRuntimePlatform.MacOS) {
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', archivePath, destinationDir]);
    return;
  }

  await extractZip(archivePath, { dir: destinationDir });
}

export async function installComputerUseRuntime(
  onProgress?: (progress: ComputerUseRuntimeDownloadProgress) => void,
): Promise<{ success: boolean; paths?: ComputerUseRuntimePaths; error?: string }> {
  const descriptor = getCurrentComputerUseRuntimeDescriptor();
  if (!descriptor) {
    return { success: false, error: `Computer Use runtime is only available on ${SUPPORTED_PLATFORM_LABEL}.` };
  }

  const current = inspectComputerUseRuntime(undefined, descriptor);
  if (current.paths) {
    await removeStaleComputerUseRuntimes(descriptor);
    return { success: true, paths: current.paths };
  }

  const baseDir = getComputerUseRuntimeBaseDir();
  const archivePath = path.join(baseDir, 'downloads', descriptor.archiveName);
  const targetRoot = getComputerUseRuntimeRoot(descriptor);
  const tempRoot = `${targetRoot}.tmp-${Date.now()}`;

  try {
    await stageRuntimeArchive(descriptor, archivePath, onProgress);

    const stat = await fs.promises.stat(archivePath);
    if (stat.size !== descriptor.sizeBytes) {
      throw new Error('Computer Use runtime size verification failed');
    }

    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== descriptor.sha256) {
      throw new Error('Computer Use runtime checksum verification failed');
    }

    await fs.promises.rm(tempRoot, { recursive: true, force: true });
    await fs.promises.mkdir(tempRoot, { recursive: true });
    await extractRuntimeArchive(descriptor, archivePath, tempRoot);

    const extracted = inspectComputerUseRuntime(tempRoot, descriptor);
    if (!extracted.paths) {
      throw new Error(`Computer Use runtime archive is invalid: ${extracted.missing.join(', ')}`);
    }

    await fs.promises.rm(targetRoot, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.promises.rename(tempRoot, targetRoot);

    const installed = inspectComputerUseRuntime(targetRoot, descriptor);
    if (!installed.paths) {
      throw new Error(`Computer Use runtime install is invalid: ${installed.missing.join(', ')}`);
    }

    console.log(`[ComputerUseRuntime] runtime installed successfully for ${descriptor.target}`);
    await removeStaleComputerUseRuntimes(descriptor);
    return { success: true, paths: installed.paths };
  } catch (error) {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ComputerUseRuntime] runtime installation failed:', error);
    return { success: false, error: message };
  }
}

/**
 * Removes runtime versions and cached archives left behind by earlier releases.
 * Only the current descriptor's version directory and archive are kept.
 */
export async function removeStaleComputerUseRuntimes(
  descriptor: ComputerUseRuntimeDescriptor,
): Promise<string[]> {
  const removed: string[] = [];
  const targetDir = path.join(getComputerUseRuntimeBaseDir(), descriptor.target);
  const downloadsDir = path.join(getComputerUseRuntimeBaseDir(), 'downloads');
  const removeEntry = async (entryPath: string): Promise<void> => {
    try {
      await fs.promises.rm(entryPath, { recursive: true, force: true });
      removed.push(entryPath);
    } catch (error) {
      console.warn(`[ComputerUseRuntime] failed to remove stale runtime entry ${entryPath}:`, error);
    }
  };

  const versionEntries = await fs.promises.readdir(targetDir).catch(() => [] as string[]);
  for (const entry of versionEntries) {
    if (entry === descriptor.version) {
      continue;
    }
    const entryPath = path.join(targetDir, entry);
    if (entry.includes('.tmp-')) {
      // Another install may still be extracting into this staging directory.
      const stat = await fs.promises.stat(entryPath).catch((): null => null);
      if (stat && Date.now() - stat.mtimeMs < STALE_STAGING_DIR_MS) {
        continue;
      }
    }
    await removeEntry(entryPath);
  }

  const archivePrefix = `lobsterai-computer-use-runtime-${descriptor.target}-`;
  const archiveEntries = await fs.promises.readdir(downloadsDir).catch(() => [] as string[]);
  for (const entry of archiveEntries) {
    if (entry.startsWith(archivePrefix) && entry !== descriptor.archiveName) {
      await removeEntry(path.join(downloadsDir, entry));
    }
  }

  if (removed.length > 0) {
    console.log(`[ComputerUseRuntime] removed ${removed.length} stale runtime entr${removed.length === 1 ? 'y' : 'ies'} for ${descriptor.target}`);
  }
  return removed;
}

export async function uninstallComputerUseRuntime(): Promise<void> {
  const descriptor = getCurrentComputerUseRuntimeDescriptor();
  if (!descriptor) {
    return;
  }

  const targetRoot = getComputerUseRuntimeRoot(descriptor);
  const archivePath = path.join(
    getComputerUseRuntimeBaseDir(),
    'downloads',
    descriptor.archiveName,
  );

  await fs.promises.rm(targetRoot, { recursive: true, force: true });
  await fs.promises.rm(archivePath, { force: true }).catch(() => {});
}
