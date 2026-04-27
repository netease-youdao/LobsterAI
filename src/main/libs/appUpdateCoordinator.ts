import crypto from 'crypto';
import { app, BrowserWindow, session } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  type AppUpdateCheckResult,
  type AppUpdateInfo,
  AppUpdateIpc,
  AppUpdateSource,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
} from '../../shared/appUpdate/constants';
import type { SqliteStore } from '../sqliteStore';
import { cancelActiveDownload, downloadUpdate, installUpdate } from './appUpdateInstaller';
import { getFallbackDownloadUrl, getManualUpdateCheckUrl, getUpdateCheckUrl } from './endpoints';

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

const INSTALLATION_UUID_KEY = 'installation_uuid';
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

  async checkNow(options?: { manual?: boolean; userId?: string | null }): Promise<AppUpdateCheckResult> {
    const targetSource = options?.manual === true ? AppUpdateSource.Manual : AppUpdateSource.Auto;
    console.log(
      `[AppUpdate] checkNow started, manual=${options?.manual === true}, status=${this.state.status}, source=${this.state.source ?? 'none'}, readyFilePath=${this.state.readyFilePath ?? 'none'}`,
    );
    if (this.isUpdateDisabled()) {
      console.log('[AppUpdate] updates are disabled by enterprise config');
      const state = this.resetToIdle();
      return { success: true, state, updateFound: false };
    }

    if (options?.manual === true && this.state.source === AppUpdateSource.Auto) {
      if (this.state.status === AppUpdateStatus.Downloading) {
        console.log('[AppUpdate] manual check is preempting active auto download');
        const cancelled = cancelActiveDownload();
        console.log(`[AppUpdate] auto download cancel requested by manual check, cancelled=${cancelled}`);
      } else if (this.state.status === AppUpdateStatus.Checking) {
        console.log('[AppUpdate] manual check is preempting active auto check before download');
      } else if (this.state.status === AppUpdateStatus.Installing) {
        console.log('[AppUpdate] manual check cannot preempt auto install already in progress');
        return { success: true, state: this.getState(), updateFound: this.state.info !== null };
      }
    }

    if (
      (this.state.status === AppUpdateStatus.Downloading || this.state.status === AppUpdateStatus.Installing) &&
      this.state.source === targetSource
    ) {
      console.log(`[AppUpdate] returning existing active ${targetSource} flow without starting a new check`);
      return { success: true, state: this.getState(), updateFound: this.state.info !== null };
    }

    const previousState = this.getState();
    const flowId = this.beginFlow(
      targetSource,
      options?.manual === true ? 'manual-check' : 'auto-check',
    );
    this.setState({
      ...this.state,
      status: AppUpdateStatus.Checking,
      source: targetSource,
      errorMessage: null,
    });

    try {
      const currentVersion = this.resolveCurrentVersion();
      const info = await this.fetchUpdateInfo(currentVersion, options?.manual === true, options?.userId);
      if (!this.isFlowActive(flowId, targetSource)) {
        console.log(
          `[AppUpdate] ignoring stale check result after fetch, flowId=${flowId}, source=${targetSource}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
        );
        return { success: true, state: this.getState(), updateFound: this.getState().info !== null };
      }
      if (!info) {
        if (
          previousState.source === targetSource &&
          previousState.status === AppUpdateStatus.Ready &&
          previousState.readyFilePath != null &&
          previousState.readyFileHash != null &&
          previousState.info != null &&
          this.compareVersions(previousState.info.latestVersion, currentVersion) > 0
        ) {
          console.log(
            `[AppUpdate] no update from server, preserving existing ready update ${previousState.info.latestVersion}`,
          );
          const state = this.setState({
            ...previousState,
            errorMessage: null,
          });
          return { success: true, state, updateFound: true };
        }
        const state = this.setState({
          ...initialState(),
          source: targetSource,
        });
        return { success: true, state, updateFound: false };
      }

      const updateFound = true;
      const matchingReadyFile = await this.resolveMatchingReadyFile(
        previousState,
        targetSource,
        info.latestVersion,
      );
      if (!this.isFlowActive(flowId, targetSource)) {
        console.log(
          `[AppUpdate] ignoring stale check result after ready-file resolution, flowId=${flowId}, source=${targetSource}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
        );
        return { success: true, state: this.getState(), updateFound: this.getState().info !== null };
      }

      if (matchingReadyFile) {
        console.log(
          `[AppUpdate] reusing ready file for version ${info.latestVersion}: ${matchingReadyFile.filePath}`,
        );
        const state = this.setState({
          ...previousState,
          info,
          status: AppUpdateStatus.Ready,
          source: targetSource,
          readyFilePath: matchingReadyFile.filePath,
          readyFileHash: matchingReadyFile.fileHash,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      console.log(
        `[AppUpdate] no reusable ready file found for version ${info.latestVersion}, previousReadyFilePath=${previousState.readyFilePath ?? 'none'}`,
      );
      const existingReadyFile = this.getStoredReadyFile(targetSource);
      if (existingReadyFile?.filePath) {
        await this.cleanupReadyFile(existingReadyFile.filePath);
      }
      this.clearStoredReadyFile(targetSource);
      await this.pruneCachedInstallerFiles(targetSource);

      if (!this.canPredownload(info.url)) {
        const state = this.setState({
          status: AppUpdateStatus.Available,
          source: targetSource,
          info,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      if (options?.manual === true) {
        const state = this.setState({
          status: AppUpdateStatus.Available,
          source: targetSource,
          info,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      const state = await this.startDownload(info, flowId, targetSource);
      return { success: true, state, updateFound };
    } catch (error) {
      if (!this.isFlowActive(flowId, targetSource)) {
        console.log(
          `[AppUpdate] ignoring stale check failure, flowId=${flowId}, source=${targetSource}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
        );
        return { success: true, state: this.getState(), updateFound: this.getState().info !== null };
      }
      console.error('[AppUpdate] check failed:', error);
      const state = this.setState({
        ...previousState,
        status: previousState.info ? AppUpdateStatus.Error : AppUpdateStatus.Idle,
        errorMessage: error instanceof Error ? error.message : 'Check failed',
      });
      return {
        success: false,
        state,
        updateFound: previousState.info !== null,
        error: state.errorMessage ?? 'Check failed',
      };
    }
  }

  async retryDownload(): Promise<AppUpdateRuntimeState> {
    if (!this.state.info) {
      return this.getState();
    }
    if (!this.canPredownload(this.state.info.url)) {
      return this.getState();
    }
    if (this.state.status === AppUpdateStatus.Downloading || this.state.status === AppUpdateStatus.Installing) {
      return this.getState();
    }
    const source = this.state.source ?? AppUpdateSource.Auto;
    const flowId = this.beginFlow(source, 'retry-download');
    void this.startDownload(this.state.info, flowId, source);
    return this.getState();
  }

  cancelDownload(): AppUpdateRuntimeState {
    const cancelled = cancelActiveDownload();
    if (!cancelled) {
      return this.getState();
    }
    this.clearStoredReadyFile(this.state.source);
    return this.setState({
      status: AppUpdateStatus.Available,
      source: this.state.source,
      info: this.state.info,
      progress: null,
      readyFilePath: null,
      readyFileHash: null,
      errorMessage: null,
    });
  }

  async installReadyUpdate(): Promise<{
    success: boolean;
    state: AppUpdateRuntimeState;
    error?: string;
  }> {
    if (!this.state.readyFilePath || this.state.status !== AppUpdateStatus.Ready) {
      return {
        success: false,
        state: this.getState(),
        error: 'Update is not ready to install',
      };
    }

    const filePath = this.state.readyFilePath;
    this.setState({
      ...this.state,
      status: AppUpdateStatus.Installing,
      errorMessage: null,
    });

    try {
      await installUpdate(filePath);
      return { success: true, state: this.getState() };
    } catch (error) {
      console.error('[AppUpdate] install failed:', error);
      const state = this.setState({
        ...this.state,
        status: AppUpdateStatus.Error,
        errorMessage: error instanceof Error ? error.message : 'Installation failed',
      });
      return {
        success: false,
        state,
        error: state.errorMessage ?? 'Installation failed',
      };
    }
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
    currentVersion: string,
    manual: boolean,
    userId?: string | null,
  ): Promise<AppUpdateInfo | null> {
    const baseUrl = manual ? getManualUpdateCheckUrl() : getUpdateCheckUrl();
    const qs = this.getUpdateQueryString(userId, currentVersion);
    const url = qs ? `${baseUrl}?${qs}` : baseUrl;
    console.log(`[AppUpdate] checking update, currentVersion=${currentVersion}, url=${url}`);

    const response = await session.defaultSession.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Update check failed (HTTP ${response.status})`);
    }

    const payload = (await response.json()) as UpdateApiResponse;
    if (payload.code !== 0) {
      throw new Error(`Update check failed with code ${payload.code ?? 'unknown'}`);
    }

    const value = payload.data?.value;
    const latestVersion = value?.version?.trim();
    if (!latestVersion || !this.isNewerVersion(latestVersion, currentVersion)) {
      console.log(
        `[AppUpdate] no update available, latestVersion=${latestVersion || 'N/A'}, currentVersion=${currentVersion}`,
      );
      return null;
    }

    const toEntry = (log?: ChangeLogLang) => ({
      title: typeof log?.title === 'string' ? log.title : '',
      content: Array.isArray(log?.content) ? log.content : [],
    });

    const result: AppUpdateInfo = {
      latestVersion,
      date: value?.date?.trim() || '',
      changeLog: {
        zh: toEntry(value?.changeLog?.ch),
        en: toEntry(value?.changeLog?.en),
      },
      url: this.getPlatformDownloadUrl(value),
    };
    console.log(
      `[AppUpdate] update available: ${currentVersion} -> ${latestVersion}, downloadUrl=${result.url}`,
    );
    return result;
  }

  private getPlatformDownloadUrl(
    value: NonNullable<NonNullable<UpdateApiResponse['data']>['value']> | undefined,
  ): string {
    if (process.platform === 'darwin') {
      const download = process.arch === 'arm64' ? value?.macArm : value?.macIntel;
      return download?.url?.trim() || getFallbackDownloadUrl();
    }

    if (process.platform === 'win32') {
      return value?.windowsX64?.url?.trim() || getFallbackDownloadUrl();
    }

    return getFallbackDownloadUrl();
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
    const enterprise = this.store.get<{ disableUpdate?: boolean }>('enterprise_config');
    return enterprise?.disableUpdate === true;
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

  private getUpdateQueryString(userId?: string | null, version?: string): string {
    const params = new URLSearchParams();
    const installationId = this.getOrCreateInstallationId();
    if (installationId) {
      params.append('uuid', installationId);
    }
    if (userId) {
      params.append('userId', userId);
    }
    if (version) {
      params.append('version', version);
    }
    return params.toString();
  }

  private getOrCreateInstallationId(): string | null {
    try {
      const existing = this.store.get<string>(INSTALLATION_UUID_KEY);
      if (typeof existing === 'string' && existing.trim()) {
        return existing;
      }
      const nextId = crypto.randomUUID();
      this.store.set(INSTALLATION_UUID_KEY, nextId);
      return nextId;
    } catch (error) {
      console.warn('[AppUpdate] failed to get installation uuid:', error);
      return null;
    }
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
