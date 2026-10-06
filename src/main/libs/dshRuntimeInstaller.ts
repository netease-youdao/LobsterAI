// Installs a packed dsh runtime archive into a writable base directory (the
// packaged app uses userData/dsh-runtime).
//
// An install is driven by a self-contained artifact descriptor — version,
// target, sha256, size, and exactly one source (an absolute URL or a local
// file). Nothing is derived by joining paths, so each archive can live at an
// arbitrary, unrelated URL.
//
// Production descriptors ship inside the app (package.json `dsh.runtimes`)
// rather than being fetched next to the archive. That is what makes the digest
// check meaningful: a digest fetched from the same host as the archive can be
// replaced together with it.
//
// No Electron imports here so the whole install path stays scriptable and
// unit testable.

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';

import { DshInstallStage } from '../../shared/dshEngine/constants';
import { validateDshRuntimeLayout } from './dshRuntime';
import { safelyReplaceTextFileSync } from './safeFileReplace';

const INSTALL_SENTINEL = '.lobsterai-install-ok.json';
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface DshRuntimeManifest {
  version: string;
  target: string;
  archive: string;
  sha256: string;
  size: number;
  patchHash?: string;
}

/** Everything needed to fetch and trust one runtime archive. */
export interface DshRuntimeArtifact {
  version: string;
  target: string;
  sha256: string;
  size: number;
  /** Absolute http(s) URL of the archive; no path is appended to it. */
  url?: string;
  /** Local archive path, used by dev builds and offline packaging. */
  filePath?: string;
}

export interface DshRuntimeInstallResult {
  root: string;
  version: string;
  alreadyInstalled: boolean;
}

export interface DshRuntimeIdentityExpectation {
  target?: string;
  sha256?: string;
}

interface DshRuntimeInstallSentinel {
  installedAt: string;
  lastReadyAt?: string | null;
  version: string;
  target?: string;
  sha256: string;
}

export interface DshRuntimePruneResult {
  retained: string[];
  removed: string[];
}

export type DshInstallProgress =
  | { stage: typeof DshInstallStage.Manifest }
  | { stage: typeof DshInstallStage.Download; receivedBytes: number; totalBytes: number }
  | { stage: typeof DshInstallStage.Verify }
  | { stage: typeof DshInstallStage.Extract };

export function parseDshRuntimeManifest(raw: string): DshRuntimeManifest | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.version !== 'string' ||
      typeof record.target !== 'string' ||
      typeof record.archive !== 'string' ||
      typeof record.sha256 !== 'string' ||
      typeof record.size !== 'number'
    ) {
      return null;
    }
    if (record.archive.includes('/') || record.archive.includes('\\') || record.archive.includes('..')) {
      return null;
    }
    return {
      version: record.version,
      target: record.target,
      archive: record.archive,
      sha256: record.sha256.toLowerCase(),
      size: record.size,
      patchHash: typeof record.patchHash === 'string' ? record.patchHash : undefined,
    };
  } catch {
    return null;
  }
}

export function isHttpSource(base: string): boolean {
  return /^https?:\/\//i.test(base);
}

// Windows ships bsdtar as %SystemRoot%\System32\tar.exe. Naming it outright
// keeps the extract off whatever `tar` happens to come first on PATH: GNU tar
// (Git for Windows, MSYS2, Cygwin — all common on dev machines) reads an
// archive path like `C:\Users\...` as `host:file` and fails the install with
// "Cannot connect to C: resolve failed". Elsewhere, and if the system copy is
// missing, PATH lookup is the right answer.
export function resolveTarCommand(
  platform: NodeJS.Platform,
  exists: (absolutePath: string) => boolean,
  systemRoot: string | undefined
): string {
  if (platform !== 'win32') return 'tar';
  // Build with the Windows joiner explicitly: this path targets win32 even when
  // resolveTarCommand runs on a posix host (e.g. tests), where the default
  // `path.join` would use posix separators and produce a path that never matches.
  const systemTar = path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return exists(systemTar) ? systemTar : 'tar';
}

export function installedDshRuntimeRoot(baseDir: string, version: string): string {
  return path.join(baseDir, version);
}

function readDshRuntimeInstallSentinel(root: string): DshRuntimeInstallSentinel | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, INSTALL_SENTINEL), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.installedAt !== 'string' ||
      typeof record.version !== 'string' ||
      typeof record.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(record.sha256)
    ) {
      return null;
    }
    let lastReadyAt: string | null | undefined;
    if (Object.prototype.hasOwnProperty.call(record, 'lastReadyAt')) {
      const value = record.lastReadyAt;
      if (value === null) lastReadyAt = null;
      else if (typeof value === 'string') lastReadyAt = value;
      else return null;
    }
    return {
      installedAt: record.installedAt,
      lastReadyAt,
      version: record.version,
      target: typeof record.target === 'string' ? record.target : undefined,
      sha256: record.sha256.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function markInstalledDshRuntimeReady(
  baseDir: string,
  version: string,
  expectation: DshRuntimeIdentityExpectation = {}
): boolean {
  const root = resolveInstalledDshRuntime(baseDir, version, expectation);
  if (!root) return false;
  const sentinel = readDshRuntimeInstallSentinel(root);
  if (!sentinel) return false;
  safelyReplaceTextFileSync({
    filePath: path.join(root, INSTALL_SENTINEL),
    content: `${JSON.stringify({ ...sentinel, lastReadyAt: new Date().toISOString() }, null, 2)}\n`,
    mode: 0o600,
    tempLabel: 'ready',
  });
  return true;
}

// A runtime counts as installed only when the install sentinel exists and the
// layout still passes — a torn extract or a user-deleted node_modules must
// read as "not installed" so the next install repairs it.
export function resolveInstalledDshRuntime(
  baseDir: string,
  version: string,
  expectation: DshRuntimeIdentityExpectation = {}
): string | null {
  const root = installedDshRuntimeRoot(baseDir, version);
  const sentinel = readDshRuntimeInstallSentinel(root);
  if (!sentinel || sentinel.version !== version) return null;
  if (expectation.sha256 && sentinel.sha256 !== expectation.sha256.toLowerCase()) return null;

  let buildTarget: string | undefined;
  let buildVersion: string | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'runtime-build-info.json'), 'utf8')) as Record<string, unknown>;
    buildTarget = typeof parsed.target === 'string' ? parsed.target : undefined;
    buildVersion = typeof parsed.dshVersion === 'string' ? parsed.dshVersion : undefined;
  } catch {
    // Older archives can rely on the signed install sentinel alone.
  }
  if (buildVersion && buildVersion !== version) return null;
  if (expectation.target && (sentinel.target ?? buildTarget) !== expectation.target) return null;

  const layout = validateDshRuntimeLayout(root, fs.existsSync, path.join);
  return layout.ok ? root : null;
}

// Keep the active pinned runtime plus a bounded number of prior valid installs.
// Ordering uses the install timestamp, never the version string: lexicographic
// sorting puts rc.9 after rc.10 and can also select a runtime from a newer app
// after the user downgrades LobsterAI.
export async function pruneInstalledDshRuntimes(
  baseDir: string,
  currentVersion: string,
  retainPrevious = 1
): Promise<DshRuntimePruneResult> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return { retained: [], removed: [] };
  }

  const installed = entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.staging'))
    .map((entry) => {
      const root = resolveInstalledDshRuntime(baseDir, entry.name);
      if (!root) return null;
      const sentinel = readDshRuntimeInstallSentinel(root);
      if (!sentinel) return null;
      const parsedInstalledAt = Date.parse(sentinel.installedAt);
      const installedAt = Number.isFinite(parsedInstalledAt)
        ? parsedInstalledAt
        : fs.statSync(path.join(root, INSTALL_SENTINEL)).mtimeMs;
      const parsedLastReadyAt = typeof sentinel.lastReadyAt === 'string' ? Date.parse(sentinel.lastReadyAt) : NaN;
      const rollbackAt =
        sentinel.lastReadyAt === null
          ? null
          : Number.isFinite(parsedLastReadyAt)
            ? parsedLastReadyAt
            : installedAt;
      return { root, version: entry.name, installedAt, rollbackAt };
    })
    .filter(
      (entry): entry is { root: string; version: string; installedAt: number; rollbackAt: number | null } => entry !== null
    );

  const previous = installed
    .filter((entry) => entry.version !== currentVersion && entry.rollbackAt !== null)
    .sort(
      (a, b) =>
        (b.rollbackAt as number) - (a.rollbackAt as number) ||
        b.version.localeCompare(a.version, undefined, { numeric: true })
    );
  const keep = new Set([currentVersion, ...previous.slice(0, Math.max(0, retainPrevious)).map((entry) => entry.version)]);
  const removed: string[] = [];
  for (const entry of installed) {
    if (keep.has(entry.version)) continue;
    await fs.promises.rm(entry.root, { recursive: true, force: true });
    removed.push(entry.version);
  }
  return {
    retained: installed.filter((entry) => keep.has(entry.version)).map((entry) => entry.version),
    removed,
  };
}

// Builds an artifact from the app's own configuration (package.json
// `dsh.runtimes[target]`), the production path. Each target names one absolute
// URL, so a CDN that hands out an unrelated URL per file works unchanged.
export function resolveDshArtifactFromConfig(
  runtimes: unknown,
  target: string,
  version: string
): DshRuntimeArtifact | null {
  if (!runtimes || typeof runtimes !== 'object') return null;
  const entry = (runtimes as Record<string, unknown>)[target];
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.url !== 'string' || !isHttpSource(record.url)) return null;
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(record.sha256)) return null;
  if (typeof record.size !== 'number' || !Number.isInteger(record.size) || record.size <= 0) return null;
  return { version, target, sha256: record.sha256.toLowerCase(), size: record.size, url: record.url };
}

// Builds an artifact from a manifest written by scripts/pack-dsh-runtime.cjs.
// Used for dev builds, offline packaging, and the end-to-end test, where the
// archive really does sit beside its manifest.
export function resolveDshArtifactFromManifest(distDir: string, manifestName: string): DshRuntimeArtifact {
  const manifestPath = path.join(distDir, manifestName);
  const manifest = parseDshRuntimeManifest(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest) throw new Error(`Invalid dsh runtime manifest at ${manifestPath}`);
  return {
    version: manifest.version,
    target: manifest.target,
    sha256: manifest.sha256,
    size: manifest.size,
    filePath: path.join(distDir, manifest.archive),
  };
}

export async function installDshRuntime(options: {
  artifact: DshRuntimeArtifact;
  baseDir: string;
  expectedTarget: string;
  onProgress?: (progress: DshInstallProgress) => void;
}): Promise<DshRuntimeInstallResult> {
  const { artifact, baseDir, expectedTarget, onProgress } = options;

  if (artifact.target !== expectedTarget) {
    throw new Error(`Artifact target ${artifact.target} does not match expected ${expectedTarget}`);
  }
  if (!artifact.url && !artifact.filePath) {
    throw new Error(`Artifact for ${artifact.target} names neither a url nor a filePath`);
  }

  const existing = resolveInstalledDshRuntime(baseDir, artifact.version, {
    target: expectedTarget,
    sha256: artifact.sha256,
  });
  if (existing) {
    return { root: existing, version: artifact.version, alreadyInstalled: true };
  }

  fs.mkdirSync(baseDir, { recursive: true });
  const archiveTempPath = path.join(baseDir, `.download-${process.pid}-${artifact.version}-${artifact.target}.tar.gz`);
  const stagingRoot = `${installedDshRuntimeRoot(baseDir, artifact.version)}.staging`;
  try {
    onProgress?.({ stage: DshInstallStage.Manifest });
    if (artifact.url) {
      await httpGetToFile(artifact.url, archiveTempPath, artifact.size, onProgress);
    } else {
      await fs.promises.copyFile(artifact.filePath as string, archiveTempPath);
      onProgress?.({ stage: DshInstallStage.Download, receivedBytes: artifact.size, totalBytes: artifact.size });
    }

    onProgress?.({ stage: DshInstallStage.Verify });
    const actualSize = fs.statSync(archiveTempPath).size;
    if (actualSize !== artifact.size) {
      throw new Error(`Archive size mismatch: expected ${artifact.size}, got ${actualSize}`);
    }
    const actualSha = await sha256OfFile(archiveTempPath);
    if (actualSha !== artifact.sha256) {
      throw new Error(`Archive sha256 mismatch: expected ${artifact.sha256}, got ${actualSha}`);
    }

    onProgress?.({ stage: DshInstallStage.Extract });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true });
    // No shell: the paths below are absolute and may contain spaces, which a
    // shell would re-split.
    const tarCommand = resolveTarCommand(process.platform, fs.existsSync, process.env.SystemRoot);
    await extractTarArchive(tarCommand, archiveTempPath, stagingRoot);

    const layout = validateDshRuntimeLayout(stagingRoot, fs.existsSync, path.join);
    if (!layout.ok) {
      throw new Error(`Extracted runtime is incomplete, missing: ${layout.missing.join(', ')}`);
    }

    fs.writeFileSync(
      path.join(stagingRoot, INSTALL_SENTINEL),
      `${JSON.stringify(
        {
          installedAt: new Date().toISOString(),
          lastReadyAt: null,
          version: artifact.version,
          target: artifact.target,
          sha256: artifact.sha256,
        },
        null,
        2
      )}\n`
    );

    const finalRoot = installedDshRuntimeRoot(baseDir, artifact.version);
    fs.rmSync(finalRoot, { recursive: true, force: true });
    fs.renameSync(stagingRoot, finalRoot);
    return { root: finalRoot, version: artifact.version, alreadyInstalled: false };
  } finally {
    fs.rmSync(archiveTempPath, { force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

// Async on purpose: a runtime archive takes seconds to unpack, and the install
// runs in the Electron main process, where a synchronous child would freeze
// IPC, the gateway client, and the UI for that whole time.
function extractTarArchive(tarCommand: string, archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand, ['-xzf', archivePath, '-C', destDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      reject(new Error(`tar extract could not start (${tarCommand}): ${error.message}`));
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tar extract failed: ${stderr.slice(0, 500)}`));
    });
  });
}

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function httpGetToFile(
  url: string,
  destPath: string,
  totalBytes: number,
  onProgress?: (progress: DshInstallProgress) => void,
  redirectsLeft = MAX_REDIRECTS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        resolve(httpGetToFile(new URL(response.headers.location, url).toString(), destPath, totalBytes, onProgress, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onProgress?.({ stage: DshInstallStage.Download, receivedBytes: received, totalBytes });
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`Timeout downloading ${url}`)));
    request.on('error', reject);
  });
}
