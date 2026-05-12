import crypto from 'crypto';
import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  type AppUpdateCheckResult,
  type AppUpdateInfo,
  AppUpdateIpc,
  type AppUpdateRuntimeState,
  AppUpdateSource,
  AppUpdateStatus,
} from '../../shared/appUpdate/constants';
import type { SqliteStore } from '../sqliteStore';
import { downloadUpdate } from './appUpdateInstaller';

type ChangeLogLang = {
  title?: string;
  content?: string[];
};

type PlatformDownload = {
  url?: string;
};

type UpdateApiResponse = {
  code?: number;
  data?: {
    value?: {
      version?: string;
      date?: string;
      changeLog?: {
        ch?: ChangeLogLang;
        en?: ChangeLogLang;
      };
      macIntel?: PlatformDownload;
      macArm?: PlatformDownload;
      windowsX64?: PlatformDownload;
    };
  };
};

const APP_UPDATE_TEST_CURRENT_VERSION_ENV = 'LOBSTERAI_UPDATE_CURRENT_VERSION';
const APP_UPDATE_READY_FILE_KEY_PREFIX = 'app_update_ready_file';

type StoredReadyFile = {
  version: string;
  filePath: string;
  fileHash: string;
  info?: AppUpdateInfo;
};

const initialState = (): AppUpdateRuntimeState => ({
  status: AppUpdateStatus.Idle,
  source: null,
  info: null,
  progress: null,
  readyFilePath: null,
  readyFileHash: null,
  errorMessage: null,
});

export class AppUpdateCoordinator {
  private state: AppUpdateRuntimeState = initialState();
  private readonly store: SqliteStore;
  private autoOpenReadyModal = false;
  private flowSequence = 0;
  private activeFlowId = 0;
  private activeFlowSource: AppUpdateSource | null = null;

  constructor(store: SqliteStore) {
    this.store = store;
    this.restoreStoredReadyState();
  }

  getState(): AppUpdateRuntimeState {
    return { ...this.state };
  }

  shouldAutoOpenReadyModal(): boolean {
    return this.autoOpenReadyModal;
  }

  consumeAutoOpenReadyModal(): void {
    this.autoOpenReadyModal = false;
  }

  async checkNow(_options?: { manual?: boolean; userId?: string | null }): Promise<AppUpdateCheckResult> {
    console.log('[AppUpdate] update system is disabled');
    const state = this.resetToIdle();
    return { success: true, state, updateFound: false };
  }

  async retryDownload(): Promise<AppUpdateRuntimeState> {
    return this.getState();
  }

  cancelDownload(): AppUpdateRuntimeState {
    return this.getState();
  }

  async installReadyUpdate(): Promise<{
    success: boolean;
    state: AppUpdateRuntimeState;
    error?: string;
  }> {
    return {
      success: false,
      state: this.getState(),
      error: 'Update system is disabled',
    };
  }

  private resetToIdle(): AppUpdateRuntimeState {
    const previousReadyFilePath = this.state.readyFilePath;
    const previousSource = this.state.source;
    const state = this.setState(initialState());
    if (previousReadyFilePath) {
      void this.cleanupReadyFile(previousReadyFilePath);
    }
    this.clearStoredReadyFile(previousSource);
    return state;
  }

  private async startDownload(
    info: AppUpdateInfo,
    flowId: number,
    source: AppUpdateSource,
  ): Promise<AppUpdateRuntimeState> {
    console.log(
      `[AppUpdate] startDownload requested, flowId=${flowId}, source=${source}, version=${info.latestVersion}, url=${info.url}`,
    );
    this.setState({
      status: AppUpdateStatus.Downloading,
      source,
      info,
      progress: null,
      readyFilePath: null,
      readyFileHash: null,
      errorMessage: null,
    });

    try {
      const filePath = await downloadUpdate(info.url, source, progress => {
        if (!this.isFlowActive(flowId, source)) {
          console.log(
            `[AppUpdate] ignoring stale download progress, flowId=${flowId}, source=${source}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
          );
          return;
        }
        this.setState({
          ...this.state,
          status: AppUpdateStatus.Downloading,
          source,
          info,
          progress,
          errorMessage: null,
        });
      });
      if (!this.isFlowActive(flowId, source)) {
        console.log(
          `[AppUpdate] ignoring stale download completion, flowId=${flowId}, source=${source}, filePath=${filePath}`,
        );
        return this.getState();
      }

      const fileHash = await this.computeFileHash(filePath);
      console.log(
        `[AppUpdate] download completed, flowId=${flowId}, source=${source}, version=${info.latestVersion}, filePath=${filePath}, fileHash=${fileHash}`,
      );
      this.setStoredReadyFile({
        version: info.latestVersion,
        filePath,
        fileHash,
        info,
      });
      await this.pruneCachedInstallerFiles(source, [filePath]);
      this.autoOpenReadyModal = true;
      return this.setState({
        status: AppUpdateStatus.Ready,
        source,
        info,
        progress: null,
        readyFilePath: filePath,
        readyFileHash: fileHash,
        errorMessage: null,
      });
    } catch (error) {
      if (!this.isFlowActive(flowId, source)) {
        console.log(
          `[AppUpdate] ignoring stale download failure, flowId=${flowId}, source=${source}, error=${error instanceof Error ? error.message : String(error)}`,
        );
        return this.getState();
      }
      const cancelled = error instanceof Error && error.message === 'Download cancelled';
      if (cancelled) {
        console.log(`[AppUpdate] download cancelled for active flow, flowId=${flowId}, source=${source}`);
        this.clearStoredReadyFile(source);
        return this.setState({
          status: AppUpdateStatus.Available,
          source,
          info,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: null,
        });
      }

      console.error('[AppUpdate] background download failed:', error);
      this.clearStoredReadyFile(source);
      return this.setState({
        status: AppUpdateStatus.Error,
        source,
        info,
        progress: null,
        readyFilePath: null,
        readyFileHash: null,
        errorMessage: error instanceof Error ? error.message : 'Download failed',
      });
    }
  }

  private async fetchUpdateInfo(
    _currentVersion: string,
    _manual: boolean,
    _userId?: string | null,
  ): Promise<AppUpdateInfo | null> {
    return null;
  }

  private getPlatformDownloadUrl(
    value: NonNullable<NonNullable<UpdateApiResponse['data']>['value']> | undefined,
  ): string {
    if (process.platform === 'darwin') {
      const download = process.arch === 'arm64' ? value?.macArm : value?.macIntel;
      return download?.url?.trim() || '';
    }

    if (process.platform === 'win32') {
      return value?.windowsX64?.url?.trim() || '';
    }

    return '';
  }

  private canPredownload(url: string): boolean {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return false;
    }
    return this.isDirectInstallerUrl(url);
  }

  private isDirectInstallerUrl(url: string): boolean {
    if (!url || url.includes('#') || url.endsWith('/download-list')) {
      return false;
    }
    const normalizedPath = new URL(url).pathname.toLowerCase();
    if (process.platform === 'darwin') {
      return normalizedPath.endsWith('.dmg');
    }
    if (process.platform === 'win32') {
      return normalizedPath.endsWith('.exe');
    }
    return false;
  }

  private isUpdateDisabled(): boolean {
    return true;
  }

  private resolveCurrentVersion(): string {
    const overriddenVersion = process.env[APP_UPDATE_TEST_CURRENT_VERSION_ENV]?.trim();
    if (overriddenVersion) {
      console.log(
        `[AppUpdate] using overridden current version from ${APP_UPDATE_TEST_CURRENT_VERSION_ENV}: ${overriddenVersion}`,
      );
      return overriddenVersion;
    }

    return app.getVersion();
  }

  private isNewerVersion(latestVersion: string, currentVersion: string): boolean {
    return this.compareVersions(latestVersion, currentVersion) > 0;
  }

  private compareVersions(a: string, b: string): number {
    const aParts = this.toVersionParts(a);
    const bParts = this.toVersionParts(b);
    const maxLength = Math.max(aParts.length, bParts.length);

    for (let index = 0; index < maxLength; index += 1) {
      const left = aParts[index] ?? 0;
      const right = bParts[index] ?? 0;
      if (left > right) return 1;
      if (left < right) return -1;
    }

    return 0;
  }

  private toVersionParts(version: string): number[] {
    return version.split('.').map(part => {
      const match = part.trim().match(/^\d+/);
      return match ? Number.parseInt(match[0], 10) : 0;
    });
  }

  private setState(nextState: AppUpdateRuntimeState): AppUpdateRuntimeState {
    this.state = { ...nextState };
    const snapshot = this.getState();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AppUpdateIpc.StateChanged, snapshot);
      }
    }
    return snapshot;
  }

  private beginFlow(source: AppUpdateSource, reason: string): number {
    const flowId = ++this.flowSequence;
    this.activeFlowId = flowId;
    this.activeFlowSource = source;
    console.log(`[AppUpdate] begin flow, flowId=${flowId}, source=${source}, reason=${reason}`);
    return flowId;
  }

  private isFlowActive(flowId: number, source: AppUpdateSource): boolean {
    return this.activeFlowId === flowId && this.activeFlowSource === source;
  }

  private async cleanupReadyFile(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Best effort cleanup only.
    }
  }

  private getUpdateCacheDir(): string {
    return path.join(app.getPath('userData'), 'updates');
  }

  private isCachedInstallerForSource(filename: string, source: AppUpdateSource | null): boolean {
    if (!filename.startsWith('lobsterai-update-')) {
      return false;
    }
    if (source == null) {
      return true;
    }
    if (filename.startsWith(`lobsterai-update-${source}-`)) {
      return true;
    }
    return /^lobsterai-update-\d+/.test(filename);
  }

  private async pruneCachedInstallerFiles(
    source: AppUpdateSource | null,
    keepFilePaths: string[] = [],
  ): Promise<void> {
    const keepSet = new Set(keepFilePaths.filter(Boolean).map(filePath => path.resolve(filePath)));
    const cacheDir = this.getUpdateCacheDir();

    try {
      const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (!this.isCachedInstallerForSource(entry.name, source)) {
          continue;
        }
        const entryPath = path.resolve(cacheDir, entry.name);
        if (keepSet.has(entryPath)) {
          continue;
        }
        await fs.promises.unlink(entryPath).catch(() => {});
        console.log(`[AppUpdate] pruned cached installer file: ${entryPath}`);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn('[AppUpdate] failed to prune cached installer files:', error);
      }
    }
  }

  private async resolveMatchingReadyFile(
    previousState: AppUpdateRuntimeState,
    targetSource: AppUpdateSource,
    latestVersion: string,
  ): Promise<StoredReadyFile | null> {
    console.log(
      `[AppUpdate] resolveMatchingReadyFile started, targetSource=${targetSource}, previousStatus=${previousState.status}, previousSource=${previousState.source ?? 'none'}, previousVersion=${previousState.info?.latestVersion ?? 'none'}, latestVersion=${latestVersion}`,
    );
    const inMemoryReadyFile =
      previousState.source === targetSource &&
      previousState.status === AppUpdateStatus.Ready &&
      previousState.info?.latestVersion === latestVersion &&
      previousState.readyFilePath != null &&
      previousState.readyFileHash != null
        ? {
            version: latestVersion,
            filePath: previousState.readyFilePath,
            fileHash: previousState.readyFileHash,
          }
        : null;

    if (inMemoryReadyFile) {
      console.log(
        `[AppUpdate] checking in-memory ready file: ${inMemoryReadyFile.filePath}`,
      );
      const isValid = await this.isReadyFileValid(
        inMemoryReadyFile.filePath,
        inMemoryReadyFile.fileHash,
      );
      if (isValid) {
        console.log('[AppUpdate] in-memory ready file is valid');
        return inMemoryReadyFile;
      }
      console.warn('[AppUpdate] in-memory ready file is invalid');
    }

    const storedReadyFile = this.getStoredReadyFile(targetSource);
    if (!storedReadyFile || storedReadyFile.version !== latestVersion) {
      console.log(
        `[AppUpdate] stored ready file mismatch, targetSource=${targetSource}, storedVersion=${storedReadyFile?.version ?? 'none'}, latestVersion=${latestVersion}`,
      );
      return null;
    }

    console.log(
      `[AppUpdate] checking persisted ready file: ${storedReadyFile.filePath}`,
    );
    const isValid = await this.isReadyFileValid(
      storedReadyFile.filePath,
      storedReadyFile.fileHash,
    );
    if (isValid) {
      console.log('[AppUpdate] persisted ready file is valid');
      return storedReadyFile;
    }

    console.warn(
      `[AppUpdate] persisted ready file is invalid, deleting: ${storedReadyFile.filePath}`,
    );
    await this.cleanupReadyFile(storedReadyFile.filePath);
    this.clearStoredReadyFile(targetSource);
    return null;
  }

  private async isReadyFileValid(filePath: string, expectedHash: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size <= 0) {
        console.warn(
          `[AppUpdate] ready file validation failed: file missing or empty, path=${filePath}`,
        );
        return false;
      }
      const actualHash = await this.computeFileHash(filePath);
      if (actualHash !== expectedHash) {
        console.warn(
          `[AppUpdate] ready file validation failed: hash mismatch, path=${filePath}, expectedHash=${expectedHash}, actualHash=${actualHash}`,
        );
      }
      return actualHash === expectedHash;
    } catch {
      console.warn(
        `[AppUpdate] ready file validation failed: stat/hash threw, path=${filePath}`,
      );
      return false;
    }
  }

  private async computeFileHash(filePath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('error', reject);
      stream.on('data', chunk => {
        hash.update(chunk);
      });
      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });
    });
  }

  private restoreStoredReadyState(): void {
    const sources: AppUpdateSource[] = [AppUpdateSource.Manual, AppUpdateSource.Auto];
    let restored = false;

    for (const source of sources) {
      const storedReadyFile = this.getStoredReadyFile(source);
      if (!storedReadyFile) {
        continue;
      }

      console.log(
        `[AppUpdate] restoring persisted ready file, source=${source}, version=${storedReadyFile.version}, filePath=${storedReadyFile.filePath}`,
      );

      if (this.compareVersions(storedReadyFile.version, this.resolveCurrentVersion()) <= 0) {
        console.log(
          `[AppUpdate] persisted ready file is not newer than current version, clearing it: source=${source}, storedVersion=${storedReadyFile.version}, currentVersion=${this.resolveCurrentVersion()}`,
        );
        this.clearStoredReadyFile(source);
        void this.pruneCachedInstallerFiles(source);
        continue;
      }

      try {
        const stat = fs.statSync(storedReadyFile.filePath);
        if (!stat.isFile() || stat.size <= 0) {
          console.warn(
            `[AppUpdate] persisted ready file is missing or empty during startup restore: ${storedReadyFile.filePath}`,
          );
          this.clearStoredReadyFile(source);
          void this.pruneCachedInstallerFiles(source);
          continue;
        }
      } catch {
        console.warn(
          `[AppUpdate] persisted ready file stat failed during startup restore: ${storedReadyFile.filePath}`,
        );
        this.clearStoredReadyFile(source);
        void this.pruneCachedInstallerFiles(source);
        continue;
      }

      this.state = {
        status: AppUpdateStatus.Ready,
        source,
        info: storedReadyFile.info ?? this.createStoredReadyInfo(storedReadyFile.version),
        progress: null,
        readyFilePath: storedReadyFile.filePath,
        readyFileHash: storedReadyFile.fileHash,
        errorMessage: null,
      };
      void this.pruneCachedInstallerFiles(source, [storedReadyFile.filePath]);
      console.log(
        `[AppUpdate] restored ready update into runtime state, source=${source}, version=${this.state.info?.latestVersion ?? 'none'}, filePath=${this.state.readyFilePath ?? 'none'}`,
      );
      restored = true;
      break;
    }

    if (!restored) {
      console.log('[AppUpdate] no persisted ready file found during startup restore');
      void this.pruneCachedInstallerFiles(AppUpdateSource.Manual);
      void this.pruneCachedInstallerFiles(AppUpdateSource.Auto);
    }
  }

  private createStoredReadyInfo(version: string): AppUpdateInfo {
    return {
      latestVersion: version,
      date: '',
      changeLog: {
        zh: { title: '', content: [] },
        en: { title: '', content: [] },
      },
      url: '',
    };
  }

  private getReadyFileStoreKey(source: AppUpdateSource | null): string {
    return `${APP_UPDATE_READY_FILE_KEY_PREFIX}:${source ?? 'unknown'}`;
  }

  private getStoredReadyFile(source: AppUpdateSource | null): StoredReadyFile | null {
    try {
      const key = this.getReadyFileStoreKey(source);
      const value = this.store.get<StoredReadyFile>(key);
      if (!value?.version || !value.filePath || !value.fileHash) {
        console.log('[AppUpdate] persisted ready file record is missing required fields');
        return null;
      }
      console.log(
        `[AppUpdate] loaded persisted ready file record, source=${source ?? 'unknown'}, version=${value.version}, filePath=${value.filePath}`,
      );
      return value;
    } catch (error) {
      console.warn('[AppUpdate] failed to read stored ready file:', error);
      return null;
    }
  }

  private setStoredReadyFile(value: StoredReadyFile): void {
    try {
      const source = this.state.source ?? AppUpdateSource.Auto;
      this.store.set(this.getReadyFileStoreKey(source), value);
      console.log(
        `[AppUpdate] persisted ready file record, source=${source}, version=${value.version}, filePath=${value.filePath}`,
      );
    } catch (error) {
      console.warn('[AppUpdate] failed to persist ready file:', error);
    }
  }

  private clearStoredReadyFile(source: AppUpdateSource | null): void {
    if (source == null) {
      return;
    }
    try {
      this.store.delete(this.getReadyFileStoreKey(source));
      console.log(`[AppUpdate] cleared persisted ready file record for source=${source}`);
    } catch (error) {
      console.warn('[AppUpdate] failed to clear stored ready file:', error);
    }
  }
}
