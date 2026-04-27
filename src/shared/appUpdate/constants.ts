export const AppUpdateStatus = {
  Idle: 'idle',
  Checking: 'checking',
  Available: 'available',
  Downloading: 'downloading',
  Ready: 'ready',
  Installing: 'installing',
  Error: 'error',
} as const;

export type AppUpdateStatus = typeof AppUpdateStatus[keyof typeof AppUpdateStatus];

export const AppUpdateSource = {
  Auto: 'auto',
  Manual: 'manual',
} as const;

export type AppUpdateSource = typeof AppUpdateSource[keyof typeof AppUpdateSource];

export const AppUpdateIpc = {
  GetState: 'appUpdate:getState',
  CheckNow: 'appUpdate:checkNow',
  RetryDownload: 'appUpdate:retryDownload',
  CancelDownload: 'appUpdate:cancelDownload',
  InstallReady: 'appUpdate:installReady',
  StateChanged: 'appUpdate:stateChanged',
} as const;

export interface ChangeLogEntry {
  title: string;
  content: string[];
}

export interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
}

export interface AppUpdateInfo {
  latestVersion: string;
  date: string;
  changeLog: { zh: ChangeLogEntry; en: ChangeLogEntry };
  url: string;
}

export interface AppUpdateRuntimeState {
  status: AppUpdateStatus;
  source: AppUpdateSource | null;
  info: AppUpdateInfo | null;
  progress: AppUpdateDownloadProgress | null;
  readyFilePath: string | null;
  readyFileHash: string | null;
  errorMessage: string | null;
}

export interface AppUpdateCheckResult {
  success: boolean;
  state: AppUpdateRuntimeState;
  updateFound: boolean;
  error?: string;
}

export const APP_UPDATE_POLL_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const APP_UPDATE_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

export const AppUpdateAction = {
  OpenDownloadPage: 'openDownloadPage',
  InstallReady: 'installReady',
  Downloading: 'downloading',
  RetryDownload: 'retryDownload',
  RetryInstall: 'retryInstall',
  None: 'none',
} as const;

export type AppUpdateAction = typeof AppUpdateAction[keyof typeof AppUpdateAction];
