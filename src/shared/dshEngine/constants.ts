export const DshEnginePhase = {
  NotInstalled: 'not_installed',
  Stopped: 'stopped',
  Installing: 'installing',
  Starting: 'starting',
  Ready: 'ready',
  Failed: 'failed',
} as const;
export type DshEnginePhase = typeof DshEnginePhase[keyof typeof DshEnginePhase];

export const DshEngineErrorCode = {
  RuntimeMissing: 'runtime_missing',
  RuntimeInvalid: 'runtime_invalid',
  InstallFailed: 'install_failed',
  SpawnFailed: 'spawn_failed',
  ReadyTimeout: 'ready_timeout',
  CrashedEarly: 'crashed_early',
  PluginLoadFailed: 'plugin_load_failed',
} as const;
export type DshEngineErrorCode = typeof DshEngineErrorCode[keyof typeof DshEngineErrorCode];

// Stages of a runtime install. The renderer labels the current one while the
// download runs, so these travel over IPC and belong here rather than staying
// main-process literals.
export const DshInstallStage = {
  Manifest: 'manifest',
  Download: 'download',
  Verify: 'verify',
  Extract: 'extract',
} as const;
export type DshInstallStage = typeof DshInstallStage[keyof typeof DshInstallStage];

/** Non-null only while an install is running. */
export interface DshInstallProgressState {
  stage: DshInstallStage;
  receivedBytes: number;
  totalBytes: number;
}

export const DSH_RUNTIME_RESOURCE_DIR = 'dsh';
export const DSH_STATE_DIR_NAME = 'dsh';

export const DshIpcChannel = {
  GetState: 'dsh:getState',
  GetConfig: 'dsh:getConfig',
  SetEnabled: 'dsh:setEnabled',
  OpenWorkbench: 'dsh:openWorkbench',
  Stop: 'dsh:stop',
} as const;
export type DshIpcChannel = typeof DshIpcChannel[keyof typeof DshIpcChannel];

// kv store key holding { enabled: boolean } for the experimental dsh feature.
export const DSH_CONFIG_STORE_KEY = 'dsh_config';

export interface DshFeatureConfig {
  enabled: boolean;
}
