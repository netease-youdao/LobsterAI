import { app, session } from 'electron';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { spawnSync } from 'child_process';
import { coworkLog } from './coworkLogger';

export type CoworkSandboxStatus = {
  supported: boolean;
  runtimeReady: boolean;
  imageReady: boolean;
  downloading: boolean;
  progress?: CoworkSandboxProgress;
  error?: string | null;
};

export type CoworkSandboxProgress = {
  stage: 'runtime' | 'image';
  received: number;
  total?: number;
  percent?: number;
  url?: string;
};

export type SandboxRuntimeInfo = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  runtimeBinary: string;
  imagePath: string;
  kernelPath?: string | null;
  initrdPath?: string | null;
  baseDir: string;
};

type SandboxCheckResult = { ok: true; runtimeInfo: SandboxRuntimeInfo } | { ok: false; error: string };

const SANDBOX_BASE_URL = process.env.COWORK_SANDBOX_BASE_URL || '';
const SANDBOX_RUNTIME_VERSION = process.env.COWORK_SANDBOX_RUNTIME_VERSION || 'v0.1.3';
const SANDBOX_IMAGE_VERSION = process.env.COWORK_SANDBOX_IMAGE_VERSION || 'v0.1.4';

const SANDBOX_RUNTIME_URL = process.env.COWORK_SANDBOX_RUNTIME_URL;
const SANDBOX_IMAGE_URL = process.env.COWORK_SANDBOX_IMAGE_URL;
const SANDBOX_IMAGE_URL_ARM64 = process.env.COWORK_SANDBOX_IMAGE_URL_ARM64;
const SANDBOX_IMAGE_URL_AMD64 = process.env.COWORK_SANDBOX_IMAGE_URL_AMD64;
const SANDBOX_KERNEL_URL = process.env.COWORK_SANDBOX_KERNEL_URL;
const SANDBOX_KERNEL_URL_ARM64 = process.env.COWORK_SANDBOX_KERNEL_URL_ARM64;
const SANDBOX_KERNEL_URL_AMD64 = process.env.COWORK_SANDBOX_KERNEL_URL_AMD64;
const SANDBOX_INITRD_URL = process.env.COWORK_SANDBOX_INITRD_URL;
const SANDBOX_INITRD_URL_ARM64 = process.env.COWORK_SANDBOX_INITRD_URL_ARM64;
const SANDBOX_INITRD_URL_AMD64 = process.env.COWORK_SANDBOX_INITRD_URL_AMD64;
const SANDBOX_KERNEL_PATH = process.env.COWORK_SANDBOX_KERNEL_PATH;
const SANDBOX_KERNEL_PATH_ARM64 = process.env.COWORK_SANDBOX_KERNEL_PATH_ARM64;
const SANDBOX_KERNEL_PATH_AMD64 = process.env.COWORK_SANDBOX_KERNEL_PATH_AMD64;
const SANDBOX_INITRD_PATH = process.env.COWORK_SANDBOX_INITRD_PATH;
const SANDBOX_INITRD_PATH_ARM64 = process.env.COWORK_SANDBOX_INITRD_PATH_ARM64;
const SANDBOX_INITRD_PATH_AMD64 = process.env.COWORK_SANDBOX_INITRD_PATH_AMD64;

const SANDBOX_RUNTIME_SHA256 = process.env.COWORK_SANDBOX_RUNTIME_SHA256;
const SANDBOX_IMAGE_SHA256 = process.env.COWORK_SANDBOX_IMAGE_SHA256;
const SANDBOX_IMAGE_SHA256_ARM64 = process.env.COWORK_SANDBOX_IMAGE_SHA256_ARM64;
const SANDBOX_IMAGE_SHA256_AMD64 = process.env.COWORK_SANDBOX_IMAGE_SHA256_AMD64;

// Default sandbox resources for different architectures
// Note: macOS binaries are statically linked, Windows requires full QEMU installation
const DEFAULT_SANDBOX_RUNTIME_URL_DARWIN_ARM64 = 'https://ydhardwarecommon.nosdn.127.net/f23e57c47e4356c31b5bf1012f10a53e.gz';
const DEFAULT_SANDBOX_RUNTIME_URL_DARWIN_AMD64 = 'https://ydhardwarecommon.nosdn.127.net/20a9f6a34705ca51dbd9fb8c7695c1e5.gz';
const DEFAULT_SANDBOX_RUNTIME_URL_WIN32_AMD64 = 'https://ydhardwarecommon.nosdn.127.net/02a016878c4457bd819e11e55b7b6884.gz';

const DEFAULT_SANDBOX_IMAGE_URL_ARM64 = 'https://ydhardwarecommon.nosdn.127.net/59d9df60ce9c0463c54e3043af60cb10.qcow2';
const DEFAULT_SANDBOX_IMAGE_URL_AMD64 = 'https://ydhardwarebusiness.nosdn.127.net/e5048549c753baa896c9652e3e34f1d3.qcow2';

const downloadState: {
  runtime: Promise<string> | null;
  image: Promise<string> | null;
  progress?: CoworkSandboxProgress;
  error: string | null;
} = {
  runtime: null,
  image: null,
  progress: undefined,
  error: null,
};

// Cache the resolved system QEMU path (Windows only) so getSandboxStatus()
// can report runtimeReady=true when using a system-installed QEMU.
let _resolvedSystemQemuPath: string | null = null;

const sandboxEvents = new EventEmitter();

function emitProgress(progress: CoworkSandboxProgress): void {
  downloadState.progress = progress;
  sandboxEvents.emit('progress', progress);
}

export function onSandboxProgress(listener: (progress: CoworkSandboxProgress) => void): () => void {
  sandboxEvents.on('progress', listener);
  return () => sandboxEvents.off('progress', listener);
}

function getPlatformKey(): string | null {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) {
    return null;
  }
  if (!['x64', 'arm64'].includes(process.arch)) {
    return null;
  }
  return `${process.platform}-${process.arch}`;
}

function getRuntimeBinaryName(): string {
  const isWindows = process.platform === 'win32';
  if (process.arch === 'arm64') {
    return isWindows ? 'qemu-system-aarch64.exe' : 'qemu-system-aarch64';
  }
  return isWindows ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';
}

function getSandboxPaths() {
  const baseDir = path.join(app.getPath('userData'), 'cowork', 'sandbox');
  const runtimeDir = path.join(baseDir, 'runtime', `${SANDBOX_RUNTIME_VERSION}`);
  const imageDir = path.join(baseDir, 'images', `${SANDBOX_IMAGE_VERSION}`);
  const runtimeBinary = path.join(runtimeDir, getRuntimeBinaryName());
  const imagePath = path.join(imageDir, `linux-${process.arch}.qcow2`);
  return { baseDir, runtimeDir, imageDir, runtimeBinary, imagePath };
}

function getRuntimeUrl(platformKey: string): string | null {
  if (SANDBOX_RUNTIME_URL) {
    return SANDBOX_RUNTIME_URL;
  }
  if (platformKey === 'darwin-arm64' && DEFAULT_SANDBOX_RUNTIME_URL_DARWIN_ARM64) {
    return DEFAULT_SANDBOX_RUNTIME_URL_DARWIN_ARM64;
  }
  if (platformKey === 'darwin-x64' && DEFAULT_SANDBOX_RUNTIME_URL_DARWIN_AMD64) {
    return DEFAULT_SANDBOX_RUNTIME_URL_DARWIN_AMD64;
  }
  // Windows x64: use NSIS installer package from CDN
  if (platformKey === 'win32-x64' && DEFAULT_SANDBOX_RUNTIME_URL_WIN32_AMD64) {
    return DEFAULT_SANDBOX_RUNTIME_URL_WIN32_AMD64;
  }
  // Windows arm64: no default URL yet
  if (platformKey.startsWith('win32')) {
    return null;
  }
  if (!SANDBOX_BASE_URL) {
    return null;
  }
  return `${SANDBOX_BASE_URL}/${SANDBOX_RUNTIME_VERSION}/runtime-${platformKey}.tar.gz`;
}

function getArchVariant(): 'amd64' | 'arm64' | null {
  if (process.arch === 'x64') {
    return 'amd64';
  }
  if (process.arch === 'arm64') {
    return 'arm64';
  }
  return null;
}

function getImageUrl(): string | null {
  const archVariant = getArchVariant();
  if (archVariant === 'arm64' && (SANDBOX_IMAGE_URL_ARM64 || DEFAULT_SANDBOX_IMAGE_URL_ARM64)) {
    return SANDBOX_IMAGE_URL_ARM64 || DEFAULT_SANDBOX_IMAGE_URL_ARM64;
  }
  if (archVariant === 'amd64' && (SANDBOX_IMAGE_URL_AMD64 || DEFAULT_SANDBOX_IMAGE_URL_AMD64)) {
    return SANDBOX_IMAGE_URL_AMD64 || DEFAULT_SANDBOX_IMAGE_URL_AMD64;
  }
  if (SANDBOX_IMAGE_URL) {
    return SANDBOX_IMAGE_URL;
  }
  if (!SANDBOX_BASE_URL) {
    return null;
  }
  return `${SANDBOX_BASE_URL}/${SANDBOX_IMAGE_VERSION}/image-linux-${process.arch}.qcow2`;
}

function getImageSha256(): string | null {
  const archVariant = getArchVariant();
  if (archVariant === 'arm64' && SANDBOX_IMAGE_SHA256_ARM64) {
    return SANDBOX_IMAGE_SHA256_ARM64;
  }
  if (archVariant === 'amd64' && SANDBOX_IMAGE_SHA256_AMD64) {
    return SANDBOX_IMAGE_SHA256_AMD64;
  }
  return SANDBOX_IMAGE_SHA256 || null;
}

function getKernelUrl(): string | null {
  const archVariant = getArchVariant();
  if (archVariant === 'arm64' && SANDBOX_KERNEL_URL_ARM64) {
    return SANDBOX_KERNEL_URL_ARM64;
  }
  if (archVariant === 'amd64' && SANDBOX_KERNEL_URL_AMD64) {
    return SANDBOX_KERNEL_URL_AMD64;
  }
  return SANDBOX_KERNEL_URL || null;
}

function getInitrdUrl(): string | null {
  const archVariant = getArchVariant();
  if (archVariant === 'arm64' && SANDBOX_INITRD_URL_ARM64) {
    return SANDBOX_INITRD_URL_ARM64;
  }
  if (archVariant === 'amd64' && SANDBOX_INITRD_URL_AMD64) {
    return SANDBOX_INITRD_URL_AMD64;
  }
  return SANDBOX_INITRD_URL || null;
}

function getKernelPathOverride(): string | null {
  const archVariant = getArchVariant();
  if (archVariant === 'arm64' && SANDBOX_KERNEL_PATH_ARM64) {
    return SANDBOX_KERNEL_PATH_ARM64;
  }
  if (archVariant === 'amd64' && SANDBOX_KERNEL_PATH_AMD64) {
    return SANDBOX_KERNEL_PATH_AMD64;
  }
  return SANDBOX_KERNEL_PATH || null;
}

function getInitrdPathOverride(): string | null {
  const archVariant = getArchVariant();
  if (archVariant === 'arm64' && SANDBOX_INITRD_PATH_ARM64) {
    return SANDBOX_INITRD_PATH_ARM64;
  }
  if (archVariant === 'amd64' && SANDBOX_INITRD_PATH_AMD64) {
    return SANDBOX_INITRD_PATH_AMD64;
  }
  return SANDBOX_INITRD_PATH || null;
}

async function downloadFile(url: string, destination: string, stage: CoworkSandboxProgress['stage']): Promise<void> {
  const response = await session.defaultSession.fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(destination, data);
    emitProgress({
      stage,
      received: data.length,
      total: data.length,
      percent: 1,
      url,
    });
    return;
  }

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : undefined;
  let received = 0;
  emitProgress({
    stage,
    received,
    total: total && Number.isFinite(total) ? total : undefined,
    percent: total && Number.isFinite(total) ? 0 : undefined,
    url,
  });

  const nodeStream = Readable.fromWeb(response.body as any);
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    emitProgress({
      stage,
      received,
      total: total && Number.isFinite(total) ? total : undefined,
      percent: total && Number.isFinite(total) ? received / total : undefined,
      url,
    });
  });

  await pipeline(nodeStream, fs.createWriteStream(destination));

  emitProgress({
    stage,
    received,
    total: total && Number.isFinite(total) ? total : undefined,
    percent: total && Number.isFinite(total) ? 1 : undefined,
    url,
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function verifySha256(filePath: string, expected?: string | null): Promise<void> {
  if (!expected) return;
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}`);
  }
}

function extractTarArchive(archivePath: string, destDir: string): void {
  const result = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || 'Failed to extract tar archive');
  }
}

function extractArchive(archivePath: string, destDir: string): void {
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Force "${archivePath}" "${destDir}"`],
        { stdio: 'pipe' }
      );
      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'Failed to extract zip archive');
      }
    } else {
      const result = spawnSync('unzip', ['-q', archivePath, '-d', destDir], { stdio: 'pipe' });
      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'Failed to extract zip archive');
      }
    }
    return;
  }

  if (archivePath.endsWith('.tar')) {
    extractTarArchive(archivePath, destDir);
    return;
  }

  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || 'Failed to extract tar archive');
    }
    return;
  }

  throw new Error('Unsupported runtime archive format');
}

async function extractGzipBinary(archivePath: string, targetPath: string): Promise<void> {
  await pipeline(
    fs.createReadStream(archivePath),
    createGunzip(),
    fs.createWriteStream(targetPath)
  );
}

async function isTarFile(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(262);
    await handle.read(buffer, 0, 262, 0);
    await handle.close();
    const magic = buffer.subarray(257, 262).toString('utf8');
    return magic === 'ustar';
  } catch (error) {
    console.warn('Failed to probe sandbox runtime archive:', error);
    return false;
  }
}

async function isGzipFile(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(2);
    await handle.read(buffer, 0, 2, 0);
    await handle.close();
    return buffer[0] === 0x1f && buffer[1] === 0x8b;
  } catch (error) {
    console.warn('Failed to probe sandbox runtime binary:', error);
    return false;
  }
}

async function isPEFile(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(2);
    await handle.read(buffer, 0, 2, 0);
    await handle.close();
    // MZ magic number for PE/COFF executables
    return buffer[0] === 0x4d && buffer[1] === 0x5a;
  } catch (error) {
    console.warn('Failed to probe file for PE header:', error);
    return false;
  }
}

/**
 * Launch an NSIS installer interactively (like double-click) and wait for it to finish.
 * Uses PowerShell Start-Process which calls ShellExecute internally, properly handling
 * UAC elevation — the user sees the standard Windows elevation prompt and installer UI.
 */
async function runNsisInstaller(installerPath: string, targetDir: string): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });

  console.log(`[Sandbox] Launching QEMU installer interactively: ${installerPath}`);
  console.log(`[Sandbox] Suggested install directory: ${targetDir}`);

  // Start-Process uses ShellExecute which handles UAC elevation automatically.
  // -Wait blocks until the installer exits.
  // /D= pre-sets the installation directory in the NSIS UI (user can still change it).
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Start-Process -FilePath '${installerPath}' -ArgumentList '/D=${targetDir}' -Wait`,
  ], { stdio: 'pipe', timeout: 600000 }); // 10-minute timeout

  if (result.error) {
    throw new Error(`Failed to launch installer: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || '';
    throw new Error(
      `Installer failed (exit code ${result.status}): ${stderr || 'User may have cancelled the installation or denied elevation.'}`
    );
  }

  console.log('[Sandbox] QEMU installer process completed');
}

function resolveRuntimeBinary(runtimeDir: string, expectedPath: string): string | null {
  if (fs.existsSync(expectedPath)) {
    return expectedPath;
  }

  if (!fs.existsSync(runtimeDir)) {
    return null;
  }

  const targetName = path.basename(expectedPath);
  const stack = [runtimeDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name === targetName) {
        return entryPath;
      }
    }
  }

  return null;
}

/**
 * Try to find QEMU in system PATH on Windows
 */
function findSystemQemu(): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  const qemuName = getRuntimeBinaryName();

  // Check if QEMU is in PATH
  const result = spawnSync('where', [qemuName], { stdio: 'pipe' });
  if (result.status === 0 && result.stdout) {
    const paths = result.stdout.toString().trim().split('\n');
    for (const qemuPath of paths) {
      const trimmedPath = qemuPath.trim();
      if (fs.existsSync(trimmedPath)) {
        // Verify it's executable by testing --version
        const testResult = spawnSync(trimmedPath, ['--version'], { stdio: 'pipe', timeout: 5000 });
        if (testResult.status === 0 || testResult.status === 3221225781) {
          // Status 0 = success, 3221225781 = DLL issue but binary exists
          // For DLL issue, we still return the path but validation will fail later
          return trimmedPath;
        }
      }
    }
  }

  // Check common installation paths
  const commonPaths = [
    'C:\\Program Files\\qemu',
    'C:\\Program Files (x86)\\qemu',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'qemu'),
  ];

  for (const basePath of commonPaths) {
    const qemuPath = path.join(basePath, qemuName);
    if (fs.existsSync(qemuPath)) {
      return qemuPath;
    }
  }

  return null;
}

/**
 * Validate that a QEMU binary can actually run (not just exist)
 */
function validateQemuBinary(binaryPath: string): { valid: boolean; error?: string } {
  if (!fs.existsSync(binaryPath)) {
    return { valid: false, error: 'Binary not found' };
  }

  // Try to run --version to verify the binary works
  const result = spawnSync(binaryPath, ['--version'], { stdio: 'pipe', timeout: 5000 });

  // Exit code 0 means success
  if (result.status === 0) {
    return { valid: true };
  }

  // Exit code 3221225781 (0xC0000135) = STATUS_DLL_NOT_FOUND
  if (result.status === 3221225781) {
    return {
      valid: false,
      error: 'QEMU binary is missing required DLL files. Please install QEMU properly or use a complete QEMU package.',
    };
  }

  // Other non-zero exit codes
  if (result.status !== null && result.status !== 0) {
    return {
      valid: false,
      error: `QEMU binary failed to run (exit code: ${result.status}). ${result.stderr?.toString() || ''}`.trim(),
    };
  }

  // Timeout or signal
  if (result.error) {
    return {
      valid: false,
      error: `Failed to run QEMU: ${result.error.message}`,
    };
  }

  return { valid: false, error: 'Unknown error validating QEMU binary' };
}

/**
 * Check whether a QEMU binary has virtfs (9p filesystem) support compiled in.
 * The sandbox relies on `-virtfs` for host–guest file sharing; without it the VM
 * cannot communicate with the host.
 *
 * On Windows, virtfs is typically not supported, so we skip this check and use
 * virtio-serial as an alternative IPC channel.
 */
function checkQemuVirtfsSupport(binaryPath: string): boolean {
  // On Windows, QEMU typically doesn't support virtfs (9p filesystem)
  // We use virtio-serial IPC instead, so we skip this check
  if (process.platform === 'win32') {
    return true; // Return true to allow Windows QEMU to be used
  }

  const result = spawnSync(binaryPath, ['-help'], { stdio: 'pipe', timeout: 5000 });
  if (result.status === 0 && result.stdout) {
    return result.stdout.toString().includes('-virtfs');
  }
  return false;
}

function hasHypervisorEntitlement(output: string): boolean {
  return output.includes('com.apple.security.hypervisor');
}

function ensureHypervisorEntitlement(binaryPath: string, runtimeDir: string): void {
  if (process.platform !== 'darwin') return;

  const probe = spawnSync('codesign', ['-d', '--entitlements', ':-', binaryPath], { stdio: 'pipe' });
  if (probe.status === 0) {
    const stdout = probe.stdout?.toString() || '';
    const stderr = probe.stderr?.toString() || '';
    if (hasHypervisorEntitlement(stdout) || hasHypervisorEntitlement(stderr)) {
      return;
    }
  }

  const entitlementsPath = path.join(runtimeDir, 'entitlements.hypervisor.plist');
  const entitlements = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>com.apple.security.hypervisor</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(entitlementsPath, entitlements);
  } catch (error) {
    console.warn('Failed to write hypervisor entitlements file:', error);
    return;
  }

  const sign = spawnSync(
    'codesign',
    ['-s', '-', '--force', '--entitlements', entitlementsPath, binaryPath],
    { stdio: 'pipe' }
  );
  if (sign.status !== 0) {
    const stderr = sign.stderr?.toString() || sign.stdout?.toString() || 'Unknown codesign error';
    console.warn('Failed to codesign sandbox runtime for HVF:', stderr.trim());
  }
}

async function ensureRuntime(): Promise<string> {
  const platformKey = getPlatformKey();
  if (!platformKey) {
    throw new Error('Sandbox VM is not supported on this platform.');
  }

  const { runtimeDir, runtimeBinary } = getSandboxPaths();
  const resolvedBinary = resolveRuntimeBinary(runtimeDir, runtimeBinary);
  if (resolvedBinary) {
    if (await isGzipFile(resolvedBinary)) {
      const tempPath = `${resolvedBinary}.tmp`;
      await extractGzipBinary(resolvedBinary, tempPath);
      if (await isTarFile(tempPath)) {
        extractTarArchive(tempPath, runtimeDir);
        await fs.promises.unlink(tempPath);
        try {
          await fs.promises.unlink(resolvedBinary);
        } catch (error) {
          console.warn('Failed to remove sandbox runtime gzip archive:', error);
        }
      } else {
        await fs.promises.rename(tempPath, resolvedBinary);
      }
    } else if (await isTarFile(resolvedBinary)) {
      extractTarArchive(resolvedBinary, runtimeDir);
      try {
        await fs.promises.unlink(resolvedBinary);
      } catch (error) {
        console.warn('Failed to remove sandbox runtime tar archive:', error);
      }
    }

    const finalResolved = resolveRuntimeBinary(runtimeDir, runtimeBinary);
    if (!finalResolved) {
      throw new Error('Sandbox runtime binary not found after extraction.');
    }

    // Log validation result but do not delete or re-download — if the binary
    // is broken the error will surface when the VM is actually started.
    const validation = validateQemuBinary(finalResolved);
    if (!validation.valid) {
      console.warn(`[Sandbox] QEMU binary validation warning: ${validation.error}`);
    }

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(finalResolved, 0o755);
      } catch (error) {
        console.warn('Failed to chmod sandbox runtime binary:', error);
      }
    }
    ensureHypervisorEntitlement(finalResolved, runtimeDir);
    return finalResolved;
  }

  // On Windows, try to find system-installed QEMU before downloading
  if (process.platform === 'win32') {
    const systemQemu = findSystemQemu();
    if (systemQemu) {
      console.log(`[Sandbox] Found system QEMU at: ${systemQemu}`);
      const validation = validateQemuBinary(systemQemu);
      if (validation.valid) {
        // On Windows, checkQemuVirtfsSupport always returns true since we use virtio-serial IPC instead
        if (checkQemuVirtfsSupport(systemQemu)) {
          console.log('[Sandbox] Using system QEMU installation');
          _resolvedSystemQemuPath = systemQemu;
          return systemQemu;
        }
        // This branch will never be reached on Windows due to the check above
        console.warn('[Sandbox] System QEMU lacks virtfs (9p) support, will download a compatible build');
      } else {
        console.warn(`[Sandbox] System QEMU found but invalid: ${validation.error}`);
      }
    }
  }

  const url = getRuntimeUrl(platformKey);
  if (!url) {
    let errorMsg: string;
    if (platformKey === 'win32-x64' || platformKey === 'win32-arm64') {
      errorMsg = [
        'Windows sandbox requires QEMU to be installed.',
        '',
        'Please install QEMU using one of these methods:',
        '1. Download and install from: https://qemu.weilnetz.de/w64/',
        '2. Install via scoop: scoop install qemu',
        '3. Install via chocolatey: choco install qemu',
        '',
        'After installation, QEMU should be available in your system PATH.',
        'Alternatively, set the COWORK_SANDBOX_RUNTIME_URL environment variable to a QEMU package URL.',
      ].join('\n');
    } else {
      errorMsg = 'Sandbox runtime download URL is not configured.';
    }
    throw new Error(errorMsg);
  }

  const archivePath = path.join(runtimeDir, `runtime-${platformKey}.download`);
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  await downloadFile(url, archivePath, 'runtime');
  await verifySha256(archivePath, SANDBOX_RUNTIME_SHA256);

  if (url.endsWith('.zip') || url.endsWith('.tar.gz') || url.endsWith('.tgz')) {
    extractArchive(archivePath, runtimeDir);
    await fs.promises.unlink(archivePath);
  } else if (url.endsWith('.gz')) {
    const tempPath = `${runtimeBinary}.download`;
    await extractGzipBinary(archivePath, tempPath);
    await fs.promises.unlink(archivePath);
    if (await isTarFile(tempPath)) {
      extractTarArchive(tempPath, runtimeDir);
      await fs.promises.unlink(tempPath);
    } else if (process.platform === 'win32' && await isPEFile(tempPath)) {
      // Decompressed file is a Windows executable — determine if it's the QEMU binary
      // itself or an installer (NSIS/Inno etc.)
      const fileStats = await fs.promises.stat(tempPath);
      console.log(`[Sandbox] Decompressed PE file: ${fileStats.size} bytes`);

      // Quick check: try --version to see if it's already a QEMU binary
      const versionProbe = spawnSync(tempPath, ['--version'], { stdio: 'pipe', timeout: 5000 });
      const versionOutput = versionProbe.stdout?.toString().trim() || '';
      console.log(`[Sandbox] PE --version probe: exit=${versionProbe.status}, stdout="${versionOutput.slice(0, 120)}"`);

      if (versionProbe.status === 0 && versionOutput.toLowerCase().includes('qemu')) {
        // It's the QEMU binary itself, not an installer
        console.log('[Sandbox] Downloaded file is a QEMU binary, renaming directly');
        await fs.promises.rename(tempPath, runtimeBinary);
      } else {
        // Treat as an installer (NSIS)
        const installerPath = path.join(runtimeDir, 'qemu-installer.exe');
        await fs.promises.rename(tempPath, installerPath);
        try {
          console.log(`[Sandbox] Running QEMU NSIS installer to: ${runtimeDir}`);
          await runNsisInstaller(installerPath, runtimeDir);
          console.log('[Sandbox] QEMU NSIS installer completed successfully');
        } catch (error) {
          // Log directory contents for debugging
          try {
            const entries = fs.readdirSync(runtimeDir);
            console.log(`[Sandbox] Runtime dir contents after failed install: ${JSON.stringify(entries)}`);
          } catch { /* ignore */ }
          try { await fs.promises.unlink(installerPath); } catch { /* ignore */ }
          throw new Error(
            `Failed to install QEMU: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        // Log directory contents after successful install
        try {
          const entries = fs.readdirSync(runtimeDir);
          console.log(`[Sandbox] Runtime dir contents after install: ${JSON.stringify(entries)}`);
        } catch { /* ignore */ }
        // Clean up the installer executable
        try {
          await fs.promises.unlink(installerPath);
        } catch (error) {
          console.warn('[Sandbox] Failed to remove QEMU installer after installation:', error);
        }
      }
    } else {
      await fs.promises.rename(tempPath, runtimeBinary);
    }
  } else {
    const targetPath = runtimeBinary;
    await fs.promises.rename(archivePath, targetPath);
  }

  const finalBinary = resolveRuntimeBinary(runtimeDir, runtimeBinary);
  if (!finalBinary) {
    // Log directory contents to help diagnose why binary wasn't found
    try {
      const listDir = (dir: string, prefix = ''): string[] => {
        const results: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          results.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
          if (entry.isDirectory()) {
            results.push(...listDir(full, prefix + '  '));
          }
        }
        return results;
      };
      console.log(`[Sandbox] Binary not found. Looking for: ${path.basename(runtimeBinary)}`);
      console.log(`[Sandbox] Runtime dir tree:\n${listDir(runtimeDir).join('\n')}`);
    } catch { /* ignore */ }
    throw new Error('Sandbox runtime binary not found after extraction.');
  }
  console.log(`[Sandbox] Resolved runtime binary: ${finalBinary}`);

  // Log validation result but do not block — errors will surface at VM start time
  const validation = validateQemuBinary(finalBinary);
  if (!validation.valid) {
    console.warn(`[Sandbox] QEMU binary validation warning: ${validation.error}`);
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(finalBinary, 0o755);
    } catch (error) {
      console.warn('Failed to chmod sandbox runtime binary:', error);
    }
  }
  ensureHypervisorEntitlement(finalBinary, runtimeDir);

  return finalBinary;
}

async function ensureImage(): Promise<string> {
  const { imageDir, imagePath } = getSandboxPaths();
  if (fs.existsSync(imagePath)) {
    return imagePath;
  }

  const url = getImageUrl();
  if (!url) {
    const errorMsg = process.platform === 'win32'
      ? 'Windows sandbox image is not yet configured. Please set COWORK_SANDBOX_IMAGE_URL or COWORK_SANDBOX_BASE_URL environment variable, or wait for default Windows image support.'
      : 'Sandbox image download URL is not configured.';
    throw new Error(errorMsg);
  }

  await fs.promises.mkdir(imageDir, { recursive: true });
  const downloadPath = `${imagePath}.download`;
  await downloadFile(url, downloadPath, 'image');
  await verifySha256(downloadPath, getImageSha256());
  await fs.promises.rename(downloadPath, imagePath);
  return imagePath;
}

async function ensureKernel(): Promise<string | null> {
  const override = getKernelPathOverride();
  if (override && fs.existsSync(override)) {
    return override;
  }

  const archVariant = getArchVariant();
  if (!archVariant) return null;

  const { imageDir } = getSandboxPaths();
  const kernelPath = path.join(imageDir, `vmlinuz-virt-${archVariant}`);
  if (fs.existsSync(kernelPath)) {
    return kernelPath;
  }

  const url = getKernelUrl();
  if (!url) return null;
  await fs.promises.mkdir(imageDir, { recursive: true });
  const downloadPath = `${kernelPath}.download`;
  await downloadFile(url, downloadPath, 'image');
  await fs.promises.rename(downloadPath, kernelPath);
  return kernelPath;
}

async function ensureInitrd(): Promise<string | null> {
  const override = getInitrdPathOverride();
  if (override && fs.existsSync(override)) {
    return override;
  }

  const archVariant = getArchVariant();
  if (!archVariant) return null;

  const { imageDir } = getSandboxPaths();
  const initrdPath = path.join(imageDir, `initramfs-virt-${archVariant}`);
  if (fs.existsSync(initrdPath)) {
    return initrdPath;
  }

  const url = getInitrdUrl();
  if (!url) return null;
  await fs.promises.mkdir(imageDir, { recursive: true });
  const downloadPath = `${initrdPath}.download`;
  await downloadFile(url, downloadPath, 'image');
  await fs.promises.rename(downloadPath, initrdPath);
  return initrdPath;
}

function getExistingKernelPath(): string | null {
  const override = getKernelPathOverride();
  if (override && fs.existsSync(override)) {
    return override;
  }

  const archVariant = getArchVariant();
  if (!archVariant) return null;

  const { imageDir } = getSandboxPaths();
  const kernelPath = path.join(imageDir, `vmlinuz-virt-${archVariant}`);
  return fs.existsSync(kernelPath) ? kernelPath : null;
}

function getExistingInitrdPath(): string | null {
  const override = getInitrdPathOverride();
  if (override && fs.existsSync(override)) {
    return override;
  }

  const archVariant = getArchVariant();
  if (!archVariant) return null;

  const { imageDir } = getSandboxPaths();
  const initrdPath = path.join(imageDir, `initramfs-virt-${archVariant}`);
  return fs.existsSync(initrdPath) ? initrdPath : null;
}

function resolveAvailableRuntimeBinary(): string | null {
  const { runtimeDir, runtimeBinary } = getSandboxPaths();
  const localRuntime = resolveRuntimeBinary(runtimeDir, runtimeBinary);
  if (localRuntime) {
    return localRuntime;
  }

  // On Windows, also check for system-installed QEMU (e.g. C:\Program Files\qemu\)
  if (process.platform === 'win32') {
    if (_resolvedSystemQemuPath && fs.existsSync(_resolvedSystemQemuPath)) {
      return _resolvedSystemQemuPath;
    }
    const systemQemu = findSystemQemu();
    if (systemQemu) {
      const validation = validateQemuBinary(systemQemu);
      if (validation.valid && checkQemuVirtfsSupport(systemQemu)) {
        _resolvedSystemQemuPath = systemQemu;
        return systemQemu;
      }
    }
  }

  return null;
}

// Singleton promise for ensureSandboxReady to prevent concurrent installations.
// Two simultaneous NSIS installers writing to the same directory will deadlock.
let _ensureSandboxReadyPromise: Promise<SandboxCheckResult> | null = null;

export function ensureSandboxReady(): Promise<SandboxCheckResult> {
  if (_ensureSandboxReadyPromise) {
    return _ensureSandboxReadyPromise;
  }
  _ensureSandboxReadyPromise = _ensureSandboxReadyImpl();
  _ensureSandboxReadyPromise.finally(() => {
    _ensureSandboxReadyPromise = null;
  });
  return _ensureSandboxReadyPromise;
}

async function _ensureSandboxReadyImpl(): Promise<SandboxCheckResult> {
  const platformKey = getPlatformKey();
  if (!platformKey) {
    return { ok: false, error: 'Sandbox VM is not supported on this platform.' };
  }

  coworkLog('INFO', 'ensureSandboxReady', 'Checking sandbox readiness', {
    platformKey,
    platform: process.platform,
    arch: process.arch,
  });

  try {
    if (!downloadState.runtime) {
      downloadState.runtime = ensureRuntime();
    }
    const runtimeBinary = await downloadState.runtime;
    downloadState.runtime = null;

    if (!downloadState.image) {
      downloadState.image = ensureImage();
    }
    const imagePath = await downloadState.image;
    downloadState.image = null;

    let kernelPath: string | null = null;
    let initrdPath: string | null = null;
    try {
      kernelPath = await ensureKernel();
      initrdPath = await ensureInitrd();
    } catch (error) {
      console.warn('Failed to download sandbox kernel/initrd:', error);
    }

    const { baseDir } = getSandboxPaths();
    downloadState.error = null;
    downloadState.progress = undefined;

    coworkLog('INFO', 'ensureSandboxReady', 'Sandbox ready', {
      runtimeBinary,
      runtimeExists: fs.existsSync(runtimeBinary),
      imagePath,
      imageExists: fs.existsSync(imagePath),
      kernelPath,
      initrdPath,
    });

    return {
      ok: true,
      runtimeInfo: {
        platform: process.platform,
        arch: process.arch,
        runtimeBinary,
        imagePath,
        kernelPath,
        initrdPath,
        baseDir,
      },
    };
  } catch (error) {
    downloadState.error = error instanceof Error ? error.message : String(error);
    downloadState.runtime = null;
    downloadState.image = null;
    coworkLog('ERROR', 'ensureSandboxReady', 'Sandbox not ready', {
      error: downloadState.error,
    });
    return { ok: false, error: downloadState.error };
  }
}

export function getSandboxRuntimeInfoIfReady():
{ ok: true; runtimeInfo: SandboxRuntimeInfo } | { ok: false; error: string } {
  const platformKey = getPlatformKey();
  if (!platformKey) {
    return { ok: false, error: 'Sandbox VM is not supported on this platform.' };
  }

  const runtimeBinary = resolveAvailableRuntimeBinary();
  if (!runtimeBinary) {
    return { ok: false, error: 'Sandbox runtime is not installed.' };
  }

  const { baseDir, imagePath } = getSandboxPaths();
  if (!fs.existsSync(imagePath)) {
    return { ok: false, error: 'Sandbox image is not installed.' };
  }

  return {
    ok: true,
    runtimeInfo: {
      platform: process.platform,
      arch: process.arch,
      runtimeBinary,
      imagePath,
      kernelPath: getExistingKernelPath(),
      initrdPath: getExistingInitrdPath(),
      baseDir,
    },
  };
}

export function getSandboxStatus(): CoworkSandboxStatus {
  const platformKey = getPlatformKey();
  if (!platformKey) {
    return {
      supported: false,
      runtimeReady: false,
      imageReady: false,
      downloading: Boolean(downloadState.runtime || downloadState.image),
      error: downloadState.error,
    };
  }

  const { imagePath } = getSandboxPaths();
  const runtimeReady = Boolean(resolveAvailableRuntimeBinary());

  const imageReady = fs.existsSync(imagePath);

  return {
    supported: true,
    runtimeReady,
    imageReady,
    downloading: Boolean(downloadState.runtime || downloadState.image),
    progress: downloadState.progress,
    error: downloadState.error,
  };
}
