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
  InstallReady: 'appUpdate:installReady',
  StateChanged: 'appUpdate:stateChanged',
  GetCompletedUpdate: 'appUpdate:getCompletedUpdate',
  GetActiveWorkloads: 'appUpdate:getActiveWorkloads',
} as const;

/**
 * Marker stored in AppUpdateRuntimeState.errorMessage when the user declined
 * the Windows UAC elevation prompt for a silent install. The OS-provided
 * exception text is localized, so this stable token is what crosses the IPC
 * boundary; the renderer maps it to a translated message.
 */
export const APP_UPDATE_ELEVATION_DECLINED_ERROR = 'update-elevation-declined';

/**
 * Stable marker returned when a Windows installer URL fails the HTTPS
 * transport, credential, port, or extension policy.
 */
export const APP_UPDATE_URL_UNTRUSTED_ERROR = 'update-url-untrusted';

/** Stable marker returned when cached installer bytes fail hash validation. */
export const APP_UPDATE_FILE_INVALID_ERROR = 'update-file-invalid';

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
  /** True when a previous install attempt quit the app but never completed. */
  installIncomplete?: boolean;
}

export interface AppUpdateCheckResult {
  success: boolean;
  state: AppUpdateRuntimeState;
  updateFound: boolean;
  error?: string;
}

/**
 * Whether the runtime still has work that installing an update would cut
 * short: an agent turn streaming in any session (IM-driven ones included) or a
 * scheduled task run in progress.
 */
export interface AppUpdateActiveWorkloads {
  hasActiveWorkloads: boolean;
}

export const APP_UPDATE_POLL_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const APP_UPDATE_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * True when the update URL points at a download landing page that the user
 * must visit in a browser, rather than a direct installer file the app can
 * download and run itself.
 */
export function isManualDownloadUrl(url: string): boolean {
  return url.includes('#') || url.endsWith('/download-list');
}
