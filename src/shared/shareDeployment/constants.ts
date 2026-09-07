import type {
  HtmlShareAccessMode,
  HtmlShareConfigurableStatus,
  HtmlShareDisabledSource,
  HtmlShareStatus,
} from '../htmlShare/constants';
import type { PublishingSubscriptionRecoveryMode } from '../publishing/constants';

export const ShareDeploymentIpc = {
  DetectProjectCandidates: 'shareDeployment:detectProjectCandidates',
  AnalyzeProjectDirectory: 'shareDeployment:analyzeProjectDirectory',
  SelectPersistencePath: 'shareDeployment:selectPersistencePath',
  CreateNodeDeployment: 'shareDeployment:createNodeDeployment',
  Get: 'shareDeployment:get',
  GetByLocalService: 'shareDeployment:getByLocalService',
  GetPersistence: 'shareDeployment:getPersistence',
  DownloadPersistenceArchive: 'shareDeployment:downloadPersistenceArchive',
} as const;

export type ShareDeploymentIpc = (typeof ShareDeploymentIpc)[keyof typeof ShareDeploymentIpc];

export const ShareDeploymentCandidateSource = {
  Process: 'process',
  ProcessCwd: 'process_cwd',
  ArtifactMetadata: 'artifact_metadata',
  TextLabeledPath: 'text_labeled_path',
  TextFileLink: 'text_file_link',
  TextCdCommand: 'text_cd_command',
  TextCommonParent: 'text_common_parent',
  ToolWorkingDirectory: 'tool_working_directory',
  ToolCdCommand: 'tool_cd_command',
  ToolPwdResult: 'tool_pwd_result',
  Workspace: 'workspace',
  WorkspaceChild: 'workspace_child',
  Cache: 'cache',
  Manual: 'manual',
} as const;

export type ShareDeploymentCandidateSource =
  (typeof ShareDeploymentCandidateSource)[keyof typeof ShareDeploymentCandidateSource];

export const ShareDeploymentPackageManager = {
  Npm: 'npm',
  Pnpm: 'pnpm',
  Yarn: 'yarn',
  Unknown: 'unknown',
} as const;

export type ShareDeploymentPackageManager =
  (typeof ShareDeploymentPackageManager)[keyof typeof ShareDeploymentPackageManager];

export const ShareDeploymentStatus = {
  Queued: 'queued',
  Deploying: 'deploying',
  Live: 'live',
  DeployFailed: 'deploy_failed',
  Expired: 'expired',
  Stopped: 'stopped',
} as const;

export type ShareDeploymentStatus =
  (typeof ShareDeploymentStatus)[keyof typeof ShareDeploymentStatus];

export const ShareDeploymentFailureCode = {
  Provider: 'provider_error',
  Service: 'service_error',
  Unexpected: 'unexpected_error',
  PersistenceUnavailable: 'persistence_unavailable',
  PersistenceInvalid: 'persistence_invalid',
  PersistenceDataMissing: 'persistence_data_missing',
} as const;

export type ShareDeploymentFailureCode =
  (typeof ShareDeploymentFailureCode)[keyof typeof ShareDeploymentFailureCode];

export const ShareDeploymentKind = {
  NodeService: 'node_service',
  StaticSite: 'static_site',
} as const;

export type ShareDeploymentKind =
  (typeof ShareDeploymentKind)[keyof typeof ShareDeploymentKind];

export const ShareDeploymentPersistenceProvider = {
  Filesystem: 'filesystem',
} as const;

export type ShareDeploymentPersistenceProvider =
  (typeof ShareDeploymentPersistenceProvider)[keyof typeof ShareDeploymentPersistenceProvider];

export const ShareDeploymentPersistenceStatus = {
  Configured: 'configured',
  Live: 'live',
  ResetPending: 'reset_pending',
  Error: 'error',
} as const;

export type ShareDeploymentPersistenceStatus =
  (typeof ShareDeploymentPersistenceStatus)[keyof typeof ShareDeploymentPersistenceStatus];

export const ShareDeploymentPersistenceUpdateMode = {
  Preserve: 'preserve',
  Replace: 'replace',
} as const;

export type ShareDeploymentPersistenceUpdateMode =
  (typeof ShareDeploymentPersistenceUpdateMode)[keyof typeof ShareDeploymentPersistenceUpdateMode];

export const ShareDeploymentPersistenceBindingKind = {
  File: 'file',
  Directory: 'directory',
} as const;

export type ShareDeploymentPersistenceBindingKind =
  (typeof ShareDeploymentPersistenceBindingKind)[keyof typeof ShareDeploymentPersistenceBindingKind];

export interface ShareDeploymentPersistenceBinding {
  appPath: string;
  dataPath: string;
  kind: ShareDeploymentPersistenceBindingKind;
  sizeBytes?: number;
}

export interface ShareDeploymentPersistence {
  enabled: boolean;
  provider: ShareDeploymentPersistenceProvider;
  mountPath?: string;
  remoteRoot?: string;
  quotaBytes?: number;
  usedBytes?: number | null;
  usedBytesEstimated?: boolean;
  status?: ShareDeploymentPersistenceStatus;
  bindings: ShareDeploymentPersistenceBinding[];
}

export interface ShareDeploymentSelectPersistencePathInput {
  projectDirectory: string;
  kind: ShareDeploymentPersistenceBindingKind;
}

export interface ShareDeploymentSelectPersistencePathResult {
  success: boolean;
  binding?: ShareDeploymentPersistenceBinding;
  error?: string;
}

export interface ShareDeploymentProjectCandidate {
  directory: string;
  source: ShareDeploymentCandidateSource;
  confidence: number;
  reason?: string;
  evidence?: string;
  messageId?: string;
  artifactId?: string;
  pid?: number;
  detectedAt?: number;
}

export interface ShareDeploymentDetectCandidatesInput {
  localServiceUrl: string;
  workingDirectory?: string;
  projectCandidates?: ShareDeploymentProjectCandidate[];
  cachedProjectDirectory?: string;
}

export interface ShareDeploymentDetectCandidatesResult {
  success: boolean;
  candidates: ShareDeploymentProjectCandidate[];
  error?: string;
}

export interface ShareDeploymentAnalyzeProjectInput {
  projectDirectory: string;
  localServiceUrl?: string;
}

export interface ShareDeploymentProjectAnalysis {
  success: boolean;
  projectDirectory: string;
  packageName?: string;
  packageVersion?: string;
  deploymentKind?: ShareDeploymentKind;
  entryFile?: string;
  spaFallback?: boolean;
  packageManager: ShareDeploymentPackageManager;
  nodeVersion: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  port?: number;
  totalFiles: number;
  totalBytes: number;
  excludedCount: number;
  persistence?: ShareDeploymentPersistence;
  warnings: string[];
  blockers: string[];
  error?: string;
}

export interface ShareDeploymentCreateNodeInput {
  sessionId: string;
  artifactId: string;
  title: string;
  localServiceUrl: string;
  projectDirectory: string;
  accessMode?: HtmlShareAccessMode;
  previousAccessMode?: HtmlShareAccessMode;
  nodeVersion: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  port: number;
  persistence?: ShareDeploymentPersistence;
  persistenceUpdateMode?: ShareDeploymentPersistenceUpdateMode;
  targetShareStatus?: HtmlShareConfigurableStatus;
  quotaReservationId?: string;
}

export interface ShareDeploymentGetByLocalServiceInput {
  sessionId: string;
  localServiceUrl: string;
  projectDirectory?: string;
}

export interface ShareDeploymentPersistenceInfoResult {
  success: boolean;
  persistence?: ShareDeploymentPersistence | null;
  error?: string;
  code?: number;
}

export interface ShareDeploymentDownloadPersistenceInput {
  deploymentId: string;
  projectDirectory?: string;
  shareId?: string;
}

export interface ShareDeploymentDownloadPersistenceResult {
  success: boolean;
  filePath?: string;
  empty?: boolean;
  error?: string;
  code?: number;
}

export interface ShareDeploymentEvent {
  id?: number;
  eventType?: string;
  message?: string;
  detailJson?: string;
  createdAt?: string;
}

export interface ShareDeploymentRecord {
  deploymentId: string;
  shareId?: string;
  url?: string;
  deploymentKind?: ShareDeploymentKind;
  accessMode?: HtmlShareAccessMode;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  shareStatus?: HtmlShareStatus;
  disabledSource?: HtmlShareDisabledSource | null;
  status: ShareDeploymentStatus;
  runtimeLanguage?: string;
  runtimeVersion?: string;
  packageManager?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  targetPort?: number;
  sourceArchiveBytes?: number;
  sourceSha256?: string;
  provider?: string;
  providerRegion?: string;
  providerFunctionId?: string;
  providerEndpoint?: string;
  persistence?: ShareDeploymentPersistence;
  deployedAt?: string;
  expiresAt?: string | null;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
  lastAccessedAt?: string;
  errorCode?: ShareDeploymentFailureCode;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  events?: ShareDeploymentEvent[];
}

export interface ShareDeploymentResult {
  success: boolean;
  deployment?: ShareDeploymentRecord | null;
  analysis?: ShareDeploymentProjectAnalysis;
  warnings?: string[];
  accessSyncError?: string;
  error?: string;
  code?: number;
}
