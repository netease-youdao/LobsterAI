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

// Stages of a runtime install.
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
