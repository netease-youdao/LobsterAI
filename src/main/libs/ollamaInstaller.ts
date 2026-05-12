import { execFile } from 'child_process';
import { app } from 'electron';
import { createWriteStream } from 'fs';
import { access, mkdtemp, open, readdir, rename, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type { OllamaInstallProgress } from '../../shared/ollama';
import {
  getOllamaInstallConfig,
  getPlatformInstallerFilenames,
  getPlatformPresetDirs,
} from './ollamaInstallConfig';

const execFileAsync = promisify(execFile);
const MIN_INSTALLER_SIZE_BYTES = 1024 * 1024;

type ProgressCallback = (progress: OllamaInstallProgress) => void;

export class OllamaInstaller {
  constructor(private readonly onProgress: ProgressCallback) {}

  async install(): Promise<{ installed: boolean; needsManual?: boolean; installerPath?: string }> {
    const config = getOllamaInstallConfig();
    const downloadsDir = appDownloadsDir();
    const expectedFilenames = getPlatformInstallerFilenames(config);

    this.emitProgress({ phase: 'detecting', message: 'Detecting Ollama installer' });
    const presetInstallerPath = await this.findPresetInstaller(
      expectedFilenames,
      downloadsDir,
      config.mirrorDownload[process.platform],
    );
    const installerPath = presetInstallerPath
      ?? await this.downloadMirrorInstaller(downloadsDir, config.mirrorDownload[process.platform]);

    if (!installerPath) {
      this.emitProgress({
        phase: 'needs-manual',
        message: 'Manual Ollama download is required',
        downloadsDir,
        officialUrl: config.officialUrl,
        expectedFilenames,
      });
      return { installed: false, needsManual: true };
    }

    this.emitProgress({ phase: 'installing', installerPath, message: 'Installing Ollama' });
    await this.runInstaller(installerPath);
    this.emitProgress({ phase: 'done', installerPath, message: 'Ollama installation completed' });
    return { installed: true, installerPath };
  }

  private async findPresetInstaller(
    expectedFilenames: string[],
    downloadsDir: string,
    mirrorUrl?: string,
  ): Promise<string | null> {
    const config = getOllamaInstallConfig();
    let expectedDownloadSize: number | null | undefined;
    const resolvedDownloadsDir = path.resolve(downloadsDir);

    for (const dir of getPlatformPresetDirs(config)) {
      for (const filename of expectedFilenames) {
        const candidate = path.join(dir, filename);
        if (await fileExists(candidate)) {
          const expectedSize = path.resolve(dir) === resolvedDownloadsDir
            ? expectedDownloadSize ??= await getRemoteContentLength(mirrorUrl)
            : null;
          if (!await isUsableInstaller(candidate, filename, expectedSize)) {
            continue;
          }
          this.emitProgress({ phase: 'preset-found', installerPath: candidate, message: 'Found preset installer' });
          return candidate;
        }
      }
    }
    return null;
  }

  private async downloadMirrorInstaller(downloadsDir: string, mirrorUrl?: string): Promise<string | null> {
    if (!mirrorUrl) return null;

    this.emitProgress({ phase: 'downloading', message: 'Downloading Ollama installer' });
    const filename = path.basename(new URL(mirrorUrl).pathname) || getPlatformInstallerFilenames(getOllamaInstallConfig())[0];
    const targetPath = path.join(downloadsDir, filename);
    const tempPath = `${targetPath}.download`;

    try {
      await rm(tempPath, { force: true }).catch(() => undefined);

      const response = await fetch(mirrorUrl);
      if (!response.ok || !response.body) {
        this.emitProgress({ phase: 'failed', error: `Ollama download failed: HTTP ${response.status}` });
        return null;
      }

      const total = Number(response.headers.get('content-length') ?? 0);
      const downloaded = await writeResponseBodyToFile(response.body, tempPath, total, (percent) => {
        this.emitProgress({
          phase: 'downloading-progress',
          percent,
          installerPath: targetPath,
        });
      });
      if (total > 0 && downloaded !== total) {
        throw new Error(`Installer download incomplete: ${downloaded}/${total} bytes`);
      }
      if (!await isUsableInstaller(tempPath, filename, total > 0 ? total : null)) {
        throw new Error('Downloaded installer failed validation');
      }

      await rm(targetPath, { force: true }).catch(() => undefined);
      await rename(tempPath, targetPath);
      return targetPath;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.emitProgress({ phase: 'failed', error: `Ollama download failed: ${message}` });
      return null;
    }
  }

  private async runInstaller(installerPath: string): Promise<void> {
    if (process.platform === 'win32') {
      await execFileAsync(installerPath, ['/SILENT']);
      return;
    }

    if (process.platform === 'darwin') {
      if (installerPath.endsWith('.dmg')) {
        const mountOutput = await execFileAsync('hdiutil', ['attach', installerPath, '-nobrowse']);
        const volumePath = mountOutput.stdout.split('\n')
          .map((line) => line.trim().split(/\s+/).pop())
          .find((part) => part?.startsWith('/Volumes/'));
        if (!volumePath) throw new Error('Unable to locate mounted Ollama volume');
        try {
          await execFileAsync('cp', ['-R', path.join(volumePath, 'Ollama.app'), '/Applications/']);
        } finally {
          await execFileAsync('hdiutil', ['detach', volumePath]).catch(() => undefined);
        }
        return;
      }
      if (installerPath.endsWith('.zip')) {
        const extractDir = await mkdtemp(path.join(os.tmpdir(), 'lobsterai-ollama-'));
        try {
          await execFileAsync('ditto', ['-x', '-k', installerPath, extractDir]);
          const appPath = await findOllamaApp(extractDir);
          if (!appPath) {
            throw new Error('Unable to locate Ollama.app in zip archive');
          }
          await execFileAsync('cp', ['-R', appPath, '/Applications/']);
        } finally {
          await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
        }
        return;
      }
      throw new Error(`Unsupported macOS Ollama installer: ${installerPath}`);
    }

    if (process.platform === 'linux') {
      await execFileAsync('tar', ['-C', '/usr/local', '-xzf', installerPath]);
      return;
    }

    throw new Error(`Unsupported platform for Ollama installer: ${process.platform}`);
  }

  private emitProgress(progress: OllamaInstallProgress): void {
    this.onProgress(progress);
  }
}

function appDownloadsDir(): string {
  return app.getPath('downloads');
}

async function findOllamaApp(dirPath: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() && entry.name === 'Ollama.app' && path.extname(entry.name) === '.app') {
      const appStat = await stat(entryPath).catch(() => null);
      if (appStat?.isDirectory()) return entryPath;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findOllamaApp(path.join(dirPath, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function writeResponseBodyToFile(
  body: ReadableStream<Uint8Array>,
  targetPath: string,
  total: number,
  onProgress: (percent: number) => void,
): Promise<number> {
  const reader = body.getReader();
  const fileStream = createWriteStream(targetPath);
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      await writeChunk(fileStream, value);
      if (total > 0) {
        onProgress(Math.round((downloaded / total) * 100));
      }
    }
    await closeWriteStream(fileStream);
    return downloaded;
  } catch (error) {
    fileStream.destroy();
    throw error;
  }
}

function writeChunk(fileStream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    fileStream.write(Buffer.from(chunk), (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeWriteStream(fileStream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      fileStream.off('error', onError);
      reject(error);
    };
    fileStream.once('error', onError);
    fileStream.end(() => {
      fileStream.off('error', onError);
      resolve();
    });
  });
}

async function isUsableInstaller(filePath: string, filename = filePath, expectedSize?: number | null): Promise<boolean> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) return false;
  if (typeof fileStat.isFile === 'function' && !fileStat.isFile()) return false;
  if (typeof expectedSize === 'number' && expectedSize > 0 && fileStat.size !== expectedSize) return false;
  if (fileStat.size < MIN_INSTALLER_SIZE_BYTES) return false;

  const expectedHeader = getExpectedInstallerHeader(filename);
  if (!expectedHeader) return true;

  const file = await open(filePath, 'r').catch(() => null);
  if (!file) return false;
  try {
    const header = Buffer.alloc(expectedHeader.length);
    const { bytesRead } = await file.read(header, 0, expectedHeader.length, 0);
    if (bytesRead < expectedHeader.length) return false;
    return expectedHeader.every((byte, index) => header[index] === byte);
  } finally {
    await file.close().catch(() => undefined);
  }
}

function getExpectedInstallerHeader(filename: string): number[] | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.exe')) return [0x4d, 0x5a];
  if (lower.endsWith('.zip')) return [0x50, 0x4b];
  if (lower.endsWith('.tgz') || lower.endsWith('.gz')) return [0x1f, 0x8b];
  return null;
}

async function getRemoteContentLength(url?: string): Promise<number | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return null;
    const value = Number(response.headers.get('content-length') ?? 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
