import { ArtifactBrowserPartition } from '@shared/artifactPreview/constants';
import type { CoworkSelectedTextSnippet } from '@shared/cowork/selectedText';
import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareConfigurableStatus,
  HtmlShareDisabledSource,
  type HtmlShareDisabledSource as HtmlShareDisabledSourceValue,
  HtmlShareErrorCode,
  HtmlShareSourceType,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '@shared/htmlShare/constants';
import type { LocalWebService } from '@shared/localWebServices/constants';
import {
  ShareDeploymentCandidateSource,
  ShareDeploymentKind,
  ShareDeploymentPackageManager,
  type ShareDeploymentProjectAnalysis,
  type ShareDeploymentProjectCandidate,
  type ShareDeploymentRecord,
  ShareDeploymentStatus,
} from '@shared/shareDeployment/constants';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { authService } from '@/services/auth';
import { copyTextToClipboard } from '@/services/clipboard';
import { getPortalPricingUrl, PortalPricingKeyfrom } from '@/services/endpoints';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';
import {
  addArtifact,
  ArtifactContentView,
  ArtifactSpecialTab,
  closePanel,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  openArtifactPreviewTab,
  selectActivePreviewTab,
  selectPanelWidth,
  setPanelWidth,
  setPreviewTabContentView,
} from '@/store/slices/artifactSlice';
import {
  type Artifact,
  type ArtifactType,
  ArtifactTypeValue,
  PREVIEWABLE_ARTIFACT_TYPES,
} from '@/types/artifact';
import { openLocalPathWithToast, revealLocalPathWithToast } from '@/utils/localFileActions';

import CopyIcon from '../icons/CopyIcon';
import {
  getArtifactBrowserUrlType,
  reportArtifactPreviewAction,
} from './artifactAnalytics';
import ArtifactRenderer from './ArtifactRenderer';
import FileDirectoryView from './FileDirectoryView';
import CodeRenderer from './renderers/CodeRenderer';
import {
  OfficePreviewActionsContext,
  type OfficePreviewZoomControlsConfig,
} from './renderers/OfficePreviewActionsContext';
import { OfficeZoomControls } from './renderers/OfficeZoomControls';

const t = (key: string) => i18nService.t(key);

const BROWSER_OPENABLE_TYPES = new Set<ArtifactType>(['html', 'svg', 'mermaid']);

const SYSTEM_OPENABLE_TYPES = new Set<ArtifactType>(['document', 'video']);

const NON_CODE_TYPES = new Set<ArtifactType>([
  'document',
  'image',
  'video',
  'text',
  ArtifactTypeValue.LocalService,
]);

const COPYABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

const PANEL_CLOSE_DRAG_THRESHOLD = 48;
const FILE_LIST_DRAWER_TRANSITION_MS = 180;
const NODE_DEPLOYMENT_PROJECT_DIRECTORY_STORAGE_PREFIX =
  'lobsterai:node-deployment-project-directory:';

const HtmlSharePhase = {
  Idle: 'idle',
  Checking: 'checking',
  Packing: 'packing',
  Uploading: 'uploading',
  Live: 'live',
  Failed: 'failed',
} as const;

type HtmlSharePhase = (typeof HtmlSharePhase)[keyof typeof HtmlSharePhase];

const HtmlShareDialogKind = {
  Create: 'create',
  Subscription: 'subscription',
  Existing: 'existing',
  Result: 'result',
} as const;

type HtmlShareDialogKind = (typeof HtmlShareDialogKind)[keyof typeof HtmlShareDialogKind];

const HtmlShareContentUpdateStatus = {
  Updating: 'updating',
  Complete: 'complete',
  Failed: 'failed',
} as const;

type HtmlShareContentUpdateStatus =
  (typeof HtmlShareContentUpdateStatus)[keyof typeof HtmlShareContentUpdateStatus];

const HtmlShareCopyStatus = {
  Idle: 'idle',
  Copied: 'copied',
  Failed: 'failed',
} as const;

type HtmlShareCopyStatus =
  (typeof HtmlShareCopyStatus)[keyof typeof HtmlShareCopyStatus];

const HtmlSharePendingSource = {
  HtmlFile: 'htmlFile',
  ArtifactFile: 'artifactFile',
} as const;

type HtmlSharePendingSource =
  (typeof HtmlSharePendingSource)[keyof typeof HtmlSharePendingSource];

const NodeDeploymentDialogKind = {
  AccessMode: 'accessMode',
  Confirm: 'confirm',
  Status: 'status',
  Result: 'result',
} as const;

type NodeDeploymentDialogKind =
  (typeof NodeDeploymentDialogKind)[keyof typeof NodeDeploymentDialogKind];

const NodeDeploymentPhase = {
  Idle: 'idle',
  Checking: 'checking',
  Analyzing: 'analyzing',
  Uploading: 'uploading',
  Deploying: 'deploying',
  Live: 'live',
  Failed: 'failed',
} as const;

type NodeDeploymentPhase = (typeof NodeDeploymentPhase)[keyof typeof NodeDeploymentPhase];

const NodeDeploymentProgressStep = {
  Prepare: 'prepare',
  Check: 'check',
  Upload: 'upload',
  Deploy: 'deploy',
  Complete: 'complete',
} as const;

type NodeDeploymentProgressStep =
  (typeof NodeDeploymentProgressStep)[keyof typeof NodeDeploymentProgressStep];

const NODE_DEPLOYMENT_PROGRESS_STEPS: readonly NodeDeploymentProgressStep[] = [
  NodeDeploymentProgressStep.Prepare,
  NodeDeploymentProgressStep.Check,
  NodeDeploymentProgressStep.Upload,
  NodeDeploymentProgressStep.Deploy,
  NodeDeploymentProgressStep.Complete,
];

interface HtmlSharePendingRequest {
  source: HtmlSharePendingSource;
  sourceType: HtmlShareSourceType;
  sessionId: string;
  artifactId: string;
  lookupKey: string;
  title: string;
  accessMode: HtmlShareAccessModeValue;
  fileName?: string;
  filePath?: string;
  content?: string;
  remoteUrl?: string;
}

interface HtmlShareDialogState {
  kind: HtmlShareDialogKind;
  title: string;
  message: string;
  shareId?: string;
  url?: string;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  accessMode?: HtmlShareAccessModeValue;
  selectedAccessMode?: HtmlShareAccessModeValue;
  status?: HtmlShareStatusValue;
  targetStatus?: HtmlShareConfigurableStatus;
  disabledSource?: HtmlShareDisabledSourceValue | null;
  statusError?: string;
  contentUpdateStatus?: HtmlShareContentUpdateStatus;
}

interface ExistingHtmlShareInfo {
  shareId: string;
  url: string;
  accessMode?: HtmlShareAccessModeValue;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status?: HtmlShareStatusValue;
  disabledSource?: HtmlShareDisabledSourceValue | null;
}

interface HtmlShareLookupState {
  sourceKey: string;
  isLoading: boolean;
  share?: ExistingHtmlShareInfo;
}

interface NodeDeploymentLookupState {
  sourceKey: string;
  isLoading: boolean;
  deployment?: ShareDeploymentRecord | null;
}

interface NodeDeploymentDialogState {
  kind: NodeDeploymentDialogKind;
  phase: NodeDeploymentPhase;
  title: string;
  message: string;
  localService?: LocalWebService;
  projectDirectory?: string;
  analysis?: ShareDeploymentProjectAnalysis;
  accessMode?: HtmlShareAccessModeValue;
  nodeVersion?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: string;
  deployment?: ShareDeploymentRecord | null;
  error?: string;
}

interface BrowserLocalServiceContext {
  artifactId?: string;
  url: string;
  origin: string;
  projectDirectory?: string;
  projectCandidates?: ShareDeploymentProjectCandidate[];
}

function isNodeDeploymentDialogForLocalService(
  dialog: NodeDeploymentDialogState | null,
  localService: LocalWebService | null,
): boolean {
  if (!dialog?.localService || !localService) return false;
  return (
    normalizeLocalServiceOriginForCompare(dialog.localService.url) ===
    normalizeLocalServiceOriginForCompare(localService.url)
  );
}

function isSubmittedNodeDeploymentDialog(dialog: NodeDeploymentDialogState | null): boolean {
  if (!dialog) return false;
  if (dialog.kind === NodeDeploymentDialogKind.Result) return true;
  return dialog.kind === NodeDeploymentDialogKind.Status && dialog.phase !== NodeDeploymentPhase.Checking;
}

function getExistingHtmlShareInfo(
  share: {
    shareId?: string;
    url?: string;
    accessMode?: HtmlShareAccessModeValue;
    shareCode?: string;
    shareCodeUnavailable?: boolean;
    status?: HtmlShareStatusValue;
    disabledSource?: HtmlShareDisabledSourceValue | null;
  } | null | undefined,
): ExistingHtmlShareInfo | null {
  if (!share?.shareId || !share.url) return null;
  return {
    shareId: share.shareId,
    url: share.url,
    accessMode: share.accessMode,
    shareCode: share.shareCode,
    shareCodeUnavailable: share.shareCodeUnavailable,
    status: share.status,
    disabledSource: share.disabledSource,
  };
}

function getConfigurableHtmlShareStatus(
  status?: HtmlShareStatusValue,
): HtmlShareConfigurableStatus | undefined {
  if (status === HtmlShareStatus.Failed) return undefined;
  return status === HtmlShareStatus.Disabled ? HtmlShareStatus.Disabled : HtmlShareStatus.Live;
}

function normalizeHtmlShareAccessMode(
  accessMode?: HtmlShareAccessModeValue,
): HtmlShareAccessModeValue {
  return accessMode === HtmlShareAccessMode.Public
    ? HtmlShareAccessMode.Public
    : HtmlShareAccessMode.Code;
}

function shouldUseHtmlShareCode(
  accessMode?: HtmlShareAccessModeValue,
): boolean {
  return normalizeHtmlShareAccessMode(accessMode) === HtmlShareAccessMode.Code;
}

function normalizeNodeDeploymentProjectDirectoryForCompare(value?: string): string {
  let normalized = value?.trim().replace(/\\/g, '/') || '';
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizeLocalServiceOriginForCompare(value?: string): string {
  if (!value) return '';
  try {
    return new URL(value.trim()).origin.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function getNodeDeploymentLookupKey(
  sessionId: string,
  localServiceUrl: string,
  projectDirectory?: string,
): string {
  const origin = normalizeLocalServiceOriginForCompare(localServiceUrl);
  const directory = normalizeNodeDeploymentProjectDirectoryForCompare(projectDirectory);
  return `${sessionId}:${origin}:${directory}`;
}

function getNodeDeploymentProjectDirectoryStorageKey(
  sessionId: string,
  localServiceUrl: string,
): string {
  return `${NODE_DEPLOYMENT_PROJECT_DIRECTORY_STORAGE_PREFIX}${sessionId}:${normalizeLocalServiceOriginForCompare(localServiceUrl)}`;
}

function getLegacyNodeDeploymentProjectDirectoryStorageKey(
  sessionId: string,
  localServiceUrl: string,
): string {
  return `${NODE_DEPLOYMENT_PROJECT_DIRECTORY_STORAGE_PREFIX}${sessionId}:${localServiceUrl}`;
}

interface NodeDeploymentProjectDirectoryCache {
  projectDirectory: string;
  source?: ShareDeploymentProjectCandidate['source'];
  updatedAt?: number;
}

function parseNodeDeploymentProjectDirectoryCache(value: string | null): NodeDeploymentProjectDirectoryCache | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<NodeDeploymentProjectDirectoryCache>;
    if (typeof parsed.projectDirectory === 'string' && parsed.projectDirectory.trim()) {
      return {
        projectDirectory: parsed.projectDirectory.trim(),
        source: parsed.source,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
      };
    }
  } catch {
    // Older versions stored the directory directly.
  }
  return {
    projectDirectory: trimmed,
  };
}

function readNodeDeploymentProjectDirectoryCandidate(
  sessionId: string,
  localServiceUrl?: string,
): ShareDeploymentProjectCandidate | undefined {
  if (!localServiceUrl || typeof window === 'undefined') return undefined;
  try {
    const value = window.localStorage
      .getItem(getNodeDeploymentProjectDirectoryStorageKey(sessionId, localServiceUrl));
    const legacyValue = window.localStorage
      .getItem(getLegacyNodeDeploymentProjectDirectoryStorageKey(sessionId, localServiceUrl));
    const cache = parseNodeDeploymentProjectDirectoryCache(value) ??
      parseNodeDeploymentProjectDirectoryCache(legacyValue);
    if (!cache?.projectDirectory) return undefined;
    return {
      directory: cache.projectDirectory,
      source: ShareDeploymentCandidateSource.Cache,
      confidence: 35,
      reason: 'Matched the previously used project directory for this local service origin.',
      detectedAt: cache.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function readNodeDeploymentProjectDirectory(
  sessionId: string,
  localServiceUrl?: string,
): string | undefined {
  return readNodeDeploymentProjectDirectoryCandidate(sessionId, localServiceUrl)?.directory;
}

function writeNodeDeploymentProjectDirectory(
  sessionId: string,
  localServiceUrl: string,
  projectDirectory?: string,
  source: ShareDeploymentProjectCandidate['source'] = ShareDeploymentCandidateSource.Manual,
): void {
  const value = projectDirectory?.trim();
  if (!value || typeof window === 'undefined') return;
  try {
    const cacheValue = JSON.stringify({
      projectDirectory: value,
      source,
      updatedAt: Date.now(),
    } satisfies NodeDeploymentProjectDirectoryCache);
    const key = getNodeDeploymentProjectDirectoryStorageKey(sessionId, localServiceUrl);
    window.localStorage.setItem(key, cacheValue);
    const legacyKey = getLegacyNodeDeploymentProjectDirectoryStorageKey(sessionId, localServiceUrl);
    if (legacyKey !== key) {
      window.localStorage.setItem(legacyKey, cacheValue);
    }
  } catch {
    // Local cache is best-effort only.
  }
}

function getHtmlShareFailureMessage(
  result:
    | {
        code?: number;
        error?: string;
      }
    | null
    | undefined,
): string {
  if (result?.code === HtmlShareErrorCode.SubscriptionRequired) {
    return t('htmlShareSubscriptionRequiredMessage');
  }
  if (result?.code === HtmlShareErrorCode.FeatureUnavailable) {
    return t('htmlShareUnavailableInProduction');
  }
  if (result?.code === HtmlShareErrorCode.ReopenUnavailable) {
    return t('htmlShareReopenUnavailable');
  }
  if (result?.code === HtmlShareErrorCode.ActiveShareLimitReached) {
    return t('htmlShareActiveLimitReached');
  }
  if (result?.code === HtmlShareErrorCode.DisabledCannotUpdate) {
    return t('htmlShareDisabledCannotUpdate');
  }
  if (result?.code === HtmlShareErrorCode.UnsafeSvg) {
    return t('artifactShareSvgRejected');
  }
  return result?.error || t('htmlShareFailed');
}

function getNodeDeploymentStatusLabel(status?: ShareDeploymentStatus): string {
  switch (status) {
    case ShareDeploymentStatus.Queued:
      return t('nodeDeploymentStatusQueued');
    case ShareDeploymentStatus.Deploying:
      return t('nodeDeploymentStatusDeploying');
    case ShareDeploymentStatus.Live:
      return t('nodeDeploymentStatusLive');
    case ShareDeploymentStatus.DeployFailed:
      return t('nodeDeploymentStatusFailed');
    case ShareDeploymentStatus.Expired:
      return t('nodeDeploymentStatusExpired');
    case ShareDeploymentStatus.Stopped:
      return t('nodeDeploymentStatusStopped');
    default:
      return t('nodeDeploymentStatusUnknown');
  }
}

function getNodeDeploymentPhaseStatusLabel(
  phase?: NodeDeploymentPhase,
  status?: ShareDeploymentStatus,
): string {
  if (status) return getNodeDeploymentStatusLabel(status);
  switch (phase) {
    case NodeDeploymentPhase.Checking:
      return t('nodeDeploymentProgressPrepare');
    case NodeDeploymentPhase.Analyzing:
      return t('nodeDeploymentProgressCheck');
    case NodeDeploymentPhase.Uploading:
      return t('nodeDeploymentProgressUpload');
    case NodeDeploymentPhase.Deploying:
      return t('nodeDeploymentProgressDeploy');
    case NodeDeploymentPhase.Live:
      return t('nodeDeploymentStatusLive');
    case NodeDeploymentPhase.Failed:
      return t('nodeDeploymentStatusFailed');
    case NodeDeploymentPhase.Idle:
    default:
      return t('nodeDeploymentStatusUnknown');
  }
}

function isNodeDeploymentPending(status?: ShareDeploymentStatus): boolean {
  return status === ShareDeploymentStatus.Queued || status === ShareDeploymentStatus.Deploying;
}

function getNodeDeploymentStatusMessage(deployment?: ShareDeploymentRecord | null): string {
  if (!deployment) return t('nodeDeploymentPreparingMessage');
  switch (deployment.status) {
    case ShareDeploymentStatus.Queued:
      return t('nodeDeploymentStatusQueuedMessage');
    case ShareDeploymentStatus.Deploying:
      return t('nodeDeploymentStatusDeployingMessage');
    case ShareDeploymentStatus.Live:
      return t('nodeDeploymentStatusLiveMessage');
    case ShareDeploymentStatus.DeployFailed:
      return deployment.errorMessage || t('nodeDeploymentStatusFailedMessage');
    case ShareDeploymentStatus.Expired:
      return t('nodeDeploymentStatusExpiredMessage');
    case ShareDeploymentStatus.Stopped:
      return t('nodeDeploymentStatusStoppedMessage');
    default:
      return t('nodeDeploymentPreparingMessage');
  }
}

function getNodeDeploymentProgressStepLabel(step: NodeDeploymentProgressStep): string {
  switch (step) {
    case NodeDeploymentProgressStep.Prepare:
      return t('nodeDeploymentProgressPrepare');
    case NodeDeploymentProgressStep.Check:
      return t('nodeDeploymentProgressCheck');
    case NodeDeploymentProgressStep.Upload:
      return t('nodeDeploymentProgressUpload');
    case NodeDeploymentProgressStep.Deploy:
      return t('nodeDeploymentProgressDeploy');
    case NodeDeploymentProgressStep.Complete:
      return t('nodeDeploymentProgressComplete');
    default:
      return '';
  }
}

function getNodeDeploymentProgressIndex(
  phase?: NodeDeploymentPhase,
  status?: ShareDeploymentStatus,
): number {
  switch (status) {
    case ShareDeploymentStatus.Live:
    case ShareDeploymentStatus.Stopped:
    case ShareDeploymentStatus.Expired:
      return NODE_DEPLOYMENT_PROGRESS_STEPS.length - 1;
    case ShareDeploymentStatus.Queued:
    case ShareDeploymentStatus.Deploying:
    case ShareDeploymentStatus.DeployFailed:
      return 3;
    default:
      break;
  }

  switch (phase) {
    case NodeDeploymentPhase.Checking:
      return 0;
    case NodeDeploymentPhase.Analyzing:
      return 1;
    case NodeDeploymentPhase.Uploading:
      return 2;
    case NodeDeploymentPhase.Deploying:
      return 3;
    case NodeDeploymentPhase.Live:
      return NODE_DEPLOYMENT_PROGRESS_STEPS.length - 1;
    case NodeDeploymentPhase.Failed:
      return 2;
    case NodeDeploymentPhase.Idle:
    default:
      return 0;
  }
}

function isNodeDeploymentProgressComplete(
  phase?: NodeDeploymentPhase,
  status?: ShareDeploymentStatus,
): boolean {
  return (
    status === ShareDeploymentStatus.Live ||
    status === ShareDeploymentStatus.Stopped ||
    status === ShareDeploymentStatus.Expired ||
    phase === NodeDeploymentPhase.Live
  );
}

function isNodeDeploymentProgressFailed(
  phase?: NodeDeploymentPhase,
  status?: ShareDeploymentStatus,
): boolean {
  return status === ShareDeploymentStatus.DeployFailed || phase === NodeDeploymentPhase.Failed;
}

function getNodeDeploymentProgressStepState(
  stepIndex: number,
  currentStepIndex: number,
  isComplete: boolean,
  isFailed: boolean,
): 'active' | 'done' | 'failed' | 'pending' {
  if (isFailed) {
    if (stepIndex < currentStepIndex) return 'done';
    if (stepIndex === currentStepIndex) return 'failed';
    return 'pending';
  }
  if (isComplete || stepIndex < currentStepIndex) return 'done';
  if (stepIndex === currentStepIndex) return 'active';
  return 'pending';
}

interface NodeDeploymentStatusCardProps {
  phase?: NodeDeploymentPhase;
  deployment?: ShareDeploymentRecord | null;
  statusLabel: string;
  message?: string;
}

// Status summary card: current-status badge, URL, share code, and message.
// The segmented progress bar is rendered separately by NodeDeploymentProgressSteps.
const NodeDeploymentStatusCard: React.FC<NodeDeploymentStatusCardProps> = ({
  phase,
  deployment,
  statusLabel,
  message,
}) => {
  const isComplete = isNodeDeploymentProgressComplete(phase, deployment?.status);
  const isFailed = isNodeDeploymentProgressFailed(phase, deployment?.status);

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-secondary">
          {t('nodeDeploymentCurrentStatus')}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            isFailed
              ? 'bg-red-500/10 text-red-500'
              : isComplete
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                : 'bg-primary/10 text-primary'
          }`}
        >
          {statusLabel}
        </span>
      </div>

      {deployment?.url && (
        <div className="mt-3 break-all text-sm leading-5 text-foreground">
          {deployment.url}
        </div>
      )}
      {deployment && shouldUseHtmlShareCode(deployment.accessMode) && deployment.shareCode && (
        <div className="mt-3 text-sm leading-5 text-foreground">
          <span className="text-muted">{t('htmlShareCode')}</span>
          <span className="ml-2 font-medium">{deployment.shareCode}</span>
        </div>
      )}
      {deployment &&
        shouldUseHtmlShareCode(deployment.accessMode) &&
        deployment.shareCodeUnavailable && (
        <div className="mt-3 text-xs leading-5 text-muted">
          {t('htmlShareCodeUnavailable')}
        </div>
      )}
      {message && (
        <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-5 text-secondary">
          {message}
        </div>
      )}
    </div>
  );
};

interface NodeDeploymentProgressStepsProps {
  phase?: NodeDeploymentPhase;
  status?: ShareDeploymentStatus;
}

// Segmented deployment progress bar. Rendered below the redeploy action so it
// reads as live feedback for the deploy/redeploy step rather than a static header.
const NodeDeploymentProgressSteps: React.FC<NodeDeploymentProgressStepsProps> = ({
  phase,
  status,
}) => {
  const currentStepIndex = getNodeDeploymentProgressIndex(phase, status);
  const isComplete = isNodeDeploymentProgressComplete(phase, status);
  const isFailed = isNodeDeploymentProgressFailed(phase, status);

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex">
        {NODE_DEPLOYMENT_PROGRESS_STEPS.map((step, index) => {
          const state = getNodeDeploymentProgressStepState(
            index,
            currentStepIndex,
            isComplete,
            isFailed,
          );
          const colors =
            state === 'failed'
              ? {
                  segment: 'bg-red-500 text-white',
                }
              : state === 'active'
                ? {
                    segment: 'bg-blue-500 text-white',
                  }
                : state === 'done'
                  ? {
                      segment: 'bg-[#339b56] text-white',
                    }
                  : {
                      // Opaque muted neutral — NOT bg-foreground/10. The pills
                      // overlap, so a translucent pending fill stacks with the
                      // next pending pill and shows a darker seam. color-mix
                      // keeps the same tint while staying fully opaque.
                      segment:
                        'bg-[color-mix(in_srgb,var(--lobster-foreground)_10%,var(--lobster-background))] text-secondary',
                    };
          return (
            <div
              key={step}
              style={{
                zIndex: NODE_DEPLOYMENT_PROGRESS_STEPS.length - index,
              }}
              className={`relative inline-flex h-9 min-w-[112px] flex-1 items-center justify-center gap-2 border-[1.5px] border-background px-4 text-sm font-semibold transition-colors ${
                index === 0 ? 'rounded-full' : 'rounded-r-full -ml-7 pl-10'
              } ${colors.segment}`}
            >
              <span className="relative z-10 whitespace-nowrap">
                {getNodeDeploymentProgressStepLabel(step)}
              </span>
              {state === 'active' && (
                <span className="relative z-10 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {state === 'done' && (
                <svg
                  className="relative z-10 h-4 w-4 shrink-0"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3.25 8.2l3 3L12.75 4.7" />
                </svg>
              )}
              {state === 'failed' && (
                <span className="relative z-10 h-2.5 w-2.5 shrink-0 rounded-full bg-current" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

function formatDeploymentBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function shouldContinueArtifactShareAfterLookupFailure(
  request: HtmlSharePendingRequest,
  lookup:
    | {
        code?: number;
        error?: string;
      }
    | null
    | undefined,
): boolean {
  if (request.source !== HtmlSharePendingSource.ArtifactFile) return false;
  if (!lookup?.error) return false;
  const message = lookup.error.toLowerCase();
  return lookup.error.includes('参数') || (message.includes('input') && message.includes('parameter'));
}

function getHtmlShareSourceTypeForArtifact(artifact: Artifact): HtmlShareSourceType | null {
  if (artifact.type === ArtifactTypeValue.Html) return HtmlShareSourceType.HtmlFile;
  if (artifact.type === ArtifactTypeValue.Image) return HtmlShareSourceType.ImageFile;
  if (artifact.type === ArtifactTypeValue.Svg) return HtmlShareSourceType.SvgFile;
  if (artifact.type === ArtifactTypeValue.Document) return HtmlShareSourceType.DocumentFile;
  if (artifact.type === ArtifactTypeValue.Markdown) return HtmlShareSourceType.MarkdownFile;
  if (artifact.type === ArtifactTypeValue.Mermaid) return HtmlShareSourceType.MermaidFile;
  return null;
}

function hasShareableArtifactSource(
  artifact: Artifact,
  sourceType: HtmlShareSourceType | null,
): boolean {
  if (!sourceType) return false;
  if (sourceType === HtmlShareSourceType.HtmlFile) return Boolean(artifact.filePath);
  if (sourceType === HtmlShareSourceType.DocumentFile) {
    return Boolean(artifact.filePath || artifact.content?.trim());
  }
  if (
    sourceType === HtmlShareSourceType.MarkdownFile ||
    sourceType === HtmlShareSourceType.MermaidFile
  ) {
    return Boolean(artifact.filePath || artifact.content?.trim());
  }
  return Boolean(artifact.filePath || artifact.content?.trim() || artifact.remoteUrl?.trim());
}

function buildHtmlShareLookupKey(
  artifact: Artifact,
  sourceType: HtmlShareSourceType,
  fallbackSessionId?: string,
): string {
  if (artifact.filePath) return `${sourceType}:file:${artifact.filePath}`;
  return `${sourceType}:artifact:${artifact.sessionId || fallbackSessionId || ''}:${artifact.id}`;
}

function buildHtmlSharePendingRequest(
  artifact: Artifact,
  sourceType: HtmlShareSourceType,
  fallbackSessionId: string,
): HtmlSharePendingRequest | null {
  if (!hasShareableArtifactSource(artifact, sourceType)) return null;
  const sessionId = artifact.sessionId || fallbackSessionId;
  const title = artifact.title || artifact.fileName || t('htmlShare');
  if (sourceType === HtmlShareSourceType.HtmlFile) {
    if (!artifact.filePath) return null;
    return {
      source: HtmlSharePendingSource.HtmlFile,
      sourceType,
      sessionId,
      artifactId: artifact.id,
      lookupKey: buildHtmlShareLookupKey(artifact, sourceType, fallbackSessionId),
      filePath: artifact.filePath,
      title,
      accessMode: HtmlShareAccessMode.Code,
    };
  }
  return {
    source: HtmlSharePendingSource.ArtifactFile,
    sourceType,
    sessionId,
    artifactId: artifact.id,
    lookupKey: buildHtmlShareLookupKey(artifact, sourceType, fallbackSessionId),
    title,
    accessMode: HtmlShareAccessMode.Code,
    fileName: artifact.fileName || artifact.title,
    filePath: artifact.filePath,
    content: artifact.content,
    remoteUrl:
      sourceType === HtmlShareSourceType.DocumentFile ||
      sourceType === HtmlShareSourceType.MarkdownFile ||
      sourceType === HtmlShareSourceType.MermaidFile
        ? undefined
        : artifact.remoteUrl,
  };
}

function isCopyableArtifact(artifact: Artifact): boolean {
  if (artifact.type === 'document' || artifact.type === 'video') return false;
  if (artifact.type === ArtifactTypeValue.LocalService) return false;
  if (artifact.type === 'image') {
    const filename = artifact.fileName || artifact.filePath || '';
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    return COPYABLE_IMAGE_EXTENSIONS.has(ext);
  }
  return true;
}

function dataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to convert image to blob'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

function buildBrowserHtml(artifact: Artifact): string | null {
  switch (artifact.type) {
    case 'html':
      return artifact.content;
    case 'svg':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${artifact.title}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}</style></head><body>${artifact.content}</body></html>`;
    case 'mermaid':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${artifact.title}</title><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:system-ui,sans-serif}</style></head><body><pre class="mermaid">${escapeHtml(artifact.content)}</pre><script>mermaid.initialize({startOnLoad:true,theme:'default',securityLevel:'loose'});<\/script></body></html>`;
    default:
      return null;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface ArtifactPanelProps {
  sessionId: string;
  artifacts: Artifact[];
  workingDirectory?: string;
  activeSpecialTab?: ArtifactSpecialTab;
  minPanelWidth?: number;
  maxPanelWidth?: number;
  isPanelExpanded?: boolean;
  browserAddress?: string;
  browserUrl?: string;
  browserLocalServiceContext?: BrowserLocalServiceContext | null;
  browserHtmlArtifactId?: string | null;
  onBrowserAddressChange?: (value: string) => void;
  onBrowserUrlChange?: (value: string) => void;
  onBrowserTitleChange?: (value: string) => void;
  onBrowserLocalServiceContextChange?: (context: BrowserLocalServiceContext | null) => void;
  onOpenFileListTab?: () => void;
  onOpenBrowserTab?: () => void;
  onOpenHtmlFileInBrowser?: (artifact: Artifact) => void;
  onBrowserAnnotationCaptured?: (payload: BrowserAnnotationPayload) => void;
  onAddSelectedText?: (snippet: CoworkSelectedTextSnippet) => void;
  selectedTextEnabled?: boolean;
  subagentPanel?: React.ReactNode;
}

export const BrowserAnnotationShape = {
  Rectangle: 'rectangle',
} as const;

export type BrowserAnnotationShape =
  (typeof BrowserAnnotationShape)[keyof typeof BrowserAnnotationShape];

export const BrowserAnnotationColor = {
  Blue: 'blue',
} as const;

export type BrowserAnnotationColor =
  (typeof BrowserAnnotationColor)[keyof typeof BrowserAnnotationColor];

export interface BrowserAnnotationElementInfo {
  tagName: string;
  text: string;
  color: string;
  fontFamily: string;
  width: number;
  height: number;
}

export interface BrowserAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserAnnotationScreenshotInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface BrowserAnnotationMarkInfo extends BrowserAnnotationRect {
  shape: BrowserAnnotationShape;
  color: BrowserAnnotationColor;
}

export interface BrowserAnnotationPayload {
  comment: string;
  imageDataUrl: string;
  pageUrl: string;
  pageTitle: string;
  screenshot: BrowserAnnotationScreenshotInfo;
  annotation: BrowserAnnotationMarkInfo;
  element: BrowserAnnotationElementInfo;
}

const ArtifactPanel: React.FC<ArtifactPanelProps> = ({
  sessionId,
  artifacts,
  workingDirectory = '',
  activeSpecialTab = ArtifactSpecialTab.FileList,
  minPanelWidth = MIN_PANEL_WIDTH,
  maxPanelWidth = MAX_PANEL_WIDTH,
  isPanelExpanded = false,
  browserAddress: controlledBrowserAddress,
  browserUrl: controlledBrowserUrl,
  browserLocalServiceContext,
  browserHtmlArtifactId,
  onBrowserAddressChange,
  onBrowserUrlChange,
  onBrowserTitleChange,
  onBrowserLocalServiceContextChange,
  onOpenFileListTab,
  onOpenBrowserTab,
  onOpenHtmlFileInBrowser,
  onBrowserAnnotationCaptured,
  onAddSelectedText,
  selectedTextEnabled = false,
  subagentPanel,
}) => {
  const dispatch = useDispatch();
  const panelWidth = useSelector(selectPanelWidth);
  const activePreviewTab = useSelector((state: RootState) =>
    selectActivePreviewTab(state, sessionId),
  );
  const authState = useSelector((state: RootState) => state.auth);
  const [showFileListDrawer, setShowFileListDrawer] = useState(false);
  const [isFileListDrawerVisible, setIsFileListDrawerVisible] = useState(false);
  const [localBrowserAddress, setLocalBrowserAddress] = useState('');
  const [localBrowserUrl, setLocalBrowserUrl] = useState('');
  const [htmlSharePhase, setHtmlSharePhase] = useState<HtmlSharePhase>(HtmlSharePhase.Idle);
  const [htmlShareDialog, setHtmlShareDialog] = useState<HtmlShareDialogState | null>(null);
  const [htmlSharePendingRequest, setHtmlSharePendingRequest] =
    useState<HtmlSharePendingRequest | null>(null);
  const [htmlShareLookup, setHtmlShareLookup] = useState<HtmlShareLookupState | null>(null);
  const [nodeDeploymentLookup, setNodeDeploymentLookup] =
    useState<NodeDeploymentLookupState | null>(null);
  const [nodeDeploymentDialog, setNodeDeploymentDialog] =
    useState<NodeDeploymentDialogState | null>(null);
  const [isNodeDeploymentDialogOpen, setIsNodeDeploymentDialogOpen] = useState(false);
  const [isNodeDeploymentAdvancedOpen, setIsNodeDeploymentAdvancedOpen] = useState(false);
  const [isNodeDeploymentBusy, setIsNodeDeploymentBusy] = useState(false);
  const [isNodeDeploymentStatusUpdating, setIsNodeDeploymentStatusUpdating] = useState(false);
  const [isHtmlShareStatusUpdating, setIsHtmlShareStatusUpdating] = useState(false);
  const [htmlShareCopyStatus, setHtmlShareCopyStatus] =
    useState<HtmlShareCopyStatus>(HtmlShareCopyStatus.Idle);
  const [isArtifactActionsMenuOpen, setIsArtifactActionsMenuOpen] = useState(false);
  const [officePreviewZoomControls, setOfficePreviewZoomControls] =
    useState<OfficePreviewZoomControlsConfig | null>(null);
  const fileListDrawerRef = useRef<HTMLDivElement>(null);
  const fileListButtonRef = useRef<HTMLButtonElement>(null);
  const artifactActionsMenuRef = useRef<HTMLDivElement>(null);
  const artifactActionsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const fileListDrawerAnimationFrameRef = useRef<number | undefined>(undefined);
  const fileListDrawerCloseTimeoutRef = useRef<number | undefined>(undefined);
  const htmlShareCopyStatusTimerRef = useRef<number | undefined>(undefined);
  const nodeDeploymentAnalysisRunIdRef = useRef(0);
  const nodeDeploymentActionRunIdRef = useRef(0);

  const previewableArtifacts = artifacts.filter(a => PREVIEWABLE_ARTIFACT_TYPES.has(a.type));
  const artifactsById = useMemo(
    () => new Map(artifacts.map(artifact => [artifact.id, artifact])),
    [artifacts],
  );
  const selectedArtifact = activePreviewTab
    ? (artifactsById.get(activePreviewTab.artifactId) ?? null)
    : null;
  const browserHtmlArtifact = browserHtmlArtifactId
    ? (artifactsById.get(browserHtmlArtifactId) ?? null)
    : null;
  const isBrowserTabActive = !selectedArtifact && activeSpecialTab === ArtifactSpecialTab.Browser;
  const htmlShareArtifact =
    selectedArtifact &&
    getHtmlShareSourceTypeForArtifact(selectedArtifact) &&
    hasShareableArtifactSource(
      selectedArtifact,
      getHtmlShareSourceTypeForArtifact(selectedArtifact),
    )
      ? selectedArtifact
      : isBrowserTabActive &&
          browserHtmlArtifact?.type === ArtifactTypeValue.Html &&
          hasShareableArtifactSource(browserHtmlArtifact, HtmlShareSourceType.HtmlFile)
        ? browserHtmlArtifact
        : null;
  const selectedShareSourceType = htmlShareArtifact
    ? getHtmlShareSourceTypeForArtifact(htmlShareArtifact)
    : null;
  const selectedShareLookupKey =
    htmlShareArtifact && selectedShareSourceType
      ? buildHtmlShareLookupKey(htmlShareArtifact, selectedShareSourceType, sessionId)
      : undefined;
  const selectedHtmlShare =
    selectedShareLookupKey && htmlShareLookup?.sourceKey === selectedShareLookupKey
      ? htmlShareLookup.share
      : undefined;
  const selectedArtifactId = selectedArtifact?.id ?? null;
  const activeTab = activePreviewTab?.contentView ?? ArtifactContentView.Preview;
  const canShowCodeView = Boolean(selectedArtifact && !NON_CODE_TYPES.has(selectedArtifact.type));
  const isCodeViewActive = canShowCodeView && activeTab === ArtifactContentView.Code;
  const contentViewActionTarget = isCodeViewActive
    ? ArtifactContentView.Preview
    : ArtifactContentView.Code;
  const contentViewActionLabel = isCodeViewActive
    ? t('artifactPreview')
    : t('artifactCode');
  const selectedTextContext = useMemo(
    () => (
      selectedTextEnabled && onAddSelectedText
        ? { enabled: true, onAddSelectedText }
        : undefined
    ),
    [onAddSelectedText, selectedTextEnabled],
  );
  const reportSelectedArtifactAction = useCallback((
    actionType: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => {
    reportArtifactPreviewAction({
      actionType,
      source: 'artifact_panel',
      artifact: selectedArtifact,
      params: {
        tabCount: artifacts.length,
        isPanelExpanded,
        contentView: activeTab,
        ...params,
      },
    });
  }, [activeTab, artifacts.length, isPanelExpanded, selectedArtifact]);

  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const previousBodyCursor = useRef('');
  const [panelIsResizing, setPanelIsResizing] = useState(false);
  const constrainedMaxPanelWidth = isPanelExpanded
    ? Math.max(MIN_PANEL_WIDTH, maxPanelWidth)
    : Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, maxPanelWidth),
      );
  const constrainedMinPanelWidth = Math.min(
    constrainedMaxPanelWidth,
    Math.max(MIN_PANEL_WIDTH, minPanelWidth),
  );
  const constrainedPanelWidth = Math.max(
    constrainedMinPanelWidth,
    Math.min(constrainedMaxPanelWidth, panelWidth),
  );
  const browserAddress = controlledBrowserAddress ?? localBrowserAddress;
  const browserUrl = controlledBrowserUrl ?? localBrowserUrl;
  const browserLocalService = isBrowserTabActive
    ? parseLocalServiceUrl(browserUrl || browserAddress)
    : null;
  const browserLocalServiceUrl = browserLocalService?.url;
  const browserLocalServiceOrigin = browserLocalServiceUrl
    ? normalizeLocalServiceOriginForCompare(browserLocalServiceUrl)
    : '';
  const contextLocalServiceOrigin = browserLocalServiceContext
    ? normalizeLocalServiceOriginForCompare(browserLocalServiceContext.origin || browserLocalServiceContext.url)
    : '';
  const browserLocalServiceContextMatches = Boolean(
    browserLocalServiceOrigin &&
      browserLocalServiceOrigin === contextLocalServiceOrigin,
  );
  const browserLocalServiceProjectDirectory = browserLocalServiceOrigin &&
    browserLocalServiceContextMatches
    ? browserLocalServiceContext?.projectDirectory?.trim() ||
      readNodeDeploymentProjectDirectory(sessionId, browserLocalServiceUrl)
    : readNodeDeploymentProjectDirectory(sessionId, browserLocalServiceUrl);
  const browserLocalServiceProjectCandidates = useMemo(
    () => browserLocalServiceContextMatches
      ? browserLocalServiceContext?.projectCandidates ?? []
      : [],
    [
      browserLocalServiceContext?.projectCandidates,
      browserLocalServiceContextMatches,
    ],
  );
  const selectedNodeDeploymentLookupKey = browserLocalServiceUrl
    ? getNodeDeploymentLookupKey(sessionId, browserLocalServiceUrl, browserLocalServiceProjectDirectory)
    : undefined;
  const selectedNodeDeployment =
    selectedNodeDeploymentLookupKey &&
    nodeDeploymentLookup?.sourceKey === selectedNodeDeploymentLookupKey
      ? nodeDeploymentLookup.deployment
      : undefined;
  const hasActiveNodeDeploymentStatus = Boolean(
    selectedNodeDeployment ||
      (isNodeDeploymentDialogForLocalService(nodeDeploymentDialog, browserLocalService) &&
        isSubmittedNodeDeploymentDialog(nodeDeploymentDialog)),
  );
  const isHtmlSharing =
    htmlSharePhase === HtmlSharePhase.Checking ||
    htmlSharePhase === HtmlSharePhase.Packing ||
    htmlSharePhase === HtmlSharePhase.Uploading;
  let htmlShareButtonTitle = selectedHtmlShare ? t('htmlShareUpdateShare') : t('htmlShare');
  if (htmlSharePhase === HtmlSharePhase.Checking) {
    htmlShareButtonTitle = t('htmlShareScanning');
  } else if (htmlSharePhase === HtmlSharePhase.Packing) {
    htmlShareButtonTitle = t('htmlSharePacking');
  } else if (htmlSharePhase === HtmlSharePhase.Uploading) {
    htmlShareButtonTitle = t('htmlShareUploading');
  }
  const htmlShareButtonClass = selectedHtmlShare
    ? 'p-1 rounded bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50'
    : 'p-1 rounded text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';
  const canShareHtmlArtifact = Boolean(
    htmlShareArtifact &&
      selectedShareSourceType &&
      selectedShareLookupKey &&
      hasShareableArtifactSource(htmlShareArtifact, selectedShareSourceType),
  );
  const canShareLocalService = Boolean(browserLocalService);
  const nodeDeploymentButtonTitle = hasActiveNodeDeploymentStatus
    ? t('nodeDeploymentStatusTitle')
    : isNodeDeploymentBusy
      ? t('nodeDeploymentPreparing')
      : selectedNodeDeployment
        ? t('htmlShareUpdateShare')
        : t('nodeDeploymentShare');
  const browserShareButtonTitle = canShareHtmlArtifact
    ? htmlShareButtonTitle
    : nodeDeploymentButtonTitle;
  const browserCanShare = canShareHtmlArtifact || canShareLocalService;
  const browserHasExistingShare = canShareHtmlArtifact
    ? Boolean(selectedHtmlShare)
    : hasActiveNodeDeploymentStatus;
  const browserHtmlAutoRefreshFilePath =
    isBrowserTabActive && browserHtmlArtifact?.type === ArtifactTypeValue.Html
      ? browserHtmlArtifact.filePath
      : undefined;
  const browserHtmlPreviewUrl = browserHtmlAutoRefreshFilePath ? browserUrl : undefined;
  const canUseHtmlShareDialogLink = Boolean(
    htmlShareDialog?.url &&
      !isHtmlShareStatusUpdating &&
      htmlShareDialog.status !== HtmlShareStatus.Disabled &&
      htmlShareDialog.status !== HtmlShareStatus.Failed,
  );
  const canRestoreActiveLimitDisabledHtmlShare = Boolean(
    htmlShareDialog?.kind === HtmlShareDialogKind.Existing &&
      htmlShareDialog.status === HtmlShareStatus.Disabled &&
      htmlShareDialog.disabledSource === HtmlShareDisabledSource.ActiveLimit,
  );
  const isHtmlShareContentUpdateDisabled = Boolean(
    isHtmlShareStatusUpdating ||
      htmlShareDialog?.status === HtmlShareStatus.Disabled ||
      htmlShareDialog?.targetStatus === HtmlShareStatus.Disabled,
  );
  const isCompactHtmlToolbar = selectedArtifact?.type === ArtifactTypeValue.Html;
  const isCompactArtifactToolbar = Boolean(selectedArtifact);
  const showRefreshAction = Boolean(selectedArtifact?.filePath);
  const showCopyAction = Boolean(selectedArtifact && isCopyableArtifact(selectedArtifact));
  const showOpenBrowserAction = Boolean(
    selectedArtifact && BROWSER_OPENABLE_TYPES.has(selectedArtifact.type),
  );
  const showOpenWithAppAction = Boolean(
    selectedArtifact &&
      SYSTEM_OPENABLE_TYPES.has(selectedArtifact.type) &&
      selectedArtifact.filePath,
  );
  const showRevealInFolderAction = Boolean(selectedArtifact?.filePath);
  const showPrimaryOpenWithAppAction = Boolean(!isCompactHtmlToolbar && showOpenWithAppAction);
  const showPrimaryRevealInFolderAction = Boolean(
    !isCompactHtmlToolbar &&
      !showPrimaryOpenWithAppAction &&
      showRevealInFolderAction,
  );
  const showOpenBrowserActionInMenu = Boolean(!isCompactHtmlToolbar && showOpenBrowserAction);
  const showOpenWithAppActionInMenu = Boolean(isCompactHtmlToolbar && showOpenWithAppAction);
  const showRevealInFolderActionInMenu = Boolean(
    showRevealInFolderAction && !showPrimaryRevealInFolderAction,
  );
  const showContentViewActionInMenu = canShowCodeView;
  const showOfficeZoomControlsInMenu = Boolean(officePreviewZoomControls);
  const hasArtifactActionMenuItems = Boolean(
    showContentViewActionInMenu ||
      showRefreshAction ||
      showCopyAction ||
      showOpenBrowserActionInMenu ||
      showOpenWithAppActionInMenu ||
      showRevealInFolderActionInMenu,
  );
  const showArtifactActionsMenu = Boolean(
    isCompactArtifactToolbar &&
      (hasArtifactActionMenuItems || showOfficeZoomControlsInMenu),
  );
  const officePreviewActionsContextValue = useMemo(
    () => ({
      setZoomControls: setOfficePreviewZoomControls,
    }),
    [],
  );

  const handleBrowserAddressChange = useCallback(
    (value: string) => {
      setLocalBrowserAddress(value);
      onBrowserAddressChange?.(value);
    },
    [onBrowserAddressChange],
  );

  const handleBrowserUrlChange = useCallback(
    (value: string) => {
      setLocalBrowserUrl(value);
      onBrowserUrlChange?.(value);
    },
    [onBrowserUrlChange],
  );

  const handleBrowserLocalServiceOpen = useCallback(
    (service: LocalWebService) => {
      onBrowserLocalServiceContextChange?.({
        url: service.url,
        origin: normalizeLocalServiceOriginForCompare(service.url),
        ...(service.projectDirectory?.trim()
          ? { projectDirectory: service.projectDirectory.trim() }
          : {}),
        ...(service.projectCandidates?.length
          ? { projectCandidates: service.projectCandidates }
          : {}),
      });
    },
    [onBrowserLocalServiceContextChange],
  );

  const openFileListDrawer = useCallback(() => {
    if (fileListDrawerCloseTimeoutRef.current !== undefined) {
      window.clearTimeout(fileListDrawerCloseTimeoutRef.current);
      fileListDrawerCloseTimeoutRef.current = undefined;
    }
    if (fileListDrawerAnimationFrameRef.current !== undefined) {
      window.cancelAnimationFrame(fileListDrawerAnimationFrameRef.current);
    }

    setShowFileListDrawer(true);
    fileListDrawerAnimationFrameRef.current = window.requestAnimationFrame(() => {
      fileListDrawerAnimationFrameRef.current = undefined;
      setIsFileListDrawerVisible(true);
    });
  }, []);

  const closeFileListDrawer = useCallback(() => {
    if (fileListDrawerAnimationFrameRef.current !== undefined) {
      window.cancelAnimationFrame(fileListDrawerAnimationFrameRef.current);
      fileListDrawerAnimationFrameRef.current = undefined;
    }
    if (fileListDrawerCloseTimeoutRef.current !== undefined) {
      window.clearTimeout(fileListDrawerCloseTimeoutRef.current);
    }

    setIsFileListDrawerVisible(false);
    fileListDrawerCloseTimeoutRef.current = window.setTimeout(() => {
      setShowFileListDrawer(false);
      fileListDrawerCloseTimeoutRef.current = undefined;
    }, FILE_LIST_DRAWER_TRANSITION_MS);
  }, []);

  const toggleFileListDrawer = useCallback(() => {
    if (showFileListDrawer && isFileListDrawerVisible) {
      reportSelectedArtifactAction('file_list_drawer_toggle', {
        targetOpen: false,
      });
      closeFileListDrawer();
      return;
    }

    reportSelectedArtifactAction('file_list_drawer_toggle', {
      targetOpen: true,
    });
    openFileListDrawer();
  }, [
    closeFileListDrawer,
    isFileListDrawerVisible,
    openFileListDrawer,
    reportSelectedArtifactAction,
    showFileListDrawer,
  ]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isPanelExpanded) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = constrainedPanelWidth;
      previousBodyCursor.current = document.body.style.cursor;
      document.body.style.cursor = 'col-resize';
      document.body.classList.add('select-none');
      setPanelIsResizing(true);

      const stopResizing = () => {
        isResizing.current = false;
        document.body.style.cursor = previousBodyCursor.current;
        document.body.classList.remove('select-none');
        setPanelIsResizing(false);
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (!isResizing.current) return;
        moveEvent.preventDefault();
        const nextWidth = startWidth.current + startX.current - moveEvent.clientX;
        if (nextWidth < constrainedMinPanelWidth - PANEL_CLOSE_DRAG_THRESHOLD) {
          stopResizing();
          dispatch(closePanel({ sessionId }));
          return;
        }
        const clampedWidth = Math.max(
          constrainedMinPanelWidth,
          Math.min(constrainedMaxPanelWidth, nextWidth),
        );
        dispatch(setPanelWidth(clampedWidth));
      };

      const handlePointerUp = () => {
        stopResizing();
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);
    },
    [
      constrainedMaxPanelWidth,
      constrainedMinPanelWidth,
      constrainedPanelWidth,
      dispatch,
      isPanelExpanded,
      sessionId,
    ],
  );

  useEffect(() => {
    return () => {
      if (fileListDrawerAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(fileListDrawerAnimationFrameRef.current);
      }
      if (fileListDrawerCloseTimeoutRef.current !== undefined) {
        window.clearTimeout(fileListDrawerCloseTimeoutRef.current);
      }
      if (htmlShareCopyStatusTimerRef.current !== undefined) {
        window.clearTimeout(htmlShareCopyStatusTimerRef.current);
      }
      document.body.style.cursor = previousBodyCursor.current;
      document.body.classList.remove('select-none');
    };
  }, []);

  useEffect(() => {
    if (
      !htmlShareArtifact ||
      !selectedShareSourceType ||
      !selectedShareLookupKey ||
      !authState.isLoggedIn ||
      authState.quota?.subscriptionStatus !== 'active'
    ) {
      setHtmlShareLookup(null);
      return;
    }

    let isCancelled = false;
    const htmlShareApi = window.electron?.htmlShare;

    setHtmlShareLookup(previous => {
      if (previous?.sourceKey === selectedShareLookupKey && previous.share) {
        return previous;
      }
      return { sourceKey: selectedShareLookupKey, isLoading: true };
    });

    if (!htmlShareApi) {
      setHtmlShareLookup({ sourceKey: selectedShareLookupKey, isLoading: false });
      return () => {
        isCancelled = true;
      };
    }

    const lookupPromise =
      selectedShareSourceType === HtmlShareSourceType.HtmlFile
        ? htmlShareApi.getByHtmlFile({ filePath: htmlShareArtifact.filePath || '' })
        : htmlShareApi.getByArtifactFile({
            sourceType: selectedShareSourceType,
            sessionId: htmlShareArtifact.sessionId || sessionId,
            artifactId: htmlShareArtifact.id,
            filePath: htmlShareArtifact.filePath,
          });

    lookupPromise
      .then(lookup => {
        if (isCancelled) return;
        const share = lookup?.success ? getExistingHtmlShareInfo(lookup.share) : null;
        setHtmlShareLookup(previous => {
          if (!share && previous?.sourceKey === selectedShareLookupKey && previous.share) {
            return previous;
          }
          return {
            sourceKey: selectedShareLookupKey,
            isLoading: false,
            ...(share ? { share } : {}),
          };
        });
      })
      .catch(() => {
        if (isCancelled) return;
        setHtmlShareLookup(previous => {
          if (previous?.sourceKey === selectedShareLookupKey && previous.share) {
            return previous;
          }
          return { sourceKey: selectedShareLookupKey, isLoading: false };
        });
      });

    return () => {
      isCancelled = true;
    };
  }, [
    authState.isLoggedIn,
    authState.quota?.subscriptionStatus,
    htmlShareArtifact,
    htmlShareArtifact?.filePath,
    htmlShareArtifact?.id,
    htmlShareArtifact?.sessionId,
    selectedShareLookupKey,
    selectedShareSourceType,
    sessionId,
  ]);

  useEffect(() => {
    if (
      !browserLocalServiceUrl ||
      !selectedNodeDeploymentLookupKey ||
      !authState.isLoggedIn ||
      authState.quota?.subscriptionStatus !== 'active'
    ) {
      setNodeDeploymentLookup(null);
      return;
    }

    let isCancelled = false;
    const shareDeploymentApi = window.electron?.shareDeployment;

    setNodeDeploymentLookup(previous => {
      if (previous?.sourceKey === selectedNodeDeploymentLookupKey && previous.deployment) {
        return previous;
      }
      return { sourceKey: selectedNodeDeploymentLookupKey, isLoading: true };
    });

    if (!shareDeploymentApi) {
      setNodeDeploymentLookup({
        sourceKey: selectedNodeDeploymentLookupKey,
        isLoading: false,
      });
      return () => {
        isCancelled = true;
      };
    }

    shareDeploymentApi
      .getByLocalService({
        sessionId,
        localServiceUrl: browserLocalServiceUrl,
        projectDirectory: browserLocalServiceProjectDirectory,
      })
      .then(result => {
        if (isCancelled) return;
        const deployment = result?.success ? result.deployment : null;
        setNodeDeploymentLookup(previous => {
          if (
            !deployment &&
            previous?.sourceKey === selectedNodeDeploymentLookupKey &&
            previous.deployment
          ) {
            return previous;
          }
          return {
            sourceKey: selectedNodeDeploymentLookupKey,
            isLoading: false,
            deployment: deployment ?? null,
          };
        });
      })
      .catch(() => {
        if (isCancelled) return;
        setNodeDeploymentLookup(previous => {
          if (previous?.sourceKey === selectedNodeDeploymentLookupKey && previous.deployment) {
            return previous;
          }
          return {
            sourceKey: selectedNodeDeploymentLookupKey,
            isLoading: false,
            deployment: null,
          };
        });
      });

    return () => {
      isCancelled = true;
    };
  }, [
    authState.isLoggedIn,
    authState.quota?.subscriptionStatus,
    browserLocalServiceUrl,
    browserLocalServiceProjectDirectory,
    selectedNodeDeploymentLookupKey,
    sessionId,
  ]);

  useEffect(() => {
    if (htmlShareCopyStatusTimerRef.current !== undefined) {
      window.clearTimeout(htmlShareCopyStatusTimerRef.current);
      htmlShareCopyStatusTimerRef.current = undefined;
    }
    setHtmlShareCopyStatus(HtmlShareCopyStatus.Idle);
  }, [htmlShareDialog?.shareId, htmlShareDialog?.url]);

  useEffect(() => {
    if (nodeDeploymentDialog?.kind !== NodeDeploymentDialogKind.Confirm) {
      setIsNodeDeploymentAdvancedOpen(false);
    }
  }, [nodeDeploymentDialog?.kind]);

  useEffect(() => {
    if (selectedArtifact) return;
    closeFileListDrawer();
    setIsArtifactActionsMenuOpen(false);
  }, [closeFileListDrawer, selectedArtifact]);

  useEffect(() => {
    closeFileListDrawer();
    setIsArtifactActionsMenuOpen(false);
  }, [activePreviewTab?.id, closeFileListDrawer]);

  useEffect(() => {
    if (!isArtifactActionsMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        artifactActionsMenuRef.current?.contains(target) ||
        artifactActionsMenuButtonRef.current?.contains(target)
      ) {
        return;
      }
      setIsArtifactActionsMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsArtifactActionsMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isArtifactActionsMenuOpen]);

  useEffect(() => {
    if (!showFileListDrawer) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        fileListDrawerRef.current?.contains(target) ||
        fileListButtonRef.current?.contains(target)
      ) {
        return;
      }
      closeFileListDrawer();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeFileListDrawer();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeFileListDrawer, showFileListDrawer]);

  // Auto-refresh when the previewed file changes on disk
  useEffect(() => {
    const filePath = selectedArtifact?.filePath;
    if (!filePath) return;

    let cleanup: (() => void) | undefined;
    let watchedPath: string | null = null;

    window.electron?.artifact?.watchFile(filePath);
    watchedPath = filePath;

    cleanup = window.electron?.artifact?.onFileChanged(({ filePath: changedPath }) => {
      if (changedPath === watchedPath) {
        handleRefreshRef.current();
      }
    });

    return () => {
      if (cleanup) cleanup();
      if (watchedPath) window.electron?.artifact?.unwatchFile(watchedPath);
    };
  }, [selectedArtifact?.filePath]);

  const openLocalServiceArtifact = useCallback(
    (artifact: Artifact): boolean => {
      if (artifact.type !== ArtifactTypeValue.LocalService) return false;
      const url = artifact.url || artifact.content;
      if (!url) return true;
      onOpenBrowserTab?.();
      handleBrowserAddressChange(url);
      handleBrowserUrlChange(url);
      return true;
    },
    [handleBrowserAddressChange, handleBrowserUrlChange, onOpenBrowserTab],
  );

  const handleSelectArtifact = useCallback(
    (id: string) => {
      const artifact = artifacts.find(item => item.id === id);
      reportArtifactPreviewAction({
        actionType: 'file_list_select_artifact',
        source: 'artifact_panel',
        artifact,
        params: {
          tabCount: artifacts.length,
          entry: 'file_list',
        },
      });
      if (artifact && openLocalServiceArtifact(artifact)) return;
      if (artifact?.type === ArtifactTypeValue.Html && artifact.filePath && onOpenHtmlFileInBrowser) {
        onOpenHtmlFileInBrowser(artifact);
        return;
      }
      onOpenFileListTab?.();
      dispatch(openArtifactPreviewTab({ sessionId, artifactId: id }));
    },
    [
      artifacts,
      dispatch,
      onOpenFileListTab,
      onOpenHtmlFileInBrowser,
      openLocalServiceArtifact,
      sessionId,
    ],
  );

  const handleSelectArtifactFromDrawer = useCallback(
    (id: string) => {
      const artifact = artifacts.find(item => item.id === id);
      reportArtifactPreviewAction({
        actionType: 'file_list_select_artifact',
        source: 'artifact_panel',
        artifact,
        params: {
          tabCount: artifacts.length,
          entry: 'drawer',
        },
      });
      if (artifact && openLocalServiceArtifact(artifact)) {
        closeFileListDrawer();
        return;
      }
      if (artifact?.type === ArtifactTypeValue.Html && artifact.filePath && onOpenHtmlFileInBrowser) {
        onOpenHtmlFileInBrowser(artifact);
        closeFileListDrawer();
        return;
      }
      dispatch(openArtifactPreviewTab({ sessionId, artifactId: id }));
      closeFileListDrawer();
    },
    [
      artifacts,
      closeFileListDrawer,
      dispatch,
      onOpenHtmlFileInBrowser,
      openLocalServiceArtifact,
      sessionId,
    ],
  );

  const handleSetContentView = useCallback(
    (contentView: ArtifactContentView) => {
      if (!activePreviewTab) return;
      reportSelectedArtifactAction('content_view_change', {
        targetContentView: contentView,
      });
      dispatch(
        setPreviewTabContentView({
          sessionId,
          tabId: activePreviewTab.id,
          contentView,
        }),
      );
    },
    [activePreviewTab, dispatch, reportSelectedArtifactAction, sessionId],
  );

  const handleCopy = useCallback(async () => {
    if (!selectedArtifact) return;
    try {
      if (selectedArtifact.type === 'image') {
        if (selectedArtifact.filePath) {
          const result = await window.electron?.clipboard?.writeImageFromFile(
            selectedArtifact.filePath,
          );
          if (!result?.success) {
            reportSelectedArtifactAction('copy_content', { result: 'failed' });
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: result?.error || t('copyFailed') }),
            );
            return;
          }
        } else if (selectedArtifact.content) {
          const blob = await dataUrlToPngBlob(selectedArtifact.content);
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        }
      } else {
        if (selectedArtifact.filePath && !selectedArtifact.content && selectedArtifact.type !== 'document') {
          const result = await window.electron?.dialog?.readTextFile?.(selectedArtifact.filePath);
          if (!result?.success || typeof result.content !== 'string') {
            reportSelectedArtifactAction('copy_content', { result: 'failed' });
            window.dispatchEvent(new CustomEvent('app:showToast', { detail: result?.error || t('copyFailed') }));
            return;
          }
          await navigator.clipboard.writeText(result.content);
        } else {
          await navigator.clipboard.writeText(selectedArtifact.content);
        }
      }
      reportSelectedArtifactAction('copy_content', { result: 'success' });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('messageCopied') }));
    } catch {
      reportSelectedArtifactAction('copy_content', { result: 'failed' });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('copyFailed') }));
    }
  }, [reportSelectedArtifactAction, selectedArtifact]);

  const handleRevealInFolder = useCallback(() => {
    if (!selectedArtifact?.filePath) return;
    reportSelectedArtifactAction('reveal_in_folder', {
      openTarget: 'folder',
    });
    void revealLocalPathWithToast(selectedArtifact.filePath);
  }, [reportSelectedArtifactAction, selectedArtifact]);

  const handleOpenInBrowser = useCallback(() => {
    if (!selectedArtifact) return;
    reportSelectedArtifactAction('open_in_browser', {
      openTarget: selectedArtifact.type === ArtifactTypeValue.Html ? 'lobster_browser' : 'external_browser',
    });

    if (
      selectedArtifact.type === ArtifactTypeValue.Html &&
      selectedArtifact.filePath &&
      onOpenHtmlFileInBrowser
    ) {
      onOpenHtmlFileInBrowser(selectedArtifact);
      return;
    }

    // Mermaid needs HTML wrapper with mermaid.js to render in browser
    if (selectedArtifact.type === 'mermaid') {
      if (!selectedArtifact.content) return;
      const html = buildBrowserHtml(selectedArtifact);
      if (html) {
        window.electron?.shell?.openHtmlInBrowser(html);
      }
      return;
    }

    // Has file on disk: open directly via native path
    // NOTE: shell.openExternal with file:// URLs fails on Windows when path contains
    // non-ASCII characters (e.g. Chinese) — ERROR_FILE_NOT_FOUND (0x2).
    // Use shell.openPath which handles native Unicode paths correctly.
    if (selectedArtifact.filePath) {
      void openLocalPathWithToast(selectedArtifact.filePath);
      return;
    }

    // No file path: generate HTML and open via temp file
    if (!selectedArtifact.content) return;
    const html = buildBrowserHtml(selectedArtifact);
    if (html) {
      window.electron?.shell?.openHtmlInBrowser(html);
    }
  }, [onOpenHtmlFileInBrowser, reportSelectedArtifactAction, selectedArtifact]);

  const openSubscriptionPage = useCallback(() => {
    window.electron?.shell?.openExternal(getPortalPricingUrl(PortalPricingKeyfrom.HtmlShare));
    setHtmlShareDialog(null);
  }, []);

  const formatShareClipboardText = useCallback((url: string, shareCode?: string): string => {
    const linkLine = `${t('htmlShareClipboardLinkLabel')}: ${url}`;
    if (!shareCode) return linkLine;
    return `${linkLine}\n${t('htmlShareCode')}: ${shareCode}`;
  }, []);

  const showHtmlShareCopyStatus = useCallback((status: HtmlShareCopyStatus) => {
    if (htmlShareCopyStatusTimerRef.current !== undefined) {
      window.clearTimeout(htmlShareCopyStatusTimerRef.current);
    }
    setHtmlShareCopyStatus(status);
    htmlShareCopyStatusTimerRef.current = window.setTimeout(() => {
      setHtmlShareCopyStatus(HtmlShareCopyStatus.Idle);
      htmlShareCopyStatusTimerRef.current = undefined;
    }, 2200);
  }, []);

  const ensureHtmlShareAllowed = useCallback(async (): Promise<boolean> => {
    let latestIsLoggedIn = authState.isLoggedIn;
    let latestQuota = authState.quota;

    if (!latestIsLoggedIn || latestQuota?.subscriptionStatus !== 'active') {
      const refreshed = await authService.refreshAuthState();
      latestIsLoggedIn = refreshed.isLoggedIn;
      latestQuota = refreshed.quota;
    }

    if (!latestIsLoggedIn) {
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Subscription,
        title: t('htmlShareLoginRequiredTitle'),
        message: t('htmlShareLoginRequiredMessage'),
      });
      return false;
    }
    if (latestQuota?.subscriptionStatus !== 'active') {
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Subscription,
        title: t('htmlShareSubscriptionRequiredTitle'),
        message: t('htmlShareSubscriptionRequiredMessage'),
      });
      return false;
    }
    return true;
  }, [authState.isLoggedIn, authState.quota]);

  const handleCopyShareLink = useCallback(
    async (url?: string, shareCode?: string) => {
      if (!url) return;
      const copied = await copyTextToClipboard(formatShareClipboardText(url, shareCode));
      if (copied) {
        showHtmlShareCopyStatus(HtmlShareCopyStatus.Copied);
        return;
      }
      showHtmlShareCopyStatus(HtmlShareCopyStatus.Failed);
    },
    [formatShareClipboardText, showHtmlShareCopyStatus],
  );

  const openExistingHtmlShareDialog = useCallback(
    (
      request: HtmlSharePendingRequest,
      share: ExistingHtmlShareInfo,
    ) => {
      const accessMode = normalizeHtmlShareAccessMode(share.accessMode);
      setHtmlSharePendingRequest(request);
      setHtmlSharePhase(HtmlSharePhase.Live);
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Existing,
        title: t('htmlShareManageDialogTitle'),
        message: shouldUseHtmlShareCode(accessMode)
          ? t('htmlShareCodeViewHint')
          : t('htmlSharePublicViewHint'),
        shareId: share.shareId,
        url: share.url,
        accessMode,
        selectedAccessMode: accessMode,
        shareCode: share.shareCode,
        shareCodeUnavailable: share.shareCodeUnavailable,
        status: share.status,
        disabledSource: share.disabledSource,
        targetStatus: getConfigurableHtmlShareStatus(share.status),
      });
    },
    [],
  );

  const openCreateHtmlShareDialog = useCallback((request: HtmlSharePendingRequest) => {
    const accessMode = normalizeHtmlShareAccessMode(request.accessMode);
    setHtmlSharePendingRequest({ ...request, accessMode });
    setHtmlSharePhase(HtmlSharePhase.Idle);
    setHtmlShareDialog({
      kind: HtmlShareDialogKind.Create,
      title: t('htmlShareCreateDialogTitle'),
      message: t('htmlShareCodeViewHint'),
      selectedAccessMode: accessMode,
    });
  }, []);

  const rememberHtmlShare = useCallback((sourceKey: string, share: unknown) => {
    const existingShare = getExistingHtmlShareInfo(
      share as {
        shareId?: string;
        url?: string;
        accessMode?: HtmlShareAccessModeValue;
        shareCode?: string;
        shareCodeUnavailable?: boolean;
        status?: HtmlShareStatusValue;
        disabledSource?: HtmlShareDisabledSourceValue | null;
      } | null | undefined,
    );
    if (!existingShare) return;
    setHtmlShareLookup({
      sourceKey,
      isLoading: false,
      share: existingShare,
    });
  }, []);

  const rememberNodeDeployment = useCallback((
    sourceKey: string | undefined,
    deployment: ShareDeploymentRecord | null | undefined,
  ) => {
    if (!sourceKey || !deployment) return;
    setNodeDeploymentLookup({
      sourceKey,
      isLoading: false,
      deployment,
    });
  }, []);

  const handleHtmlShareResult = useCallback(
    (
      result: Awaited<
        ReturnType<NonNullable<typeof window.electron>['htmlShare']['createFromHtmlFile']>
      >,
      action: 'create' | 'update' = 'create',
    ) => {
      if (!result?.success || !result.url) {
        if (result?.code === HtmlShareErrorCode.SubscriptionRequired) {
          setHtmlShareDialog({
            kind: HtmlShareDialogKind.Subscription,
            title: t('htmlShareSubscriptionRequiredTitle'),
            message: t('htmlShareSubscriptionRequiredMessage'),
          });
          setHtmlSharePhase(HtmlSharePhase.Failed);
          return;
        }
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const accessMode = normalizeHtmlShareAccessMode(result.accessMode);
      setHtmlSharePhase(HtmlSharePhase.Live);
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Result,
        title:
          action === 'update'
            ? t('htmlShareUpdated')
            : t('htmlShareSuccess'),
        message: result.shareCodeUnavailable
          ? t('htmlShareCodeUnavailable')
          : result.warnings?.length
          ? result.warnings.slice(0, 3).join('\n')
          : action === 'update'
            ? result.status === HtmlShareStatus.Disabled
              ? t('htmlShareUpdatedClosedMessage')
              : t('htmlShareUpdateComplete')
            : shouldUseHtmlShareCode(accessMode)
              ? t('htmlShareCodeViewHint')
              : t('htmlSharePublicViewHint'),
        url: result.url,
        accessMode,
        selectedAccessMode: accessMode,
        shareCode: shouldUseHtmlShareCode(accessMode) ? result.shareCode : undefined,
        shareCodeUnavailable: result.shareCodeUnavailable,
        status: result.status,
        disabledSource: result.disabledSource,
      });
    },
    [],
  );

  const openNodeDeploymentStatusDialog = useCallback((
    deployment: ShareDeploymentRecord,
    context?: Partial<Pick<
      NodeDeploymentDialogState,
      | 'localService'
      | 'projectDirectory'
      | 'analysis'
      | 'accessMode'
      | 'nodeVersion'
      | 'installCommand'
      | 'buildCommand'
      | 'startCommand'
      | 'port'
    >>,
  ) => {
    setNodeDeploymentDialog({
      kind: NodeDeploymentDialogKind.Status,
      phase:
        deployment.status === ShareDeploymentStatus.Live
          ? NodeDeploymentPhase.Live
          : deployment.status === ShareDeploymentStatus.DeployFailed
            ? NodeDeploymentPhase.Failed
            : NodeDeploymentPhase.Deploying,
      title: t('nodeDeploymentStatusTitle'),
      message: getNodeDeploymentStatusMessage(deployment),
      ...context,
      deployment,
      accessMode: normalizeHtmlShareAccessMode(context?.accessMode ?? deployment.accessMode),
    });
  }, []);

  const buildNodeDeploymentConfirmDialog = useCallback(
    (
      localService: LocalWebService,
      projectDirectory: string,
      analysis?: ShareDeploymentProjectAnalysis,
    ): NodeDeploymentDialogState => ({
      kind: NodeDeploymentDialogKind.Confirm,
      phase: NodeDeploymentPhase.Idle,
      title: t('nodeDeploymentConfirmTitle'),
      message: t('nodeDeploymentConfirmMessage'),
      localService,
      projectDirectory,
      analysis,
      accessMode: HtmlShareAccessMode.Code,
      nodeVersion: '20',
      installCommand: analysis?.installCommand ?? 'npm install',
      buildCommand: analysis?.buildCommand ?? '',
      startCommand: analysis?.startCommand ?? '',
      port: String(localService.port),
    }),
    [],
  );

  const openNodeDeploymentAccessModeDialog = useCallback((
    localService: LocalWebService,
    projectDirectory: string,
    accessMode: HtmlShareAccessModeValue = HtmlShareAccessMode.Code,
  ) => {
    setNodeDeploymentDialog({
      kind: NodeDeploymentDialogKind.AccessMode,
      phase: NodeDeploymentPhase.Idle,
      title: t('htmlShareCreateDialogTitle'),
      message: shouldUseHtmlShareCode(accessMode)
        ? t('htmlShareCodeViewHint')
        : t('htmlSharePublicViewHint'),
      localService,
      projectDirectory,
      accessMode,
      port: String(localService.port),
    });
  }, []);

  const checkLocalServiceAvailable = useCallback(async (localService: LocalWebService): Promise<boolean> => {
    const localWebServicesApi = window.electron?.artifact?.listLocalWebServices;
    if (!localWebServicesApi) return false;
    try {
      const services = await localWebServicesApi({ preferredPorts: [localService.port] });
      return services.some(service => service.port === localService.port && service.online);
    } catch {
      return false;
    }
  }, []);

  const openLocalServiceUnavailableDialog = useCallback((
    localService: LocalWebService,
    projectDirectory?: string,
  ) => {
    setIsNodeDeploymentDialogOpen(true);
    setNodeDeploymentDialog({
      kind: NodeDeploymentDialogKind.Result,
      phase: NodeDeploymentPhase.Failed,
      title: t('nodeDeploymentLocalServiceUnavailableTitle'),
      message: t('nodeDeploymentLocalServiceUnavailableMessage'),
      localService,
      projectDirectory,
    });
  }, []);

  const confirmNodeDeploymentAccessMode = useCallback(() => {
    const currentDialog = nodeDeploymentDialog;
    if (
      !currentDialog ||
      currentDialog.kind !== NodeDeploymentDialogKind.AccessMode ||
      !currentDialog.localService
    ) {
      return;
    }

    setNodeDeploymentDialog({
      ...buildNodeDeploymentConfirmDialog(
        currentDialog.localService,
        currentDialog.projectDirectory || '',
      ),
      accessMode: normalizeHtmlShareAccessMode(currentDialog.accessMode),
    });
  }, [
    buildNodeDeploymentConfirmDialog,
    nodeDeploymentDialog,
  ]);

  const analyzeNodeDeploymentProject = useCallback(
    async (localService: LocalWebService, projectDirectory: string) => {
      const analysis = await window.electron?.shareDeployment?.analyzeProjectDirectory({
        projectDirectory,
        localServiceUrl: localService.url,
      });
      return analysis;
    },
    [],
  );

  const validateNodeDeploymentProjectDirectory = useCallback(
    async (localService: LocalWebService, projectDirectory?: string) => {
      const normalizedProjectDirectory = projectDirectory?.trim();
      if (!normalizedProjectDirectory) return undefined;
      const analysis = await analyzeNodeDeploymentProject(localService, normalizedProjectDirectory);
      return analysis?.success
        ? analysis.projectDirectory || normalizedProjectDirectory
        : undefined;
    },
    [analyzeNodeDeploymentProject],
  );

  const resolveNodeDeploymentProjectDirectory = useCallback(
    async (
      localService: LocalWebService,
      preferredProjectDirectory?: string,
      projectCandidates: ShareDeploymentProjectCandidate[] = [],
    ) => {
      const hintCandidates: ShareDeploymentProjectCandidate[] = [];
      const preferredDirectory = preferredProjectDirectory?.trim();
      if (preferredDirectory) {
        hintCandidates.push({
          directory: preferredDirectory,
          source: ShareDeploymentCandidateSource.ArtifactMetadata,
          confidence: 90,
          reason: 'Matched project directory metadata from the local service artifact.',
          detectedAt: Date.now(),
        });
      }
      hintCandidates.push(...projectCandidates);
      const cachedCandidate = readNodeDeploymentProjectDirectoryCandidate(sessionId, localService.url);
      if (cachedCandidate) {
        hintCandidates.push(cachedCandidate);
      }

      const detected = await window.electron?.shareDeployment?.detectProjectCandidates({
        localServiceUrl: localService.url,
        workingDirectory,
        projectCandidates: hintCandidates,
        cachedProjectDirectory: cachedCandidate?.directory,
      });

      for (const candidate of detected?.candidates ?? []) {
        const validDirectory = await validateNodeDeploymentProjectDirectory(
          localService,
          candidate.directory,
        );
        if (validDirectory) return validDirectory;
      }

      const validWorkingDirectory = await validateNodeDeploymentProjectDirectory(
        localService,
        workingDirectory,
      );
      return validWorkingDirectory || workingDirectory.trim() || '';
    },
    [
      sessionId,
      validateNodeDeploymentProjectDirectory,
      workingDirectory,
    ],
  );

  const handleShareLocalServiceDeployment = useCallback(async () => {
    if (!browserLocalService || isHtmlSharing) return;
    if (
      nodeDeploymentDialog &&
      (isNodeDeploymentBusy ||
        isNodeDeploymentDialogForLocalService(nodeDeploymentDialog, browserLocalService))
    ) {
      setIsNodeDeploymentDialogOpen(true);
      return;
    }
    if (isNodeDeploymentBusy) return;
    if (!(await ensureHtmlShareAllowed())) return;
    const runId = nodeDeploymentActionRunIdRef.current + 1;
    nodeDeploymentActionRunIdRef.current = runId;
    const storedProjectDirectory =
      browserLocalServiceProjectDirectory ||
      readNodeDeploymentProjectDirectory(
        sessionId,
        browserLocalService.url,
      );
    if (selectedNodeDeployment) {
      setIsNodeDeploymentDialogOpen(true);
      openNodeDeploymentStatusDialog(selectedNodeDeployment, {
        localService: browserLocalService,
        projectDirectory: storedProjectDirectory,
      });
      return;
    }

    if (!(await checkLocalServiceAvailable(browserLocalService))) {
      openLocalServiceUnavailableDialog(browserLocalService, storedProjectDirectory);
      return;
    }

    setIsNodeDeploymentBusy(true);
    setIsNodeDeploymentDialogOpen(true);
    setNodeDeploymentDialog({
      kind: NodeDeploymentDialogKind.Status,
      phase: NodeDeploymentPhase.Checking,
      title: t('nodeDeploymentPreparingTitle'),
      message: t('nodeDeploymentCheckingExisting'),
      localService: browserLocalService,
    });

    try {
      const projectDirectory = await resolveNodeDeploymentProjectDirectory(
        browserLocalService,
        storedProjectDirectory,
        browserLocalServiceProjectCandidates,
      );
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      const lookupKey = getNodeDeploymentLookupKey(
        sessionId,
        browserLocalService.url,
        projectDirectory,
      );
      const existing = await window.electron?.shareDeployment?.getByLocalService({
        sessionId,
        localServiceUrl: browserLocalService.url,
        projectDirectory,
      });
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      if (existing?.success && existing.deployment) {
        writeNodeDeploymentProjectDirectory(
          sessionId,
          browserLocalService.url,
          projectDirectory,
        );
        rememberNodeDeployment(lookupKey, existing.deployment);
        openNodeDeploymentStatusDialog(existing.deployment, {
          localService: browserLocalService,
          projectDirectory,
        });
        return;
      }

      openNodeDeploymentAccessModeDialog(browserLocalService, projectDirectory);
    } catch (error) {
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      setNodeDeploymentDialog({
        kind: NodeDeploymentDialogKind.Result,
        phase: NodeDeploymentPhase.Failed,
        title: t('nodeDeploymentFailedTitle'),
        message: error instanceof Error ? error.message : t('nodeDeploymentFailedMessage'),
        localService: browserLocalService,
      });
    } finally {
      if (nodeDeploymentActionRunIdRef.current === runId) {
        setIsNodeDeploymentBusy(false);
      }
    }
  }, [
    browserLocalService,
    browserLocalServiceProjectDirectory,
    browserLocalServiceProjectCandidates,
    checkLocalServiceAvailable,
    ensureHtmlShareAllowed,
    isHtmlSharing,
    isNodeDeploymentBusy,
    nodeDeploymentDialog,
    openLocalServiceUnavailableDialog,
    openNodeDeploymentStatusDialog,
    openNodeDeploymentAccessModeDialog,
    rememberNodeDeployment,
    resolveNodeDeploymentProjectDirectory,
    selectedNodeDeployment,
    sessionId,
  ]);

  const retryNodeDeployment = useCallback(async () => {
    const currentDialog = nodeDeploymentDialog;
    const localService = currentDialog?.localService ?? browserLocalService;
    if (!localService || isNodeDeploymentBusy) return;

    const runId = nodeDeploymentActionRunIdRef.current + 1;
    nodeDeploymentActionRunIdRef.current = runId;
    setIsNodeDeploymentBusy(true);
    setNodeDeploymentDialog(previous => previous
      ? {
          ...previous,
          kind: NodeDeploymentDialogKind.Status,
          phase: NodeDeploymentPhase.Analyzing,
          title: t('nodeDeploymentPreparingTitle'),
          message: t('nodeDeploymentAnalyzingProject'),
          localService,
          error: undefined,
        }
      : previous);

    try {
      const storedProjectDirectory = readNodeDeploymentProjectDirectory(sessionId, localService.url);
      if (!(await checkLocalServiceAvailable(localService))) {
        openLocalServiceUnavailableDialog(
          localService,
          currentDialog?.projectDirectory?.trim() || storedProjectDirectory,
        );
        return;
      }
      const projectDirectory = await resolveNodeDeploymentProjectDirectory(
        localService,
        currentDialog?.projectDirectory?.trim() || storedProjectDirectory,
        localService.projectCandidates?.length
          ? localService.projectCandidates
          : browserLocalServiceProjectCandidates,
      );
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      const analysis = await analyzeNodeDeploymentProject(localService, projectDirectory);
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      const confirmDialog = buildNodeDeploymentConfirmDialog(localService, projectDirectory, analysis);
      const deployment = currentDialog?.deployment;
      setNodeDeploymentDialog({
        ...confirmDialog,
        accessMode: normalizeHtmlShareAccessMode(
          currentDialog?.accessMode ?? deployment?.accessMode ?? confirmDialog.accessMode,
        ),
      });
    } catch (error) {
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      setNodeDeploymentDialog(previous => ({
        kind: NodeDeploymentDialogKind.Result,
        phase: NodeDeploymentPhase.Failed,
        title: t('nodeDeploymentFailedTitle'),
        message: error instanceof Error ? error.message : t('nodeDeploymentAnalyzeFailed'),
        localService,
        projectDirectory: currentDialog?.projectDirectory,
        analysis: previous?.analysis,
        accessMode: previous?.accessMode,
      }));
    } finally {
      if (nodeDeploymentActionRunIdRef.current === runId) {
        setIsNodeDeploymentBusy(false);
      }
    }
  }, [
    analyzeNodeDeploymentProject,
    browserLocalService,
    browserLocalServiceProjectCandidates,
    buildNodeDeploymentConfirmDialog,
    checkLocalServiceAvailable,
    isNodeDeploymentBusy,
    nodeDeploymentDialog,
    openLocalServiceUnavailableDialog,
    resolveNodeDeploymentProjectDirectory,
    sessionId,
  ]);

  const chooseNodeDeploymentProjectDirectory = useCallback(async () => {
    const currentDialog = nodeDeploymentDialog;
    if (!currentDialog?.localService || isNodeDeploymentBusy) return;
    const result = await window.electron?.dialog?.selectDirectory();
    if (!result?.success || !result.path) return;

    setNodeDeploymentDialog(previous => previous
      ? {
          ...previous,
          projectDirectory: result.path || previous.projectDirectory,
          analysis: undefined,
          error: undefined,
        }
      : previous);
  }, [
    isNodeDeploymentBusy,
    nodeDeploymentDialog,
  ]);

  const updateNodeDeploymentDialogField = useCallback(
    (field: 'nodeVersion' | 'installCommand' | 'buildCommand' | 'startCommand' | 'port', value: string) => {
      setNodeDeploymentDialog(previous => {
        if (!previous || previous.kind !== NodeDeploymentDialogKind.Confirm) return previous;
        return {
          ...previous,
          [field]: value,
        };
      });
    },
    [],
  );

  const updateNodeDeploymentProjectDirectory = useCallback((projectDirectory: string) => {
    setNodeDeploymentDialog(previous => {
      if (!previous || previous.kind !== NodeDeploymentDialogKind.Confirm) return previous;
      return {
        ...previous,
        projectDirectory,
        analysis: undefined,
        error: undefined,
      };
    });
  }, []);

  const nodeDeploymentAutoAnalysisLocalService =
    nodeDeploymentDialog?.kind === NodeDeploymentDialogKind.Confirm
      ? nodeDeploymentDialog.localService
      : undefined;
  const nodeDeploymentAutoAnalysisProjectDirectory =
    nodeDeploymentDialog?.kind === NodeDeploymentDialogKind.Confirm
      ? normalizeNodeDeploymentProjectDirectoryForCompare(nodeDeploymentDialog.projectDirectory)
      : '';
  const nodeDeploymentAutoAnalysisResultDirectory =
    nodeDeploymentDialog?.kind === NodeDeploymentDialogKind.Confirm
      ? normalizeNodeDeploymentProjectDirectoryForCompare(nodeDeploymentDialog.analysis?.projectDirectory)
      : undefined;

  useEffect(() => {
    if (!nodeDeploymentAutoAnalysisLocalService || !nodeDeploymentAutoAnalysisProjectDirectory) {
      return undefined;
    }

    const projectDirectory = nodeDeploymentAutoAnalysisProjectDirectory;
    if (nodeDeploymentAutoAnalysisResultDirectory === projectDirectory) {
      return undefined;
    }

    let isCancelled = false;
    let runId: number | undefined;
    const timer = window.setTimeout(() => {
      runId = nodeDeploymentAnalysisRunIdRef.current + 1;
      nodeDeploymentAnalysisRunIdRef.current = runId;
      setIsNodeDeploymentBusy(true);
      setNodeDeploymentDialog(previous => {
        if (
          !previous ||
          previous.kind !== NodeDeploymentDialogKind.Confirm ||
          normalizeNodeDeploymentProjectDirectoryForCompare(previous.projectDirectory) !== projectDirectory
        ) {
          return previous;
        }
        return {
          ...previous,
          phase: NodeDeploymentPhase.Analyzing,
          message: t('nodeDeploymentAnalyzingProject'),
          error: undefined,
        };
      });

      void analyzeNodeDeploymentProject(nodeDeploymentAutoAnalysisLocalService, projectDirectory)
        .then(analysis => {
          if (isCancelled) return;
          setNodeDeploymentDialog(previous => {
            if (
              !previous ||
              previous.kind !== NodeDeploymentDialogKind.Confirm ||
              normalizeNodeDeploymentProjectDirectoryForCompare(previous.projectDirectory) !== projectDirectory
            ) {
              return previous;
            }
            const nextDialog = buildNodeDeploymentConfirmDialog(
              nodeDeploymentAutoAnalysisLocalService,
              projectDirectory,
              analysis,
            );
            return {
              ...nextDialog,
              accessMode: previous.accessMode ?? nextDialog.accessMode,
            };
          });
        })
        .catch(error => {
          if (isCancelled) return;
          setNodeDeploymentDialog(previous => {
            if (
              !previous ||
              previous.kind !== NodeDeploymentDialogKind.Confirm ||
              normalizeNodeDeploymentProjectDirectoryForCompare(previous.projectDirectory) !== projectDirectory
            ) {
              return previous;
            }
            return {
              ...previous,
              phase: NodeDeploymentPhase.Failed,
              error: error instanceof Error ? error.message : t('nodeDeploymentAnalyzeFailed'),
            };
          });
        })
        .finally(() => {
          if (nodeDeploymentAnalysisRunIdRef.current === runId) {
            setIsNodeDeploymentBusy(false);
          }
        });
    }, 500);

    return () => {
      isCancelled = true;
      window.clearTimeout(timer);
      if (runId !== undefined && nodeDeploymentAnalysisRunIdRef.current === runId) {
        setIsNodeDeploymentBusy(false);
      }
    };
  }, [
    analyzeNodeDeploymentProject,
    buildNodeDeploymentConfirmDialog,
    nodeDeploymentAutoAnalysisLocalService,
    nodeDeploymentAutoAnalysisProjectDirectory,
    nodeDeploymentAutoAnalysisResultDirectory,
  ]);

  const selectNodeDeploymentAccessMode = useCallback((accessMode: HtmlShareAccessModeValue) => {
    setNodeDeploymentDialog(previous => {
      if (
        !previous ||
        (previous.kind !== NodeDeploymentDialogKind.AccessMode &&
          previous.kind !== NodeDeploymentDialogKind.Confirm &&
          previous.kind !== NodeDeploymentDialogKind.Status)
      ) {
        return previous;
      }
      return {
        ...previous,
        accessMode,
        message: previous.kind === NodeDeploymentDialogKind.AccessMode
          ? shouldUseHtmlShareCode(accessMode)
            ? t('htmlShareCodeViewHint')
            : t('htmlSharePublicViewHint')
          : previous.message,
        error: undefined,
      };
    });
  }, []);

  const closeNodeDeploymentDialog = useCallback(() => {
    setIsNodeDeploymentDialogOpen(false);
  }, []);

  const submitNodeDeployment = useCallback(async () => {
    const currentDialog = nodeDeploymentDialog;
    if (
      !currentDialog ||
      currentDialog.kind !== NodeDeploymentDialogKind.Confirm ||
      !currentDialog.localService ||
      !currentDialog.projectDirectory ||
      isNodeDeploymentBusy
    ) {
      return;
    }
    if (currentDialog.analysis?.blockers.length) return;

    const runId = nodeDeploymentActionRunIdRef.current + 1;
    nodeDeploymentActionRunIdRef.current = runId;
    const port = Number(currentDialog.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      setNodeDeploymentDialog(previous => previous
        ? { ...previous, error: t('nodeDeploymentInvalidPort') }
        : previous);
      return;
    }
    if (!(await checkLocalServiceAvailable(currentDialog.localService))) {
      openLocalServiceUnavailableDialog(currentDialog.localService, currentDialog.projectDirectory);
      return;
    }
    const isStaticDeployment = currentDialog.analysis?.deploymentKind === ShareDeploymentKind.StaticSite;
    const isPlainStaticDeployment =
      isStaticDeployment &&
      currentDialog.analysis?.packageManager === ShareDeploymentPackageManager.Unknown;
    const installCommand = isPlainStaticDeployment
      ? ''
      : isStaticDeployment
        ? currentDialog.installCommand?.trim() || currentDialog.analysis?.installCommand || 'npm install'
        : currentDialog.installCommand ?? currentDialog.analysis?.installCommand ?? 'npm install';
    const buildCommand = isPlainStaticDeployment
      ? ''
      : isStaticDeployment
        ? currentDialog.buildCommand?.trim() || currentDialog.analysis?.buildCommand || ''
        : currentDialog.buildCommand ?? currentDialog.analysis?.buildCommand ?? '';
    const startCommand = isStaticDeployment
      ? ''
      : currentDialog.startCommand || currentDialog.analysis?.startCommand || 'npm run start';

    setIsNodeDeploymentBusy(true);
    setIsNodeDeploymentDialogOpen(true);
    setNodeDeploymentDialog(previous => previous
      ? {
          ...previous,
          kind: NodeDeploymentDialogKind.Status,
          phase: NodeDeploymentPhase.Uploading,
          title: t('nodeDeploymentStatusTitle'),
          message: t('nodeDeploymentUploadingPackage'),
          error: undefined,
        }
      : previous);
    try {
      const result = await window.electron?.shareDeployment?.createNodeDeployment({
        sessionId,
        artifactId: `local-service-${currentDialog.localService.port}`,
        title: currentDialog.localService.title || `localhost:${currentDialog.localService.port}`,
        localServiceUrl: currentDialog.localService.url,
        projectDirectory: currentDialog.projectDirectory,
        accessMode: normalizeHtmlShareAccessMode(currentDialog.accessMode),
        nodeVersion: currentDialog.nodeVersion || currentDialog.analysis?.nodeVersion || '20',
        installCommand,
        buildCommand,
        startCommand,
        port,
      });
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      if (!result?.success || !result.deployment) {
        throw new Error(result?.error || t('nodeDeploymentFailedMessage'));
      }
      writeNodeDeploymentProjectDirectory(
        sessionId,
        currentDialog.localService.url,
        currentDialog.projectDirectory,
      );
      rememberNodeDeployment(
        getNodeDeploymentLookupKey(
          sessionId,
          currentDialog.localService.url,
          currentDialog.projectDirectory,
        ),
        result.deployment,
      );
      openNodeDeploymentStatusDialog(result.deployment, {
        localService: currentDialog.localService,
        projectDirectory: currentDialog.projectDirectory,
        analysis: currentDialog.analysis,
        accessMode: currentDialog.accessMode,
        nodeVersion: currentDialog.nodeVersion,
        installCommand: currentDialog.installCommand,
        buildCommand: currentDialog.buildCommand,
        startCommand: currentDialog.startCommand,
        port: currentDialog.port,
      });
    } catch (error) {
      if (nodeDeploymentActionRunIdRef.current !== runId) return;
      setNodeDeploymentDialog({
        kind: NodeDeploymentDialogKind.Result,
        phase: NodeDeploymentPhase.Failed,
        title: t('nodeDeploymentFailedTitle'),
        message: error instanceof Error ? error.message : t('nodeDeploymentFailedMessage'),
        localService: currentDialog.localService,
        projectDirectory: currentDialog.projectDirectory,
        analysis: currentDialog.analysis,
        accessMode: currentDialog.accessMode,
        nodeVersion: currentDialog.nodeVersion,
        installCommand: currentDialog.installCommand,
        buildCommand: currentDialog.buildCommand,
        startCommand: currentDialog.startCommand,
        port: currentDialog.port,
      });
    } finally {
      if (nodeDeploymentActionRunIdRef.current === runId) {
        setIsNodeDeploymentBusy(false);
      }
    }
  }, [
    checkLocalServiceAvailable,
    isNodeDeploymentBusy,
    nodeDeploymentDialog,
    openLocalServiceUnavailableDialog,
    openNodeDeploymentStatusDialog,
    rememberNodeDeployment,
    sessionId,
  ]);

  const updateNodeDeploymentAccessMode = useCallback(async () => {
    const currentDialog = nodeDeploymentDialog;
    const deployment = currentDialog?.deployment;
    if (
      !deployment?.shareId ||
      currentDialog?.kind !== NodeDeploymentDialogKind.Status ||
      isNodeDeploymentStatusUpdating
    ) {
      return;
    }
    const accessMode = normalizeHtmlShareAccessMode(currentDialog.accessMode ?? deployment.accessMode);
    if (accessMode === normalizeHtmlShareAccessMode(deployment.accessMode)) return;

    setIsNodeDeploymentStatusUpdating(true);
    setNodeDeploymentDialog(previous => previous
      ? { ...previous, error: undefined }
      : previous);
    try {
      const result = await window.electron?.htmlShare?.updateAccessMode({
        shareId: deployment.shareId,
        accessMode,
      });
      if (!result?.success) {
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const resultAccessMode = normalizeHtmlShareAccessMode(result.accessMode ?? accessMode);
      rememberNodeDeployment(
        currentDialog.localService
          ? `${sessionId}:${currentDialog.localService.url}`
          : selectedNodeDeploymentLookupKey,
        {
          ...deployment,
          accessMode: resultAccessMode,
          shareCode: shouldUseHtmlShareCode(resultAccessMode) ? result.shareCode : undefined,
          shareCodeUnavailable: result.shareCodeUnavailable,
          shareStatus: result.status ?? deployment.shareStatus,
          disabledSource: result.disabledSource ?? deployment.disabledSource,
        },
      );
      setNodeDeploymentDialog(previous => {
        if (
          !previous ||
          previous.kind !== NodeDeploymentDialogKind.Status
        ) {
          return previous;
        }
        const previousDeployment = previous.deployment;
        if (!previousDeployment || previousDeployment.shareId !== deployment.shareId) {
          return previous;
        }
        return {
          ...previous,
          message: t('nodeDeploymentAccessModeUpdateComplete'),
          accessMode: resultAccessMode,
          deployment: {
            ...previousDeployment,
            accessMode: resultAccessMode,
            shareCode: shouldUseHtmlShareCode(resultAccessMode) ? result.shareCode : undefined,
            shareCodeUnavailable: result.shareCodeUnavailable,
            shareStatus: result.status ?? previousDeployment.shareStatus,
            disabledSource: result.disabledSource ?? previousDeployment.disabledSource,
          },
          error: undefined,
        };
      });
    } catch (error) {
      setNodeDeploymentDialog(previous => previous
        ? {
            ...previous,
            error: error instanceof Error ? error.message : t('htmlShareAccessModeUpdateFailed'),
          }
        : previous);
    } finally {
      setIsNodeDeploymentStatusUpdating(false);
    }
  }, [
    isNodeDeploymentStatusUpdating,
    nodeDeploymentDialog,
    rememberNodeDeployment,
    selectedNodeDeploymentLookupKey,
    sessionId,
  ]);

  const toggleNodeDeploymentShareStatus = useCallback(async () => {
    const currentDialog = nodeDeploymentDialog;
    const deployment = currentDialog?.deployment;
    if (
      !deployment?.shareId ||
      currentDialog?.kind !== NodeDeploymentDialogKind.Status ||
      isNodeDeploymentStatusUpdating
    ) {
      return;
    }
    const currentShareStatus =
      getConfigurableHtmlShareStatus(deployment.shareStatus) ?? HtmlShareStatus.Live;
    const nextShareStatus =
      currentShareStatus === HtmlShareStatus.Live ? HtmlShareStatus.Disabled : HtmlShareStatus.Live;
    if (nextShareStatus === HtmlShareStatus.Live) {
      await retryNodeDeployment();
      return;
    }

    setIsNodeDeploymentStatusUpdating(true);
    setNodeDeploymentDialog(previous => previous
      ? {
          ...previous,
          deployment: previous.deployment
            ? { ...previous.deployment, shareStatus: nextShareStatus }
            : previous.deployment,
          error: undefined,
        }
      : previous);
    try {
      const result = await window.electron?.htmlShare?.updateStatus({
        shareId: deployment.shareId,
        status: nextShareStatus,
      });
      if (!result?.success) {
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const resultShareStatus =
        getConfigurableHtmlShareStatus(result.status) ?? nextShareStatus;
      const resultAccessMode = normalizeHtmlShareAccessMode(
        result.accessMode ?? deployment.accessMode,
      );
      const resultDeploymentStatus = resultShareStatus === HtmlShareStatus.Disabled
        ? ShareDeploymentStatus.Stopped
        : deployment.status;
      rememberNodeDeployment(
        currentDialog.localService
          ? `${sessionId}:${currentDialog.localService.url}`
          : selectedNodeDeploymentLookupKey,
        {
          ...deployment,
          status: resultDeploymentStatus,
          accessMode: resultAccessMode,
          shareCode: shouldUseHtmlShareCode(resultAccessMode) ? result.shareCode : undefined,
          shareCodeUnavailable: result.shareCodeUnavailable,
          shareStatus: resultShareStatus,
          disabledSource: result.disabledSource ?? undefined,
        },
      );
      setNodeDeploymentDialog(previous => {
        if (
          !previous ||
          previous.kind !== NodeDeploymentDialogKind.Status
        ) {
          return previous;
        }
        const previousDeployment = previous.deployment;
        if (!previousDeployment || previousDeployment.shareId !== deployment.shareId) {
          return previous;
        }
        return {
          ...previous,
          message:
            resultShareStatus === HtmlShareStatus.Disabled
              ? t('nodeDeploymentShareDisabledMessage')
              : t('nodeDeploymentShareEnabledMessage'),
          accessMode: resultAccessMode,
          deployment: {
            ...previousDeployment,
            status: resultDeploymentStatus,
            accessMode: resultAccessMode,
            shareCode: shouldUseHtmlShareCode(resultAccessMode) ? result.shareCode : undefined,
            shareCodeUnavailable: result.shareCodeUnavailable,
            shareStatus: resultShareStatus,
            disabledSource: result.disabledSource ?? undefined,
          },
          error: undefined,
        };
      });
    } catch (error) {
      setNodeDeploymentDialog(previous => previous
        ? {
            ...previous,
            deployment: previous.deployment
              ? { ...previous.deployment, shareStatus: currentShareStatus }
              : previous.deployment,
            error: error instanceof Error ? error.message : t('htmlShareStatusUpdateFailed'),
          }
        : previous);
    } finally {
      setIsNodeDeploymentStatusUpdating(false);
    }
  }, [
    isNodeDeploymentStatusUpdating,
    nodeDeploymentDialog,
    rememberNodeDeployment,
    retryNodeDeployment,
    selectedNodeDeploymentLookupKey,
    sessionId,
  ]);

  const pollingDeploymentId = nodeDeploymentDialog?.deployment?.deploymentId;
  const pollingDeploymentStatus = nodeDeploymentDialog?.deployment?.status;
  const pollingDeploymentDialogKind = nodeDeploymentDialog?.kind;

  useEffect(() => {
    if (
      pollingDeploymentDialogKind !== NodeDeploymentDialogKind.Status ||
      !pollingDeploymentId ||
      !isNodeDeploymentPending(pollingDeploymentStatus)
    ) {
      return undefined;
    }

    let isCancelled = false;
    const timer = window.setInterval(() => {
      void window.electron?.shareDeployment
        ?.get(pollingDeploymentId)
        .then(result => {
          if (isCancelled || !result?.success || !result.deployment) return;
          const refreshedDeployment = result.deployment;
          setNodeDeploymentDialog(previous => {
            if (
              previous?.kind !== NodeDeploymentDialogKind.Status ||
              previous.deployment?.deploymentId !== pollingDeploymentId
            ) {
              return previous;
            }
            return {
              ...previous,
              phase:
                refreshedDeployment.status === ShareDeploymentStatus.Live
                  ? NodeDeploymentPhase.Live
                  : refreshedDeployment.status === ShareDeploymentStatus.DeployFailed
                    ? NodeDeploymentPhase.Failed
                    : NodeDeploymentPhase.Deploying,
              message: getNodeDeploymentStatusMessage(refreshedDeployment),
              deployment: {
                ...refreshedDeployment,
                url: refreshedDeployment.url || previous.deployment?.url,
                accessMode: refreshedDeployment.accessMode || previous.deployment?.accessMode,
                shareCode: refreshedDeployment.shareCode || previous.deployment?.shareCode,
                shareCodeUnavailable:
                  refreshedDeployment.shareCodeUnavailable ??
                  previous.deployment?.shareCodeUnavailable,
                shareStatus: refreshedDeployment.shareStatus || previous.deployment?.shareStatus,
                disabledSource:
                  refreshedDeployment.disabledSource ?? previous.deployment?.disabledSource,
              },
            };
          });
        })
        .catch(() => undefined);
    }, 3000);

    return () => {
      isCancelled = true;
      window.clearInterval(timer);
    };
  }, [
    pollingDeploymentDialogKind,
    pollingDeploymentId,
    pollingDeploymentStatus,
  ]);

  const createHtmlShare = useCallback(async (request: HtmlSharePendingRequest) => {
    if (isHtmlSharing) return;
    setHtmlShareDialog(null);
    setHtmlSharePendingRequest(null);
    try {
      setHtmlSharePhase(HtmlSharePhase.Packing);
      setHtmlSharePhase(HtmlSharePhase.Uploading);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Creating ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
      const result =
        request.source === HtmlSharePendingSource.HtmlFile
          ? await window.electron?.htmlShare?.createFromHtmlFile({
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              filePath: request.filePath || '',
              title: request.title,
              accessMode: request.accessMode,
            })
          : await window.electron?.htmlShare?.createFromArtifactFile({
              sourceType: request.sourceType,
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              title: request.title,
              accessMode: request.accessMode,
              fileName: request.fileName,
              filePath: request.filePath,
              content: request.content,
              remoteUrl: request.remoteUrl,
            });
      await handleHtmlShareResult(result);
      rememberHtmlShare(request.lookupKey, result);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Created ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
    } catch (error) {
      window.electron?.log?.fromRenderer?.(
        'warn',
        'ArtifactPanel',
        `Failed to create ${request.sourceType} share for artifact ${request.artifactId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      setHtmlSharePhase(HtmlSharePhase.Failed);
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Result,
        title: t('htmlShareFailed'),
        message: error instanceof Error ? error.message : t('htmlShareFailed'),
      });
    }
  }, [handleHtmlShareResult, isHtmlSharing, rememberHtmlShare]);

  const selectHtmlShareAccessMode = useCallback((accessMode: HtmlShareAccessModeValue) => {
    setHtmlSharePendingRequest(previous => previous ? { ...previous, accessMode } : previous);
    setHtmlShareDialog(previous => {
      if (
        !previous ||
        (previous.kind !== HtmlShareDialogKind.Create &&
          previous.kind !== HtmlShareDialogKind.Existing)
      ) {
        return previous;
      }
      return {
        ...previous,
        selectedAccessMode: accessMode,
        message: shouldUseHtmlShareCode(accessMode)
          ? t('htmlShareCodeViewHint')
          : t('htmlSharePublicViewHint'),
        statusError: undefined,
      };
    });
  }, []);

  const updateHtmlShare = useCallback(async (options?: { allowActiveLimitRestore?: boolean }) => {
    const allowActiveLimitRestore = options?.allowActiveLimitRestore === true;
    if (
      !htmlSharePendingRequest ||
      !htmlShareDialog?.shareId ||
      isHtmlSharing ||
      (isHtmlShareContentUpdateDisabled &&
        !(allowActiveLimitRestore && canRestoreActiveLimitDisabledHtmlShare))
    )
      return;
    const request = htmlSharePendingRequest;
    const shareId = htmlShareDialog.shareId;
    const currentStatus = htmlShareDialog.status;
    const accessMode = normalizeHtmlShareAccessMode(
      htmlShareDialog.selectedAccessMode ?? request.accessMode,
    );
    setHtmlShareDialog(previous => {
      if (
        !previous ||
        previous.kind !== HtmlShareDialogKind.Existing ||
        previous.shareId !== shareId
      ) {
        return previous;
      }
      return {
        ...previous,
        contentUpdateStatus: allowActiveLimitRestore
          ? previous.contentUpdateStatus
          : HtmlShareContentUpdateStatus.Updating,
        statusError: undefined,
      };
    });
    try {
      setHtmlSharePhase(HtmlSharePhase.Packing);
      setHtmlSharePhase(HtmlSharePhase.Uploading);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Updating ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
      const result =
        request.source === HtmlSharePendingSource.HtmlFile
          ? await window.electron?.htmlShare?.updateFromHtmlFile({
              shareId,
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              filePath: request.filePath || '',
              title: request.title,
              currentStatus,
              accessMode,
            })
          : await window.electron?.htmlShare?.updateFromArtifactFile({
              sourceType: request.sourceType,
              shareId,
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              title: request.title,
              accessMode,
              fileName: request.fileName,
              filePath: request.filePath,
              content: request.content,
              remoteUrl: request.remoteUrl,
              currentStatus,
            });
      if (!result?.success || !result.url) {
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const resultStatus = getConfigurableHtmlShareStatus(result.status) ?? HtmlShareStatus.Live;
      rememberHtmlShare(request.lookupKey, result);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Updated ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
      setHtmlSharePhase(HtmlSharePhase.Live);
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          message: shouldUseHtmlShareCode(result.accessMode ?? accessMode)
            ? t('htmlShareCodeViewHint')
            : t('htmlSharePublicViewHint'),
          url: result.url,
          accessMode: result.accessMode ?? accessMode,
          selectedAccessMode: result.accessMode ?? accessMode,
          shareCode: shouldUseHtmlShareCode(result.accessMode ?? accessMode)
            ? result.shareCode
            : undefined,
          shareCodeUnavailable: result.shareCodeUnavailable,
          status: resultStatus,
          targetStatus: resultStatus,
          disabledSource: result.disabledSource ?? undefined,
          statusError: undefined,
          contentUpdateStatus: allowActiveLimitRestore
            ? undefined
            : HtmlShareContentUpdateStatus.Complete,
        };
      });
    } catch (error) {
      setHtmlSharePhase(HtmlSharePhase.Failed);
      const message = error instanceof Error ? error.message : t('htmlShareFailed');
      window.electron?.log?.fromRenderer?.(
        'warn',
        'ArtifactPanel',
        `Failed to update ${request.sourceType} share for artifact ${request.artifactId}: ${message}`,
      );
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return {
            kind: HtmlShareDialogKind.Result,
            title: t('htmlShareFailed'),
            message,
          };
        }
        return {
          ...previous,
          statusError: message,
          contentUpdateStatus: HtmlShareContentUpdateStatus.Failed,
        };
      });
    }
  }, [
    htmlShareDialog?.shareId,
    htmlShareDialog?.status,
    htmlShareDialog?.selectedAccessMode,
    htmlSharePendingRequest,
    canRestoreActiveLimitDisabledHtmlShare,
    isHtmlShareContentUpdateDisabled,
    isHtmlSharing,
    rememberHtmlShare,
  ]);

  const updateHtmlShareAccessMode = useCallback(async () => {
    if (
      !htmlSharePendingRequest ||
      !htmlShareDialog ||
      htmlShareDialog.kind !== HtmlShareDialogKind.Existing ||
      !htmlShareDialog.shareId ||
      isHtmlShareStatusUpdating
    ) {
      return;
    }
    const accessMode = normalizeHtmlShareAccessMode(
      htmlShareDialog.selectedAccessMode ?? htmlShareDialog.accessMode,
    );
    if (accessMode === normalizeHtmlShareAccessMode(htmlShareDialog.accessMode)) return;
    const shareId = htmlShareDialog.shareId;
    const request = htmlSharePendingRequest;
    setIsHtmlShareStatusUpdating(true);
    setHtmlShareDialog(previous => previous && previous.shareId === shareId
      ? { ...previous, statusError: undefined }
      : previous);
    try {
      const result = await window.electron?.htmlShare?.updateAccessMode({
        shareId,
        accessMode,
      });
      if (!result?.success || !result.url) {
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const resultAccessMode = normalizeHtmlShareAccessMode(result.accessMode ?? accessMode);
      const refreshedShare = {
        shareId: result.shareId ?? shareId,
        url: result.url,
        accessMode: resultAccessMode,
        shareCode: shouldUseHtmlShareCode(resultAccessMode) ? result.shareCode : undefined,
        shareCodeUnavailable: result.shareCodeUnavailable,
        status: result.status ?? htmlShareDialog.status,
        disabledSource: result.disabledSource ?? htmlShareDialog.disabledSource,
      };
      rememberHtmlShare(request.lookupKey, refreshedShare);
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          message: t('htmlShareAccessModeUpdateComplete'),
          url: refreshedShare.url,
          accessMode: resultAccessMode,
          selectedAccessMode: resultAccessMode,
          shareCode: refreshedShare.shareCode,
          shareCodeUnavailable: refreshedShare.shareCodeUnavailable,
          status: refreshedShare.status,
          targetStatus: getConfigurableHtmlShareStatus(refreshedShare.status),
          disabledSource: refreshedShare.disabledSource ?? undefined,
          statusError: undefined,
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('htmlShareAccessModeUpdateFailed');
      setHtmlShareDialog(previous => previous && previous.shareId === shareId
        ? { ...previous, statusError: message }
        : previous);
    } finally {
      setIsHtmlShareStatusUpdating(false);
    }
  }, [
    htmlShareDialog,
    htmlSharePendingRequest,
    isHtmlShareStatusUpdating,
    rememberHtmlShare,
  ]);

  const toggleHtmlShareTargetStatus = useCallback(async () => {
    if (
      !htmlShareDialog ||
      htmlShareDialog.kind !== HtmlShareDialogKind.Existing ||
      !htmlShareDialog.shareId ||
      !htmlShareDialog.targetStatus ||
      isHtmlShareStatusUpdating
    ) {
      return;
    }
    const shareId = htmlShareDialog.shareId;
    const previousStatus = htmlShareDialog.targetStatus;
    const nextStatus =
      previousStatus === HtmlShareStatus.Live ? HtmlShareStatus.Disabled : HtmlShareStatus.Live;
    const request = htmlSharePendingRequest;
    const restoreActiveLimitByUpdate =
      previousStatus === HtmlShareStatus.Disabled &&
      nextStatus === HtmlShareStatus.Live &&
      canRestoreActiveLimitDisabledHtmlShare;

    if (restoreActiveLimitByUpdate) {
      setIsHtmlShareStatusUpdating(true);
      try {
        await updateHtmlShare({ allowActiveLimitRestore: true });
      } finally {
        setIsHtmlShareStatusUpdating(false);
      }
      return;
    }

    setIsHtmlShareStatusUpdating(true);
    setHtmlShareDialog(previous => {
      if (
        !previous ||
        previous.kind !== HtmlShareDialogKind.Existing ||
        previous.shareId !== shareId
      ) {
        return previous;
      }
      return {
        ...previous,
        status: nextStatus,
        targetStatus: nextStatus,
        statusError: undefined,
      };
    });
    try {
      const result = await window.electron?.htmlShare?.updateStatus({
        shareId,
        status: nextStatus,
      });
      if (!result?.success || !result.url) {
        throw new Error(getHtmlShareFailureMessage(result));
      }
      let refreshedShare: ExistingHtmlShareInfo | null = null;
      if (request) {
        try {
          const lookup =
            request.source === HtmlSharePendingSource.HtmlFile
              ? await window.electron?.htmlShare?.getByHtmlFile({
                  filePath: request.filePath || '',
                })
              : await window.electron?.htmlShare?.getByArtifactFile({
                  sourceType: request.sourceType,
                  sessionId: request.sessionId,
                  artifactId: request.artifactId,
                  filePath: request.filePath,
                });
          if (lookup?.success) {
            refreshedShare = getExistingHtmlShareInfo(lookup.share);
          }
        } catch {
          refreshedShare = null;
        }
      }
      const resultStatus =
        getConfigurableHtmlShareStatus(refreshedShare?.status ?? result.status) ?? nextStatus;
      const refreshedResult = {
        shareId: refreshedShare?.shareId ?? result.shareId ?? shareId,
        url: refreshedShare?.url ?? result.url,
        accessMode: refreshedShare?.accessMode ?? result.accessMode ?? htmlShareDialog.accessMode,
        shareCode: refreshedShare?.shareCode ?? result.shareCode,
        shareCodeUnavailable:
          refreshedShare?.shareCodeUnavailable ?? result.shareCodeUnavailable,
        status: resultStatus,
        disabledSource: refreshedShare?.disabledSource ?? result.disabledSource,
      };
      if (request) {
        rememberHtmlShare(request.lookupKey, refreshedResult);
      }
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          url: refreshedResult.url ?? previous.url,
          accessMode: refreshedResult.accessMode ?? previous.accessMode,
          selectedAccessMode: refreshedResult.accessMode ?? previous.selectedAccessMode,
          shareCode: shouldUseHtmlShareCode(refreshedResult.accessMode ?? previous.accessMode)
            ? refreshedResult.shareCode ?? previous.shareCode
            : undefined,
          shareCodeUnavailable:
            refreshedResult.shareCodeUnavailable ?? previous.shareCodeUnavailable,
          status: resultStatus,
          targetStatus: resultStatus,
          disabledSource: refreshedResult.disabledSource ?? undefined,
          statusError: undefined,
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('htmlShareStatusUpdateFailed');
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          status: previousStatus,
          targetStatus: previousStatus,
          statusError: message,
        };
      });
    } finally {
      setIsHtmlShareStatusUpdating(false);
    }
  }, [
    htmlShareDialog,
    htmlSharePendingRequest,
    canRestoreActiveLimitDisabledHtmlShare,
    isHtmlShareStatusUpdating,
    rememberHtmlShare,
    updateHtmlShare,
  ]);

  const handleShareHtmlArtifact = useCallback(async () => {
    if (!htmlShareArtifact || !selectedShareSourceType || isHtmlSharing)
      return;
    reportArtifactPreviewAction({
      actionType: 'share_html_click',
      source: isBrowserTabActive ? 'artifact_browser' : 'artifact_panel',
      artifact: htmlShareArtifact,
      params: {
        hasExistingShare: Boolean(selectedHtmlShare),
        shareSourceType: selectedShareSourceType,
      },
    });
    const request = buildHtmlSharePendingRequest(
      htmlShareArtifact,
      selectedShareSourceType,
      sessionId,
    );
    if (!request) {
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Result,
        title: t('htmlShareFailed'),
        message: t('artifactShareSourceUnavailable'),
      });
      return;
    }
    if (!(await ensureHtmlShareAllowed())) return;
    try {
      if (selectedHtmlShare) {
        openExistingHtmlShareDialog(request, selectedHtmlShare);
        return;
      }
      setHtmlSharePhase(HtmlSharePhase.Checking);
      const lookup =
        request.source === HtmlSharePendingSource.HtmlFile
          ? await window.electron?.htmlShare?.getByHtmlFile({
              filePath: request.filePath || '',
            })
          : await window.electron?.htmlShare?.getByArtifactFile({
              sourceType: request.sourceType,
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              filePath: request.filePath,
            });
      if (!lookup?.success) {
        if (lookup?.code === HtmlShareErrorCode.FeatureUnavailable) {
          throw new Error(t('htmlShareUnavailableInProduction'));
        }
        if (shouldContinueArtifactShareAfterLookupFailure(request, lookup)) {
          openCreateHtmlShareDialog(request);
          return;
        }
        throw new Error(lookup?.error || t('htmlShareFailed'));
      }
      const existingShare = getExistingHtmlShareInfo(lookup.share);
      if (existingShare) {
        rememberHtmlShare(request.lookupKey, existingShare);
        openExistingHtmlShareDialog(request, existingShare);
        return;
      }
      openCreateHtmlShareDialog(request);
    } catch (error) {
      setHtmlSharePhase(HtmlSharePhase.Failed);
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Result,
        title: t('htmlShareFailed'),
        message: error instanceof Error ? error.message : t('htmlShareFailed'),
      });
    }
  }, [
    ensureHtmlShareAllowed,
    isHtmlSharing,
    openCreateHtmlShareDialog,
    openExistingHtmlShareDialog,
    rememberHtmlShare,
    htmlShareArtifact,
    isBrowserTabActive,
    selectedHtmlShare,
    selectedShareSourceType,
    sessionId,
  ]);

  const handleOpenWithApp = useCallback(() => {
    if (selectedArtifact?.filePath) {
      reportSelectedArtifactAction('open_with_app', {
        openTarget: 'external_app',
      });
      let filePath = selectedArtifact.filePath;
      if (filePath.startsWith('file:///')) {
        filePath = filePath.slice(7);
      } else if (filePath.startsWith('file://')) {
        filePath = filePath.slice(7);
      } else if (filePath.startsWith('file:/')) {
        filePath = filePath.slice(5);
      }
      // Strip leading / before Windows drive letter
      if (/^\/[A-Za-z]:/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      void openLocalPathWithToast(filePath);
    }
  }, [reportSelectedArtifactAction, selectedArtifact]);

  const handleRefresh = useCallback(async () => {
    if (!selectedArtifact?.filePath) return;
    if (selectedArtifact.type === 'video') {
      dispatch(addArtifact({
        sessionId: selectedArtifact.sessionId,
        artifact: { ...selectedArtifact, createdAt: Date.now() },
      }));
      reportSelectedArtifactAction('refresh_preview', { result: 'success' });
      return;
    }
    try {
      if (selectedArtifact.type === ArtifactTypeValue.Html) {
        dispatch(addArtifact({
          sessionId: selectedArtifact.sessionId,
          artifact: {
            ...selectedArtifact,
            contentVersion: Date.now(),
          },
        }));
        reportSelectedArtifactAction('refresh_preview', { result: 'success' });
        return;
      }

      const isTextType = selectedArtifact.type !== 'image' && selectedArtifact.type !== 'document';
      if (isTextType && window.electron?.dialog?.readTextFile) {
        const result = await window.electron.dialog.readTextFile(selectedArtifact.filePath);
        if (result?.success && typeof result.content === 'string') {
          dispatch(addArtifact({
            sessionId: selectedArtifact.sessionId,
            artifact: { ...selectedArtifact, content: result.content, contentVersion: Date.now() },
          }));
          reportSelectedArtifactAction('refresh_preview', { result: 'success' });
        } else {
          reportSelectedArtifactAction('refresh_preview', { result: 'failed' });
        }
        return;
      }

      const result = await window.electron.dialog.readFileAsDataUrl(selectedArtifact.filePath);
      if (result?.success && result.dataUrl) {
        const isTextType =
          selectedArtifact.type !== 'image' && selectedArtifact.type !== 'document';
        let content = result.dataUrl;
        if (isTextType) {
          try {
            const base64 = result.dataUrl.split(',')[1] || '';
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            content = new TextDecoder('utf-8').decode(bytes);
          } catch {
            content = result.dataUrl;
          }
        }
        dispatch(
          addArtifact({
            sessionId: selectedArtifact.sessionId,
            artifact: { ...selectedArtifact, content },
          }),
        );
        reportSelectedArtifactAction('refresh_preview', { result: 'success' });
      } else {
        reportSelectedArtifactAction('refresh_preview', { result: 'failed' });
      }
    } catch {
      reportSelectedArtifactAction('refresh_preview', { result: 'failed' });
      // File unreadable or missing
    }
  }, [selectedArtifact, dispatch, reportSelectedArtifactAction]);

  const handleRefreshRef = useRef(handleRefresh);
  handleRefreshRef.current = handleRefresh;

  const runArtifactMenuAction = useCallback((action: () => void) => {
    setIsArtifactActionsMenuOpen(false);
    action();
  }, []);

  const isHtmlShareLinkDialog = Boolean(
    htmlShareDialog &&
      (htmlShareDialog.kind === HtmlShareDialogKind.Create ||
        htmlShareDialog.kind === HtmlShareDialogKind.Existing ||
        (htmlShareDialog.kind === HtmlShareDialogKind.Result && htmlShareDialog.url)),
  );
  const isHtmlShareCreateDialog =
    htmlShareDialog?.kind === HtmlShareDialogKind.Create;
  const isHtmlShareExistingDialog =
    htmlShareDialog?.kind === HtmlShareDialogKind.Existing;
  const isHtmlShareStoppedDialog =
    isHtmlShareExistingDialog &&
    htmlShareDialog.targetStatus === HtmlShareStatus.Disabled;
  const isHtmlShareActiveLimitStoppedDialog =
    isHtmlShareStoppedDialog &&
    htmlShareDialog.disabledSource === HtmlShareDisabledSource.ActiveLimit;
  const htmlShareStoppedNotice =
    !isHtmlShareStoppedDialog
      ? undefined
      : htmlShareDialog.disabledSource === HtmlShareDisabledSource.ActiveLimit
        ? t('htmlShareStoppedByActiveLimitNotice')
        : htmlShareDialog.disabledSource === HtmlShareDisabledSource.Admin
          ? t('htmlShareStoppedByAdminNotice')
          : htmlShareDialog.disabledSource === HtmlShareDisabledSource.Moderation
            ? t('htmlShareStoppedByModerationNotice')
            : t('htmlShareStoppedNotice');
  const isHtmlShareFileUpdateDisabled = isHtmlSharing || isHtmlShareContentUpdateDisabled;
  const htmlShareUpdateActionLabel = t('htmlShareUpdate');
  const htmlShareSelectedAccessMode = normalizeHtmlShareAccessMode(
    htmlShareDialog?.selectedAccessMode ?? htmlShareDialog?.accessMode,
  );
  const canShowHtmlShareAccessModeControls =
    isHtmlShareCreateDialog || isHtmlShareExistingDialog;
  const isHtmlShareAccessModeChanged =
    isHtmlShareExistingDialog &&
    canShowHtmlShareAccessModeControls &&
    htmlShareSelectedAccessMode !== normalizeHtmlShareAccessMode(htmlShareDialog?.accessMode);
  const isHtmlShareAccessModeActionDisabled = Boolean(
    !isHtmlShareAccessModeChanged || isHtmlShareStatusUpdating || isHtmlSharing,
  );
  const canShowHtmlShareDialogCopyAction = Boolean(
    canUseHtmlShareDialogLink && !isHtmlShareAccessModeChanged,
  );
  const isHtmlShareAvailabilityActionDisabled = Boolean(
    !htmlShareDialog?.shareId ||
      isHtmlShareStatusUpdating ||
      isHtmlSharing ||
      !htmlShareDialog.targetStatus,
  );
  const htmlShareAvailabilityActionLabel =
    htmlShareDialog?.targetStatus === HtmlShareStatus.Disabled
      ? t('htmlShareStartSharing')
      : t('htmlShareStopSharing');
  const htmlShareAvailabilityActionClassName = isHtmlShareStoppedDialog
    ? 'inline-flex h-10 min-w-[96px] items-center justify-center whitespace-nowrap rounded-lg bg-primary px-4 text-base text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60'
    : 'inline-flex h-10 min-w-[96px] items-center justify-center whitespace-nowrap rounded-lg border border-border bg-background px-4 text-base text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60';
  const htmlShareCopyButtonLabel =
    htmlShareCopyStatus === HtmlShareCopyStatus.Failed
      ? t('copyFailed')
      : htmlShareCopyStatus === HtmlShareCopyStatus.Copied
        ? t('copied')
        : shouldUseHtmlShareCode(htmlShareDialog?.accessMode) && htmlShareDialog?.shareCode
          ? t('htmlShareCopyLinkAndCode')
          : t('htmlShareCopyLink');
  const isNodeDeploymentAccessModeDialog =
    nodeDeploymentDialog?.kind === NodeDeploymentDialogKind.AccessMode;
  const isNodeDeploymentConfirmDialog =
    nodeDeploymentDialog?.kind === NodeDeploymentDialogKind.Confirm;
  const isNodeDeploymentStatusDialog =
    nodeDeploymentDialog?.kind === NodeDeploymentDialogKind.Status;
  const shouldShowNodeDeploymentHeaderMessage = Boolean(
    nodeDeploymentDialog?.message &&
      (isNodeDeploymentAccessModeDialog || isNodeDeploymentConfirmDialog),
  );
  const nodeDeploymentAnalysis = nodeDeploymentDialog?.analysis;
  const nodeDeploymentSelectedAccessMode = normalizeHtmlShareAccessMode(
    nodeDeploymentDialog?.accessMode,
  );
  const isStaticNodeDeployment =
    nodeDeploymentAnalysis?.deploymentKind === ShareDeploymentKind.StaticSite;
  const isNodeDeploymentSubmitDisabled = Boolean(
    isNodeDeploymentBusy ||
      !nodeDeploymentDialog?.projectDirectory?.trim() ||
      (!isStaticNodeDeployment && !nodeDeploymentDialog?.startCommand?.trim()) ||
      !nodeDeploymentDialog?.port?.trim() ||
      nodeDeploymentAnalysis?.blockers.length,
  );
  const nodeDeployment = nodeDeploymentDialog?.deployment;
  const nodeDeploymentShareStatus =
    getConfigurableHtmlShareStatus(nodeDeployment?.shareStatus) ?? HtmlShareStatus.Live;
  const isNodeDeploymentShareDisabled =
    nodeDeploymentShareStatus === HtmlShareStatus.Disabled;
  const isNodeDeploymentAccessModeChanged = Boolean(
    isNodeDeploymentStatusDialog &&
      nodeDeployment &&
      nodeDeploymentSelectedAccessMode !== normalizeHtmlShareAccessMode(nodeDeployment.accessMode),
  );
  const canShowNodeDeploymentAccessModeControls = Boolean(
    isNodeDeploymentAccessModeDialog ||
      (isNodeDeploymentStatusDialog && nodeDeployment?.shareId),
  );
  const isNodeDeploymentAccessModeActionDisabled = Boolean(
    !isNodeDeploymentAccessModeChanged ||
      isNodeDeploymentBusy ||
      isNodeDeploymentStatusUpdating ||
      isNodeDeploymentShareDisabled,
  );
  const canToggleNodeDeploymentShareStatus = Boolean(
    isNodeDeploymentStatusDialog &&
      nodeDeployment?.shareId &&
      !isNodeDeploymentBusy &&
      !isNodeDeploymentStatusUpdating,
  );
  const nodeDeploymentShareAvailabilityActionLabel = isNodeDeploymentShareDisabled
    ? t('nodeDeploymentRedeployAndShare')
    : t('htmlShareStopSharing');
  const nodeDeploymentShareAvailabilityActionClassName = isNodeDeploymentShareDisabled
    ? 'inline-flex h-9 min-w-[96px] items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60'
    : 'inline-flex h-9 min-w-[96px] items-center justify-center whitespace-nowrap rounded-md border border-border bg-background px-3 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60';
  const canCopyNodeDeploymentLink = Boolean(
    nodeDeployment?.url &&
      nodeDeployment.status === ShareDeploymentStatus.Live &&
      !isNodeDeploymentShareDisabled &&
      !isNodeDeploymentAccessModeChanged &&
      !isNodeDeploymentBusy,
  );
  const nodeDeploymentCopyButtonLabel =
    htmlShareCopyStatus === HtmlShareCopyStatus.Failed
      ? t('copyFailed')
      : htmlShareCopyStatus === HtmlShareCopyStatus.Copied
        ? t('copied')
        : shouldUseHtmlShareCode(nodeDeployment?.accessMode) && nodeDeployment?.shareCode
          ? t('htmlShareCopyLinkAndCode')
          : t('htmlShareCopyLink');
  const canRetryNodeDeployment = Boolean(
    !isNodeDeploymentBusy &&
      nodeDeploymentDialog &&
      (nodeDeployment?.status === ShareDeploymentStatus.Live ||
        nodeDeployment?.status === ShareDeploymentStatus.DeployFailed ||
        nodeDeployment?.status === ShareDeploymentStatus.Stopped ||
        nodeDeployment?.status === ShareDeploymentStatus.Expired ||
        (nodeDeploymentDialog.kind === NodeDeploymentDialogKind.Result &&
          nodeDeploymentDialog.phase === NodeDeploymentPhase.Failed)) &&
      (nodeDeploymentDialog.localService || browserLocalService),
  );
  const canShowNodeDeploymentFooterRedeploy = Boolean(
    canRetryNodeDeployment && !isNodeDeploymentStatusDialog,
  );
  const nodeDeploymentStatusLabel = getNodeDeploymentPhaseStatusLabel(
    nodeDeploymentDialog?.phase,
    nodeDeployment?.status,
  );

  return (
    <>
      {/* Drag handle */}
      {!isPanelExpanded && (
        <div
          className="w-1 shrink-0 touch-none cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
          onPointerDown={handleResizeStart}
        />
      )}
      <aside
        style={isPanelExpanded
          ? { width: '100%', maxWidth: 'none' }
          : { width: constrainedPanelWidth, maxWidth: constrainedMaxPanelWidth }}
        className={`bg-background flex flex-col h-full overflow-hidden relative ${
          isPanelExpanded ? 'min-w-0 flex-1' : 'shrink border-l border-border'
        }`}
      >
        {!isPanelExpanded && panelIsResizing && (
          <div className="absolute inset-0 z-30 cursor-col-resize bg-transparent" />
        )}

        {selectedArtifact ? (
          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
            {/* Header: current file + actions */}
            <div className="h-10 flex items-center gap-2 px-3 border-b border-border shrink-0">
              <span className="text-sm font-medium truncate">
                {selectedArtifact.fileName || selectedArtifact.title}
              </span>
              <span className="text-xs uppercase text-muted">{selectedArtifact.type}</span>
              <span className="flex-1" />
              {showArtifactActionsMenu && (
                <div className="relative">
                  <button
                    ref={artifactActionsMenuButtonRef}
                    type="button"
                    onClick={() => setIsArtifactActionsMenuOpen(value => {
                      const nextOpen = !value;
                      reportSelectedArtifactAction('actions_menu_toggle', {
                        targetOpen: nextOpen,
                      });
                      return nextOpen;
                    })}
                    className={`p-1 rounded transition-colors ${
                      isArtifactActionsMenuOpen
                        ? 'bg-surface text-foreground'
                        : 'text-secondary hover:text-foreground hover:bg-surface'
                    }`}
                    aria-label={t('artifactActionsMenu')}
                    title={t('artifactActionsMenu')}
                  >
                    <MoreHorizontalToolbarIcon />
                  </button>
                  {isArtifactActionsMenuOpen && (
                    <div
                      ref={artifactActionsMenuRef}
                      className="absolute right-0 top-7 z-40 w-44 rounded-lg border border-border bg-surface-raised p-1.5 text-sm text-foreground shadow-xl"
                    >
                      {showContentViewActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(() => handleSetContentView(contentViewActionTarget))}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <ContentViewIcon />
                          <span>{contentViewActionLabel}</span>
                        </button>
                      )}
                      {showRefreshAction && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleRefresh)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <RefreshIcon />
                          <span>{t('artifactRefresh')}</span>
                        </button>
                      )}
                      {showCopyAction && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(() => void handleCopy())}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <CopyIcon className="h-3.5 w-3.5" />
                          <span>{t('artifactCopyCode')}</span>
                        </button>
                      )}
                      {showOpenBrowserActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleOpenInBrowser)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <BrowserIcon />
                          <span>{t('artifactOpenInBrowser')}</span>
                        </button>
                      )}
                      {showOpenWithAppActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleOpenWithApp)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <OpenExternalIcon />
                          <span>{t('artifactOpenWithApp')}</span>
                        </button>
                      )}
                      {showRevealInFolderActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleRevealInFolder)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <FolderIcon />
                          <span>{t('artifactOpenFolder')}</span>
                        </button>
                      )}
                      {officePreviewZoomControls && (
                        <div
                          className={`${hasArtifactActionMenuItems ? 'mt-1 border-t border-border/70 pt-1.5' : ''} px-1 py-1`}
                        >
                          <div className="flex h-8 items-center gap-1.5">
                            <span className="shrink-0 whitespace-nowrap text-xs text-secondary">
                              {t('artifactBrowserZoom')}
                            </span>
                            <OfficeZoomControls
                              zoomFactor={officePreviewZoomControls.zoomFactor}
                              displayZoomFactor={officePreviewZoomControls.displayZoomFactor}
                              onZoomOut={officePreviewZoomControls.onZoomOut}
                              onZoomIn={officePreviewZoomControls.onZoomIn}
                              onResetZoom={officePreviewZoomControls.onResetZoom}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {canShareHtmlArtifact && (
                <button
                  onClick={handleShareHtmlArtifact}
                  disabled={isHtmlSharing}
                  className={htmlShareButtonClass}
                  aria-label={htmlShareButtonTitle}
                  title={htmlShareButtonTitle}
                >
                  <ShareIcon />
                </button>
              )}
              {isCompactHtmlToolbar && showOpenBrowserAction && (
                <button
                  onClick={handleOpenInBrowser}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenInBrowser')}
                >
                  <OpenExternalIcon />
                </button>
              )}
              {showPrimaryOpenWithAppAction && (
                <button
                  onClick={handleOpenWithApp}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenWithApp')}
                >
                  <OpenExternalIcon />
                </button>
              )}
              {showPrimaryRevealInFolderAction && (
                <button
                  onClick={handleRevealInFolder}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenFolder')}
                >
                  <FolderIcon />
                </button>
              )}
              <button
                ref={fileListButtonRef}
                onClick={toggleFileListDrawer}
                className={`p-1 rounded transition-colors ${
                  isFileListDrawerVisible
                    ? 'text-primary bg-primary/10'
                    : 'text-secondary hover:text-foreground hover:bg-surface'
                }`}
                title={t('artifactFileList')}
              >
                <FileListIcon />
              </button>
            </div>

            {showFileListDrawer && (
              <div
                ref={fileListDrawerRef}
                className={`absolute top-10 right-0 bottom-0 z-20 flex w-[min(320px,86%)] flex-col border-l border-border bg-background shadow-xl transition-[transform,opacity] duration-[180ms] ease-out motion-reduce:transition-none ${
                  isFileListDrawerVisible
                    ? 'translate-x-0 opacity-100'
                    : 'translate-x-full opacity-0 pointer-events-none'
                }`}
              >
                <div className="h-9 flex items-center px-3 border-b border-border shrink-0">
                  <span className="text-xs font-medium text-secondary">
                    {t('artifactFileList')}
                  </span>
                </div>
                <FileDirectoryView
                  artifacts={previewableArtifacts}
                  selectedId={selectedArtifactId}
                  onSelect={handleSelectArtifactFromDrawer}
                  compact
                />
              </div>
            )}

            {/* Render area */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <OfficePreviewActionsContext.Provider value={officePreviewActionsContextValue}>
                {!isCodeViewActive ? (
                  <ArtifactRenderer
                    artifact={selectedArtifact}
                    sessionArtifacts={artifacts}
                    selectedTextContext={selectedTextContext}
                  />
                ) : (
                  <CodeRenderer artifact={selectedArtifact} />
                )}
              </OfficePreviewActionsContext.Provider>
            </div>
          </div>
        ) : activeSpecialTab === ArtifactSpecialTab.Browser ? (
          <BrowserTabContent
            address={browserAddress}
            currentUrl={browserUrl}
            sessionArtifacts={artifacts}
            canShare={browserCanShare}
            shareButtonTitle={browserShareButtonTitle}
            hasExistingShare={browserHasExistingShare}
            isSharing={canShareHtmlArtifact ? isHtmlSharing : false}
            onShare={canShareHtmlArtifact ? handleShareHtmlArtifact : handleShareLocalServiceDeployment}
            autoRefreshFilePath={browserHtmlAutoRefreshFilePath}
            localHtmlPreviewUrl={browserHtmlPreviewUrl}
            onAddressChange={handleBrowserAddressChange}
            onCurrentUrlChange={handleBrowserUrlChange}
            onTitleChange={onBrowserTitleChange}
            onLocalServiceOpen={handleBrowserLocalServiceOpen}
            onAnnotationCaptured={onBrowserAnnotationCaptured}
          />
        ) : activeSpecialTab === ArtifactSpecialTab.Subagents && subagentPanel ? (
          subagentPanel
        ) : (
          /* No artifact selected: show full-width file list */
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            <FileDirectoryView
              artifacts={previewableArtifacts}
              selectedId={selectedArtifactId}
              onSelect={handleSelectArtifact}
            />
          </div>
        )}
      </aside>
      {htmlShareDialog &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 px-4">
            {isHtmlShareLinkDialog ? (
              <div className="relative w-full max-w-[420px] rounded-2xl bg-background px-7 pb-6 pt-6 shadow-2xl">
                <button
                  type="button"
                  onClick={() => {
                    setHtmlShareDialog(null);
                    setHtmlSharePendingRequest(null);
                  }}
                  className="absolute right-6 top-6 rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-foreground"
                  aria-label={t('close')}
                  title={t('close')}
                >
                  <CloseIcon />
                </button>
                <div className="pr-8 text-xl font-semibold leading-7 text-foreground">
                  {t('htmlShare')}
                </div>
                {isHtmlShareStoppedDialog ? (
                  <div
                    className={
                      isHtmlShareActiveLimitStoppedDialog
                        ? 'mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
                        : 'mt-2 text-sm font-medium leading-5 text-red-500'
                    }
                  >
                    {htmlShareStoppedNotice}
                  </div>
                ) : (
                  <div className="mt-3 text-sm leading-5 text-muted">
                    {htmlShareDialog.message}
                  </div>
                )}

                {canShowHtmlShareAccessModeControls && (
                  <div className="mt-5">
                    <div className="mb-2 text-sm font-medium text-foreground">
                      {t('htmlShareAccessMode')}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        {
                          mode: HtmlShareAccessMode.Code,
                          label: t('htmlShareAccessModeCode'),
                          hint: t('htmlShareAccessModeCodeHint'),
                        },
                        {
                          mode: HtmlShareAccessMode.Public,
                          label: t('htmlShareAccessModePublic'),
                          hint: t('htmlShareAccessModePublicHint'),
                        },
                      ].map(option => {
                        const isSelected = htmlShareSelectedAccessMode === option.mode;
                        return (
                          <button
                            key={option.mode}
                            type="button"
                            onClick={() => selectHtmlShareAccessMode(option.mode)}
                            disabled={isHtmlSharing || isHtmlShareStatusUpdating}
                            className={`min-h-[82px] rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                              isSelected
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'border-border bg-surface text-secondary hover:border-primary/40 hover:text-foreground'
                            }`}
                          >
                            <span className="block text-sm font-medium leading-5">
                              {option.label}
                            </span>
                            <span className="mt-1 block text-xs leading-4 text-muted">
                              {option.hint}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {htmlShareDialog.url && (
                  <div className="mt-5 rounded-sm border border-[#edf0f4] bg-[#f5f6f8] px-4 py-4 dark:border-white/10 dark:bg-white/5">
                    <div className="min-w-0 break-words text-base leading-6 text-foreground">
                      {htmlShareDialog.url}
                    </div>
                    {shouldUseHtmlShareCode(htmlShareDialog.accessMode) && htmlShareDialog.shareCode && (
                      <div className="mt-4 text-base leading-6 text-foreground">
                        <span className="text-muted">{t('htmlShareCode')}</span>
                        <span className="ml-2 font-medium">{htmlShareDialog.shareCode}</span>
                      </div>
                    )}
                  </div>
                )}

                {shouldUseHtmlShareCode(htmlShareDialog.accessMode) &&
                  htmlShareDialog.shareCodeUnavailable && (
                  <div className="mt-3 text-xs leading-5 text-muted">
                    {t('htmlShareCodeUnavailable')}
                  </div>
                )}
                {isHtmlShareExistingDialog && htmlShareDialog.statusError && (
                  <div className="mt-3 text-xs leading-5 text-red-500">
                    {htmlShareDialog.statusError}
                  </div>
                )}

                {isHtmlShareExistingDialog && (
                  <div className="mt-5">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium text-foreground">
                        {t('htmlShareUpdateFile')}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          void updateHtmlShare();
                        }}
                        disabled={isHtmlShareFileUpdateDisabled}
                        title={
                          htmlShareDialog.targetStatus === HtmlShareStatus.Disabled &&
                          !canRestoreActiveLimitDisabledHtmlShare
                            ? t('htmlShareDisabledCannotUpdate')
                            : htmlShareDialog.targetStatus === HtmlShareStatus.Disabled
                              ? t('htmlShareActiveLimitCannotUpdate')
                            : undefined
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <RefreshIcon />
                        {htmlShareUpdateActionLabel}
                      </button>
                    </div>
                    {htmlShareDialog.contentUpdateStatus &&
                      htmlShareDialog.contentUpdateStatus !==
                        HtmlShareContentUpdateStatus.Failed && (
                        <span className="text-sm text-muted">
                          {htmlShareDialog.contentUpdateStatus ===
                          HtmlShareContentUpdateStatus.Updating
                            ? t('htmlShareUpdatingFile')
                            : t('htmlShareUpdateComplete')}
                        </span>
                      )}
                  </div>
                )}

                <div className="mt-12 flex flex-wrap items-center justify-end gap-3">
                  {isHtmlShareCreateDialog && (
                    <button
                      type="button"
                      onClick={() => {
                        if (htmlSharePendingRequest) {
                          void createHtmlShare({
                            ...htmlSharePendingRequest,
                            accessMode: htmlShareSelectedAccessMode,
                          });
                        }
                      }}
                      disabled={isHtmlSharing || !htmlSharePendingRequest}
                      className="inline-flex h-10 min-w-[104px] items-center justify-center whitespace-nowrap rounded-lg bg-primary px-4 text-base text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isHtmlSharing ? t('htmlShareUploading') : t('htmlShareCreateAction')}
                    </button>
                  )}
                  {isHtmlShareExistingDialog && (
                    <button
                      type="button"
                      onClick={toggleHtmlShareTargetStatus}
                      disabled={isHtmlShareAvailabilityActionDisabled}
                      className={htmlShareAvailabilityActionClassName}
                    >
                      {isHtmlShareStatusUpdating
                        ? t('htmlShareStatusUpdating')
                        : htmlShareAvailabilityActionLabel}
                    </button>
                  )}
                  {isHtmlShareExistingDialog && isHtmlShareAccessModeChanged && (
                    <button
                      type="button"
                      onClick={updateHtmlShareAccessMode}
                      disabled={isHtmlShareAccessModeActionDisabled}
                      className="inline-flex h-10 min-w-[128px] items-center justify-center whitespace-nowrap rounded-lg bg-primary px-4 text-base text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isHtmlShareStatusUpdating
                        ? t('htmlShareAccessModeUpdating')
                        : t('htmlShareAccessModeUpdateAction')}
                    </button>
                  )}
                  {canShowHtmlShareDialogCopyAction && (
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyShareLink(
                          htmlShareDialog.url,
                          shouldUseHtmlShareCode(htmlShareDialog.accessMode)
                            ? htmlShareDialog.shareCode
                            : undefined,
                        )
                      }
                      className={`inline-flex h-10 min-w-[104px] items-center justify-center whitespace-nowrap rounded-lg px-4 text-base transition-colors ${
                        htmlShareCopyStatus === HtmlShareCopyStatus.Failed
                          ? 'bg-red-500 text-white hover:bg-red-500/90'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      }`}
                    >
                      {htmlShareCopyButtonLabel}
                    </button>
                  )}
                </div>
              </div>
              ) : (
              <div className="w-full max-w-[420px] rounded-lg border border-border bg-background p-4 shadow-2xl">
                <div className="text-sm font-semibold text-foreground">
                  {htmlShareDialog.title}
                </div>
                <div className="mt-3 space-y-3">
                  <div className="whitespace-pre-wrap break-words text-sm leading-6 text-secondary">
                    {htmlShareDialog.message}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setHtmlShareDialog(null);
                      setHtmlSharePendingRequest(null);
                    }}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground"
                  >
                    {htmlShareDialog.kind === HtmlShareDialogKind.Result ? t('close') : t('cancel')}
                  </button>
                  {htmlShareDialog.kind === HtmlShareDialogKind.Subscription && (
                    <button
                      type="button"
                      onClick={openSubscriptionPage}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {t('htmlShareOpenSubscription')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
      {nodeDeploymentDialog && isNodeDeploymentDialogOpen &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 px-4">
            <div className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
              <button
                type="button"
                onClick={closeNodeDeploymentDialog}
                className="absolute right-4 top-4 z-10 rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-foreground"
                aria-label={t('close')}
                title={t('close')}
              >
                <CloseIcon />
              </button>
              <div className="shrink-0 border-b border-border px-5 py-4 pr-12">
                <div className="text-base font-semibold leading-6 text-foreground">
                  {nodeDeploymentDialog.title}
                </div>
                {shouldShowNodeDeploymentHeaderMessage && (
                  <div className="mt-1 text-xs leading-5 text-muted">
                    {nodeDeploymentDialog.message}
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {isNodeDeploymentAccessModeDialog ? (
                  <div className="space-y-4">
                    {canShowNodeDeploymentAccessModeControls && (
                      <div>
                        <div className="mb-2 text-sm font-medium text-foreground">
                          {t('htmlShareAccessMode')}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            {
                              mode: HtmlShareAccessMode.Code,
                              label: t('htmlShareAccessModeCode'),
                              hint: t('htmlShareAccessModeCodeHint'),
                            },
                            {
                              mode: HtmlShareAccessMode.Public,
                              label: t('htmlShareAccessModePublic'),
                              hint: t('htmlShareAccessModePublicHint'),
                            },
                          ].map(option => {
                            const isSelected = nodeDeploymentSelectedAccessMode === option.mode;
                            return (
                              <button
                                key={option.mode}
                                type="button"
                                onClick={() => selectNodeDeploymentAccessMode(option.mode)}
                                disabled={isNodeDeploymentBusy}
                                className={`min-h-[82px] rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                  isSelected
                                    ? 'border-primary bg-primary/10 text-foreground'
                                    : 'border-border bg-surface text-secondary hover:border-primary/40 hover:text-foreground'
                                }`}
                              >
                                <span className="block text-sm font-medium leading-5">
                                  {option.label}
                                </span>
                                <span className="mt-1 block text-xs leading-4 text-muted">
                                  {option.hint}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : isNodeDeploymentConfirmDialog ? (
                  <div className="space-y-4">
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-secondary">
                        {t('nodeDeploymentProjectDirectory')}
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={nodeDeploymentDialog.projectDirectory || ''}
                          onChange={event => updateNodeDeploymentProjectDirectory(event.target.value)}
                          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-foreground outline-none focus:border-primary"
                          placeholder={t('nodeDeploymentProjectDirectoryPlaceholder')}
                        />
                        <button
                          type="button"
                          onClick={chooseNodeDeploymentProjectDirectory}
                          disabled={isNodeDeploymentBusy}
                          className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-border px-3 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('nodeDeploymentChooseDirectory')}
                        </button>
                      </div>
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() => setIsNodeDeploymentAdvancedOpen(value => !value)}
                        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground"
                      >
                        {t('nodeDeploymentAdvancedSettings')}
                      </button>
                      {isNodeDeploymentAdvancedOpen && (
                        <div className="mt-3 space-y-3 rounded-lg border border-border bg-surface p-3">
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-secondary">
                              {t('nodeDeploymentStartCommand')}
                            </span>
                            <input
                              type="text"
                              value={nodeDeploymentDialog.startCommand || ''}
                              onChange={event => updateNodeDeploymentDialogField('startCommand', event.target.value)}
                              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-secondary">
                              {t('nodeDeploymentBuildCommand')}
                            </span>
                            <input
                              type="text"
                              value={nodeDeploymentDialog.buildCommand || ''}
                              onChange={event => updateNodeDeploymentDialogField('buildCommand', event.target.value)}
                              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-secondary">
                              {t('nodeDeploymentInstallCommand')}
                            </span>
                            <input
                              type="text"
                              value={nodeDeploymentDialog.installCommand || ''}
                              onChange={event => updateNodeDeploymentDialogField('installCommand', event.target.value)}
                              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
                            />
                          </label>
                        </div>
                      )}
                    </div>

                    {nodeDeploymentAnalysis && (
                      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-5">
                        <div className="font-medium text-foreground">
                          {t('nodeDeploymentPackageSummary')}
                        </div>
                        <div className="mt-1 text-secondary">
                          {t('nodeDeploymentPackageSummaryValue')
                            .replace('{files}', String(nodeDeploymentAnalysis.totalFiles))
                            .replace('{size}', formatDeploymentBytes(nodeDeploymentAnalysis.totalBytes))}
                        </div>
                        {nodeDeploymentAnalysis.warnings.length > 0 && (
                          <div className="mt-2 text-amber-700 dark:text-amber-200">
                            {nodeDeploymentAnalysis.warnings.slice(0, 3).join('\n')}
                          </div>
                        )}
                        {nodeDeploymentAnalysis.blockers.length > 0 && (
                          <div className="mt-2 whitespace-pre-wrap text-red-500">
                            {nodeDeploymentAnalysis.blockers.join('\n')}
                          </div>
                        )}
                      </div>
                    )}

                    {nodeDeploymentDialog.error && (
                      <div className="text-xs leading-5 text-red-500">
                        {nodeDeploymentDialog.error}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {isNodeDeploymentStatusDialog && nodeDeployment && isNodeDeploymentShareDisabled && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                        {nodeDeployment.disabledSource === HtmlShareDisabledSource.Admin
                          ? t('htmlShareStoppedByAdminNotice')
                          : nodeDeployment.disabledSource === HtmlShareDisabledSource.Moderation
                            ? t('htmlShareStoppedByModerationNotice')
                            : t('nodeDeploymentShareDisabledMessage')}
                      </div>
                    )}
                    {isNodeDeploymentStatusDialog && (
                      <NodeDeploymentStatusCard
                        phase={nodeDeploymentDialog.phase}
                        deployment={nodeDeployment}
                        statusLabel={nodeDeploymentStatusLabel}
                        message={nodeDeploymentDialog.message}
                      />
                    )}
                    {isNodeDeploymentStatusDialog && nodeDeployment && (
                      <>
                        {canShowNodeDeploymentAccessModeControls && (
                          <div>
                            <div className="mb-2 text-xs font-medium text-secondary">
                              {t('htmlShareAccessMode')}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              {[
                                {
                                  mode: HtmlShareAccessMode.Code,
                                  label: t('htmlShareAccessModeCode'),
                                  hint: t('htmlShareAccessModeCodeHint'),
                                },
                                {
                                  mode: HtmlShareAccessMode.Public,
                                  label: t('htmlShareAccessModePublic'),
                                  hint: t('htmlShareAccessModePublicHint'),
                                },
                              ].map(option => {
                                const isSelected = nodeDeploymentSelectedAccessMode === option.mode;
                                return (
                                  <button
                                    key={option.mode}
                                    type="button"
                                    onClick={() => selectNodeDeploymentAccessMode(option.mode)}
                                    disabled={
                                      isNodeDeploymentBusy ||
                                      isNodeDeploymentStatusUpdating ||
                                      isNodeDeploymentShareDisabled
                                    }
                                    className={`min-h-[72px] rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                      isSelected
                                        ? 'border-primary bg-primary/10 text-foreground'
                                        : 'border-border bg-surface text-secondary hover:border-primary/40 hover:text-foreground'
                                    }`}
                                  >
                                    <span className="block text-sm font-medium leading-5">
                                      {option.label}
                                    </span>
                                    <span className="mt-1 block text-xs leading-4 text-muted">
                                      {option.hint}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-base font-medium text-foreground">
                              {t('nodeDeploymentUpdateFile')}
                            </span>
                            <button
                              type="button"
                              onClick={() => void retryNodeDeployment()}
                              disabled={!canRetryNodeDeployment}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <RefreshIcon />
                              {isNodeDeploymentBusy ? t('nodeDeploymentPreparing') : t('nodeDeploymentRetry')}
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                    {isNodeDeploymentStatusDialog && (
                      <NodeDeploymentProgressSteps
                        phase={nodeDeploymentDialog.phase}
                        status={nodeDeployment?.status}
                      />
                    )}
                    {!isNodeDeploymentStatusDialog && (
                      <div className="whitespace-pre-wrap break-words text-sm leading-6 text-secondary">
                        {nodeDeploymentDialog.message}
                      </div>
                    )}
                    {nodeDeploymentDialog.error && (
                      <div className="text-xs leading-5 text-red-500">
                        {nodeDeploymentDialog.error}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
                {isNodeDeploymentAccessModeDialog && (
                  <button
                    type="button"
                    onClick={confirmNodeDeploymentAccessMode}
                    disabled={isNodeDeploymentBusy || !nodeDeploymentDialog.localService}
                    className="inline-flex h-9 min-w-[104px] items-center justify-center rounded-md bg-primary px-3 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('htmlShareCreateAction')}
                  </button>
                )}
                {isNodeDeploymentConfirmDialog && (
                  <button
                    type="button"
                    onClick={closeNodeDeploymentDialog}
                    className="inline-flex h-9 min-w-[80px] items-center justify-center rounded-md border border-border px-3 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground"
                  >
                    {t('close')}
                  </button>
                )}
                {isNodeDeploymentConfirmDialog && (
                  <button
                    type="button"
                    onClick={() => void submitNodeDeployment()}
                    disabled={isNodeDeploymentSubmitDisabled}
                    className="inline-flex h-9 min-w-[104px] items-center justify-center rounded-md bg-primary px-3 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isNodeDeploymentBusy ? t('nodeDeploymentSubmitting') : t('nodeDeploymentSubmit')}
                  </button>
                )}
                {isNodeDeploymentStatusDialog && nodeDeployment?.shareId && (
                  <button
                    type="button"
                    onClick={() => void toggleNodeDeploymentShareStatus()}
                    disabled={!canToggleNodeDeploymentShareStatus}
                    className={nodeDeploymentShareAvailabilityActionClassName}
                  >
                    {isNodeDeploymentStatusUpdating
                      ? t('htmlShareStatusUpdating')
                      : nodeDeploymentShareAvailabilityActionLabel}
                  </button>
                )}
                {isNodeDeploymentStatusDialog && isNodeDeploymentAccessModeChanged && (
                  <button
                    type="button"
                    onClick={() => void updateNodeDeploymentAccessMode()}
                    disabled={isNodeDeploymentAccessModeActionDisabled}
                    className="inline-flex h-9 min-w-[128px] items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isNodeDeploymentStatusUpdating
                      ? t('htmlShareAccessModeUpdating')
                      : t('htmlShareAccessModeUpdateAction')}
                  </button>
                )}
                {canShowNodeDeploymentFooterRedeploy && (
                  <button
                    type="button"
                    onClick={() => void retryNodeDeployment()}
                    className="inline-flex h-9 min-w-[104px] items-center justify-center rounded-md bg-primary px-3 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('nodeDeploymentRetry')}
                  </button>
                )}
                {canCopyNodeDeploymentLink && (
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyShareLink(
                        nodeDeployment?.url,
                        shouldUseHtmlShareCode(nodeDeployment?.accessMode)
                          ? nodeDeployment?.shareCode
                          : undefined,
                      )
                    }
                    className="inline-flex h-9 min-w-[104px] items-center justify-center rounded-md bg-primary px-3 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    {nodeDeploymentCopyButtonLabel}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  capturePage?: () => Promise<{
    toDataURL: () => string;
    getSize?: () => { width: number; height: number };
  }>;
  executeJavaScript?: (code: string) => Promise<unknown>;
  loadURL?: (url: string) => Promise<void>;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  stop?: () => void;
  getURL?: () => string;
  getTitle?: () => string;
  getZoomFactor?: () => number;
  setZoomFactor?: (factor: number) => void;
};

const BrowserScreenshotStatus = {
  Idle: 'idle',
  Copied: 'copied',
  Error: 'error',
} as const;

type BrowserScreenshotStatus =
  (typeof BrowserScreenshotStatus)[keyof typeof BrowserScreenshotStatus];

const BrowserAnnotationStatus = {
  Sent: 'sent',
  Cancelled: 'cancelled',
} as const;

type BrowserAnnotationStatus =
  (typeof BrowserAnnotationStatus)[keyof typeof BrowserAnnotationStatus];

const BrowserToolbarAction = {
  Annotate: 'annotate',
  Share: 'share',
  OpenExternal: 'openExternal',
} as const;

type BrowserToolbarAction = (typeof BrowserToolbarAction)[keyof typeof BrowserToolbarAction];

const BrowserZoom = {
  Min: 0.25,
  Max: 3,
  Step: 0.1,
  Default: 1,
} as const;

const BrowserPageUrl = {
  Blank: 'about:blank',
} as const;

const LocalServiceDisplay = {
  Limit: 10,
} as const;

function getBrowserTitleBaseName(value: string | undefined): string {
  if (!value) return '';
  let source = value.trim();
  if (!source) return '';
  try {
    const url = new URL(source);
    source = decodeURIComponent(url.pathname || source);
  } catch {
    source = source.split(/[?#]/, 1)[0] ?? source;
  }
  if (source.startsWith('file:///')) {
    source = source.slice(7);
  } else if (source.startsWith('file://')) {
    source = source.slice(7);
  }
  const lastSlash = Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\'));
  return lastSlash >= 0 ? source.slice(lastSlash + 1) : source;
}

function normalizeBrowserPageTitle(
  title: string | undefined,
  pageUrl: string | undefined,
  address: string | undefined,
): string {
  const normalizedTitle = title?.trim() ?? '';
  if (!normalizedTitle) return '';
  const lowerTitle = normalizedTitle.toLowerCase();
  const fallbackSources = [pageUrl, address].map(value => value?.trim().toLowerCase() ?? '').filter(Boolean);
  if (fallbackSources.includes(lowerTitle)) return '';
  const fallbackFileNames = [getBrowserTitleBaseName(pageUrl), getBrowserTitleBaseName(address)]
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (fallbackFileNames.includes(lowerTitle)) return '';
  if (
    /[/\\]/.test(normalizedTitle) &&
    fallbackFileNames.includes(getBrowserTitleBaseName(normalizedTitle).trim().toLowerCase())
  ) {
    return '';
  }
  return normalizedTitle;
}

const BrowserDevicePresetId = {
  Responsive: 'responsive',
  FourK: '4k',
  LaptopLarge: 'laptop-large',
  Laptop: 'laptop',
  SurfacePro7: 'surface-pro-7',
  IPadAir: 'ipad-air',
  IPadMini: 'ipad-mini',
  SurfaceDuo: 'surface-duo',
  IPhone15ProMax: 'iphone-15-pro-max',
  Pixel8: 'pixel-8',
  IPhone15Pro: 'iphone-15-pro',
  SamsungGalaxyS24Ultra: 'samsung-galaxy-s24-ultra',
  IPhoneSe: 'iphone-se',
} as const;

type BrowserDevicePresetId = (typeof BrowserDevicePresetId)[keyof typeof BrowserDevicePresetId];

interface BrowserDevicePreset {
  id: BrowserDevicePresetId;
  labelKey?: string;
  label?: string;
  width: number;
  height: number;
}

const BrowserDeviceViewport = {
  MinSize: 50,
  MaxSize: 9999,
  DefaultWidth: 880,
  DefaultHeight: 888,
} as const;

const BrowserDeviceScale = {
  Min: 0.25,
  Max: 2,
  Default: 1,
} as const;

const BROWSER_DEVICE_PRESETS: BrowserDevicePreset[] = [
  {
    id: BrowserDevicePresetId.Responsive,
    labelKey: 'artifactBrowserDeviceResponsive',
    width: BrowserDeviceViewport.DefaultWidth,
    height: BrowserDeviceViewport.DefaultHeight,
  },
  { id: BrowserDevicePresetId.FourK, label: '4K', width: 3840, height: 2160 },
  { id: BrowserDevicePresetId.LaptopLarge, label: 'Laptop L', width: 1440, height: 900 },
  {
    id: BrowserDevicePresetId.Laptop,
    labelKey: 'artifactBrowserDeviceLaptop',
    width: 1366,
    height: 768,
  },
  { id: BrowserDevicePresetId.SurfacePro7, label: 'Surface Pro 7', width: 912, height: 1368 },
  { id: BrowserDevicePresetId.IPadAir, label: 'iPad Air', width: 820, height: 1180 },
  { id: BrowserDevicePresetId.IPadMini, label: 'iPad Mini', width: 768, height: 1024 },
  { id: BrowserDevicePresetId.SurfaceDuo, label: 'Surface Duo', width: 540, height: 720 },
  { id: BrowserDevicePresetId.IPhone15ProMax, label: 'iPhone 15 Pro Max', width: 430, height: 932 },
  { id: BrowserDevicePresetId.Pixel8, label: 'Pixel 8', width: 412, height: 915 },
  { id: BrowserDevicePresetId.IPhone15Pro, label: 'iPhone 15 Pro', width: 393, height: 852 },
  {
    id: BrowserDevicePresetId.SamsungGalaxyS24Ultra,
    label: 'Samsung Galaxy S24 Ultra',
    width: 384,
    height: 824,
  },
  { id: BrowserDevicePresetId.IPhoneSe, label: 'iPhone SE', width: 375, height: 667 },
];

const BROWSER_DEVICE_SCALE_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

interface BrowserToolbarTooltipPosition {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
}

interface BrowserAnnotationResult {
  status: BrowserAnnotationStatus;
  comment?: string;
  pageUrl?: string;
  pageTitle?: string;
  element?: BrowserAnnotationElementInfo;
  rect?: BrowserAnnotationRect;
  viewport?: BrowserAnnotationScreenshotInfo;
}

function normalizeBrowserAnnotationRect(
  rect: BrowserAnnotationRect,
  viewport: BrowserAnnotationScreenshotInfo | undefined,
  screenshot: BrowserAnnotationScreenshotInfo,
): BrowserAnnotationMarkInfo {
  const screenshotWidth = screenshot.width > 0 ? screenshot.width : 1;
  const screenshotHeight = screenshot.height > 0 ? screenshot.height : 1;
  const viewportWidth = viewport?.width && viewport.width > 0 ? viewport.width : screenshotWidth;
  const viewportHeight =
    viewport?.height && viewport.height > 0 ? viewport.height : screenshotHeight;
  const scaleX = screenshotWidth / viewportWidth;
  const scaleY = screenshotHeight / viewportHeight;
  const x = Math.max(0, Math.min(screenshotWidth, Math.round(rect.x * scaleX)));
  const y = Math.max(0, Math.min(screenshotHeight, Math.round(rect.y * scaleY)));
  const maxWidth = Math.max(0, screenshotWidth - x);
  const maxHeight = Math.max(0, screenshotHeight - y);

  return {
    shape: BrowserAnnotationShape.Rectangle,
    color: BrowserAnnotationColor.Blue,
    x,
    y,
    width: Math.max(0, Math.min(maxWidth, Math.round(rect.width * scaleX))),
    height: Math.max(0, Math.min(maxHeight, Math.round(rect.height * scaleY))),
  };
}

function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function normalizeBrowserPreviewUrlForMatch(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isSameBrowserPreviewUrl(value: string, previewUrl: string): boolean {
  if (!value || !previewUrl) return false;
  return normalizeBrowserPreviewUrlForMatch(value) === normalizeBrowserPreviewUrlForMatch(previewUrl);
}

function clampBrowserZoomFactor(value: number): number {
  return Math.max(BrowserZoom.Min, Math.min(BrowserZoom.Max, Number(value.toFixed(2))));
}

function clampBrowserDeviceSize(value: number): number {
  if (!Number.isFinite(value)) return BrowserDeviceViewport.MinSize;
  return Math.max(
    BrowserDeviceViewport.MinSize,
    Math.min(BrowserDeviceViewport.MaxSize, Math.round(value)),
  );
}

function clampBrowserDeviceScale(value: number): number {
  if (!Number.isFinite(value)) return BrowserDeviceScale.Default;
  return Math.max(
    BrowserDeviceScale.Min,
    Math.min(BrowserDeviceScale.Max, Number(value.toFixed(2))),
  );
}

function getBrowserDevicePresetLabel(preset: BrowserDevicePreset): string {
  return preset.labelKey ? t(preset.labelKey) : (preset.label ?? preset.id);
}

function isLocalServiceHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return (
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '0.0.0.0' ||
    value === '[::1]' ||
    value === '::1'
  );
}

function parseLocalServiceUrl(
  rawUrl: string | undefined,
  title?: string,
  projectDirectory?: string,
  projectCandidates?: ShareDeploymentProjectCandidate[],
): LocalWebService | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (!isLocalServiceHostname(parsed.hostname) || !parsed.port) return null;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      id: `localhost:${port}`,
      title: title || `localhost:${port}`,
      url: rawUrl.trim(),
      host: parsed.hostname,
      port,
      online: false,
      ...(projectDirectory?.trim() ? { projectDirectory: projectDirectory.trim() } : {}),
      ...(projectCandidates?.length ? { projectCandidates } : {}),
    };
  } catch {
    return null;
  }
}

function parseLocalServiceArtifact(artifact: Artifact): LocalWebService | null {
  if (artifact.type !== ArtifactTypeValue.LocalService) return null;
  return parseLocalServiceUrl(
    artifact.url || artifact.content,
    artifact.title,
    artifact.localService?.projectDirectory,
    artifact.localService?.projectCandidates,
  );
}

function shouldPreferLocalService(candidate: LocalWebService, current: LocalWebService): boolean {
  const candidateHasProject = Boolean(candidate.projectDirectory?.trim());
  const currentHasProject = Boolean(current.projectDirectory?.trim());
  if (candidateHasProject !== currentHasProject) return candidateHasProject;
  const candidateCandidateCount = candidate.projectCandidates?.length ?? 0;
  const currentCandidateCount = current.projectCandidates?.length ?? 0;
  if (candidateCandidateCount !== currentCandidateCount) return candidateCandidateCount > currentCandidateCount;
  if (candidate.online !== current.online) return candidate.online;
  return false;
}

function getSessionLocalServices(artifacts: Artifact[] | undefined): LocalWebService[] {
  const byPort = new Map<number, LocalWebService>();
  for (const artifact of artifacts ?? []) {
    const service = parseLocalServiceArtifact(artifact);
    if (!service) continue;
    const existing = byPort.get(service.port);
    if (!existing || shouldPreferLocalService(service, existing)) {
      byPort.set(service.port, service);
    }
  }
  return Array.from(byPort.values());
}

function mergeLocalServices(
  sessionServices: LocalWebService[],
  discoveredServices: LocalWebService[],
): LocalWebService[] {
  const byPort = new Map<number, LocalWebService>();
  const discoveredByPort = new Map(discoveredServices.map(service => [service.port, service]));

  for (const sessionService of sessionServices) {
    const discovered = discoveredByPort.get(sessionService.port);
    const service = discovered
      ? {
          ...sessionService,
          title: discovered.title || sessionService.title,
          url: sessionService.url || discovered.url,
          host: discovered.host || sessionService.host,
          online: true,
        }
      : sessionService;
    const existing = byPort.get(service.port);
    if (!existing || shouldPreferLocalService(service, existing)) {
      byPort.set(service.port, service);
    }
  }

  for (const discoveredService of discoveredServices) {
    const existing = byPort.get(discoveredService.port);
    if (!existing || shouldPreferLocalService(discoveredService, existing)) {
      byPort.set(discoveredService.port, discoveredService);
    }
  }

  return Array.from(byPort.values()).slice(0, LocalServiceDisplay.Limit);
}

interface BrowserAnnotationLabels {
  instruction: string;
  placeholder: string;
  send: string;
  tag: string;
  size: string;
  color: string;
  font: string;
  statusSent: BrowserAnnotationStatus;
  statusCancelled: BrowserAnnotationStatus;
}

function buildBrowserAnnotationScript(labels: BrowserAnnotationLabels): string {
  return `
(() => {
  const labels = ${JSON.stringify(labels)};
  if (window.__lobsterAnnotationCleanup) {
    window.__lobsterAnnotationCleanup();
  }

  const overlayRoot = document.createElement('div');
  overlayRoot.setAttribute('data-lobster-annotation-ui', 'true');
  overlayRoot.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  const highlight = document.createElement('div');
  highlight.style.cssText = 'position:fixed;display:none;box-sizing:border-box;border:2px solid #1683ff;background:rgba(22,131,255,0.08);box-shadow:0 0 0 1px rgba(255,255,255,0.9);pointer-events:none;';

  const tooltip = document.createElement('div');
  tooltip.style.cssText = 'position:fixed;display:none;max-width:260px;border-radius:8px;background:rgba(18,18,22,0.94);color:#fff;padding:8px 10px;font-size:12px;line-height:1.4;box-shadow:0 8px 22px rgba(0,0,0,0.28);pointer-events:none;';

  const composer = document.createElement('div');
  composer.setAttribute('data-lobster-annotation-ui', 'true');
  composer.style.cssText = 'position:fixed;display:none;min-width:300px;max-width:380px;border-radius:16px;background:rgba(22,22,24,0.96);color:#fff;padding:6px 7px;box-shadow:0 12px 32px rgba(0,0,0,0.28);pointer-events:auto;gap:6px;align-items:center;';

  const textarea = document.createElement('textarea');
  textarea.placeholder = labels.placeholder;
  textarea.rows = 1;
  textarea.style.cssText = 'min-width:0;flex:1;height:30px;max-height:84px;resize:none;border:0;outline:none;border-radius:10px;background:transparent;color:#fff;padding:5px 8px;font:13px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"></path><path d="M5 12l7-7 7 7"></path></svg>';
  sendButton.title = labels.send;
  sendButton.setAttribute('aria-label', labels.send);
  sendButton.style.cssText = 'width:32px;height:32px;border:0;border-radius:999px;background:#fff;color:#111;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:opacity 120ms ease, transform 120ms ease;';

  composer.append(textarea, sendButton);
  overlayRoot.append(highlight, tooltip, composer);
  document.documentElement.appendChild(overlayRoot);

  let selectedInfo = null;
  let frozen = false;
  let resolved = false;
  let resolvePromise;

  const cleanup = () => {
    if (!resolved) {
      finish({ status: labels.statusCancelled });
    }
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    overlayRoot.remove();
    delete window.__lobsterAnnotationCleanup;
  };

  const finish = (result) => {
    if (resolved) return;
    resolved = true;
    resolvePromise(result);
  };

  const isAnnotationUi = (target) => target?.closest?.('[data-lobster-annotation-ui="true"]');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const formatFont = (value) => cleanText(value).split(',')[0].replace(/["']/g, '').slice(0, 42);
  const hasComment = () => textarea.value.trim().length > 0;

  const updateSendState = () => {
    const enabled = hasComment();
    sendButton.disabled = !enabled;
    sendButton.style.opacity = enabled ? '1' : '0.42';
    sendButton.style.cursor = enabled ? 'pointer' : 'not-allowed';
    sendButton.style.transform = enabled ? 'scale(1)' : 'scale(0.98)';
  };

  const readInfo = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const tagName = element.tagName ? element.tagName.toLowerCase() : 'element';
    const elementText = element.getAttribute('aria-label') || element.getAttribute('alt') || element.innerText || element.textContent || '';
    return {
      tagName,
      text: cleanText(elementText),
      color: style.color || '',
      fontFamily: formatFont(style.fontFamily || ''),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    };
  };

  const renderHighlight = (info) => {
    const rect = info.rect;
    highlight.style.display = 'block';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
  };

  const renderTooltip = (info) => {
    const rect = info.rect;
    tooltip.innerHTML = [
      '<div style="display:flex;gap:12px;justify-content:space-between;"><strong>' + info.tagName + '</strong><span>' + info.width + '×' + info.height + '</span></div>',
      '<div style="display:grid;grid-template-columns:auto 1fr;column-gap:10px;margin-top:4px;color:#d6d6d6;"><span>' + labels.color + '</span><strong style="color:#fff;font-weight:600;">' + (info.color || '-') + '</strong><span>' + labels.font + '</span><strong style="color:#fff;font-weight:600;">' + (info.fontFamily || '-') + '</strong></div>',
      info.text ? '<div style="margin-top:4px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + info.text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) + '</div>' : ''
    ].join('');
    tooltip.style.display = 'block';
    tooltip.style.left = clamp(rect.left, 8, window.innerWidth - 270) + 'px';
    tooltip.style.top = clamp(rect.top - tooltip.offsetHeight - 10, 8, window.innerHeight - tooltip.offsetHeight - 8) + 'px';
  };

  const renderComposer = (info) => {
    const rect = info.rect;
    composer.style.display = 'flex';
    composer.style.left = clamp(rect.left + Math.min(100, rect.width / 2), 8, window.innerWidth - 388) + 'px';
    composer.style.top = clamp(rect.top + Math.min(32, rect.height / 2), 8, window.innerHeight - 52) + 'px';
    textarea.focus();
  };

  function handleMouseMove(event) {
    if (frozen || isAnnotationUi(event.target)) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    const info = readInfo(element);
    if (info.width <= 0 || info.height <= 0) return;
    selectedInfo = info;
    renderHighlight(info);
    renderTooltip(info);
  }

  function handleClick(event) {
    if (isAnnotationUi(event.target)) return;
    if (!selectedInfo) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    frozen = true;
    tooltip.style.display = 'none';
    renderHighlight(selectedInfo);
    renderComposer(selectedInfo);
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish({ status: labels.statusCancelled });
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && selectedInfo) {
      event.preventDefault();
      sendButton.click();
    }
  }

  sendButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedInfo) return;
    if (!hasComment()) {
      updateSendState();
      textarea.focus();
      return;
    }
    composer.style.display = 'none';
    const { rect, ...element } = selectedInfo;
    finish({
      status: labels.statusSent,
      comment: textarea.value.trim(),
      pageUrl: location.href,
      pageTitle: document.title || '',
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      element,
    });
  });

  textarea.addEventListener('input', updateSendState);
  updateSendState();

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  window.__lobsterAnnotationCleanup = cleanup;

  return new Promise((resolve) => {
    resolvePromise = resolve;
  });
})()
`;
}

interface BrowserTabContentProps {
  address: string;
  currentUrl: string;
  sessionArtifacts?: Artifact[];
  canShare?: boolean;
  shareButtonTitle?: string;
  hasExistingShare?: boolean;
  isSharing?: boolean;
  onShare?: () => void | Promise<void>;
  autoRefreshFilePath?: string;
  localHtmlPreviewUrl?: string;
  onAddressChange: (value: string) => void;
  onCurrentUrlChange: (value: string) => void;
  onTitleChange?: (value: string) => void;
  onLocalServiceOpen?: (service: LocalWebService) => void;
  onAnnotationCaptured?: (payload: BrowserAnnotationPayload) => void;
}

const BrowserTabContent: React.FC<BrowserTabContentProps> = ({
  address,
  currentUrl,
  sessionArtifacts,
  canShare = false,
  shareButtonTitle = t('htmlShare'),
  hasExistingShare = false,
  isSharing = false,
  onShare,
  autoRefreshFilePath,
  localHtmlPreviewUrl,
  onAddressChange,
  onCurrentUrlChange,
  onTitleChange,
  onLocalServiceOpen,
  onAnnotationCaptured,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotStatus, setScreenshotStatus] = useState<BrowserScreenshotStatus>(
    BrowserScreenshotStatus.Idle,
  );
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [localServices, setLocalServices] = useState<LocalWebService[]>([]);
  const [isLoadingLocalServices, setIsLoadingLocalServices] = useState(false);
  const [hoveredToolbarAction, setHoveredToolbarAction] = useState<BrowserToolbarAction | null>(
    null,
  );
  const [toolbarTooltipPosition, setToolbarTooltipPosition] =
    useState<BrowserToolbarTooltipPosition | null>(null);
  const [webviewNode, setWebviewNode] = useState<BrowserWebviewElement | null>(null);
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [isBrowserMenuOpen, setIsBrowserMenuOpen] = useState(false);
  const [browserZoomFactor, setBrowserZoomFactor] = useState<number>(BrowserZoom.Default);
  const [isDeviceToolbarVisible, setIsDeviceToolbarVisible] = useState(false);
  const [isAddressBarFocused, setIsAddressBarFocused] = useState(false);
  const [isAddressOpenExternalHovered, setIsAddressOpenExternalHovered] = useState(false);
  const [devicePresetId, setDevicePresetId] = useState<BrowserDevicePresetId>(
    BrowserDevicePresetId.Responsive,
  );
  const [deviceWidth, setDeviceWidth] = useState<number>(BrowserDeviceViewport.DefaultWidth);
  const [deviceHeight, setDeviceHeight] = useState<number>(BrowserDeviceViewport.DefaultHeight);
  const [deviceScale, setDeviceScale] = useState<number>(BrowserDeviceScale.Default);
  const annotateButtonRef = useRef<HTMLDivElement>(null);
  const shareButtonRef = useRef<HTMLDivElement>(null);
  const openExternalButtonRef = useRef<HTMLDivElement>(null);
  const addressBarRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const browserMenuButtonRef = useRef<HTMLButtonElement>(null);
  const browserMenuRef = useRef<HTMLDivElement>(null);
  const screenshotStatusTimeoutRef = useRef<number | undefined>(undefined);
  const autoRefreshTimeoutRef = useRef<number | undefined>(undefined);
  const lastRequestedUrlRef = useRef('');
  const lastRequestedWebviewRef = useRef<BrowserWebviewElement | null>(null);
  const webviewNodeRef = useRef<BrowserWebviewElement | null>(null);
  const sessionLocalServices = useMemo(
    () => getSessionLocalServices(sessionArtifacts),
    [sessionArtifacts],
  );
  const reportBrowserAction = useCallback((
    actionType: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => {
    reportArtifactPreviewAction({
      actionType,
      source: 'artifact_browser',
      params: {
        browserUrlType: getArtifactBrowserUrlType(currentUrl || address),
        hasCurrentUrl: Boolean(currentUrl),
        isDeviceToolbarVisible,
        browserZoomPercent: Math.round(browserZoomFactor * 100),
        devicePreset: devicePresetId,
        deviceScalePercent: Math.round(deviceScale * 100),
        ...params,
      },
    });
  }, [
    address,
    browserZoomFactor,
    currentUrl,
    devicePresetId,
    deviceScale,
    isDeviceToolbarVisible,
  ]);

  const hideAddressOpenExternal = useCallback(() => {
    setIsAddressBarFocused(false);
    setIsAddressOpenExternalHovered(false);
    setHoveredToolbarAction(action =>
      action === BrowserToolbarAction.OpenExternal ? null : action,
    );
  }, []);

  useEffect(
    () => () => {
      if (screenshotStatusTimeoutRef.current !== undefined) {
        window.clearTimeout(screenshotStatusTimeoutRef.current);
      }
      if (autoRefreshTimeoutRef.current !== undefined) {
        window.clearTimeout(autoRefreshTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isAddressBarFocused && !isAddressOpenExternalHovered) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && addressBarRef.current?.contains(target)) return;
      hideAddressOpenExternal();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && addressBarRef.current?.contains(target)) return;
      hideAddressOpenExternal();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('blur', hideAddressOpenExternal);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('blur', hideAddressOpenExternal);
    };
  }, [hideAddressOpenExternal, isAddressBarFocused, isAddressOpenExternalHovered]);

  const handleWebviewRef = useCallback((node: BrowserWebviewElement | null) => {
    if (webviewNodeRef.current === node) return;
    webviewNodeRef.current = node;
    lastRequestedUrlRef.current = '';
    lastRequestedWebviewRef.current = null;
    setIsWebviewReady(false);
    setWebviewNode(node);
  }, []);

  const loadLocalServices = useCallback(async () => {
    if (!window.electron?.artifact?.listLocalWebServices) return;
    setIsLoadingLocalServices(true);
    try {
      const services = await window.electron.artifact.listLocalWebServices({
        preferredPorts: sessionLocalServices.map(service => service.port),
      });
      setLocalServices(mergeLocalServices(sessionLocalServices, services));
    } catch {
      setLocalServices(sessionLocalServices.slice(0, LocalServiceDisplay.Limit));
    } finally {
      setIsLoadingLocalServices(false);
    }
  }, [sessionLocalServices]);

  useEffect(() => {
    if (currentUrl) return;
    void loadLocalServices();
  }, [currentUrl, loadLocalServices]);

  useEffect(() => {
    if (!isBrowserMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        browserMenuRef.current?.contains(target) ||
        browserMenuButtonRef.current?.contains(target)
      ) {
        return;
      }
      setIsBrowserMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsBrowserMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isBrowserMenuOpen]);

  const getBrowserAddressForUrl = useCallback(
    (nextUrl: string): string => {
      if (
        autoRefreshFilePath &&
        localHtmlPreviewUrl &&
        isSameBrowserPreviewUrl(nextUrl, localHtmlPreviewUrl)
      ) {
        return autoRefreshFilePath;
      }
      return nextUrl;
    },
    [autoRefreshFilePath, localHtmlPreviewUrl],
  );

  const syncBrowserTitle = useCallback(
    (node: BrowserWebviewElement | null) => {
      if (!onTitleChange || !node) return;
      const pageUrl = node.getURL?.() || currentUrl;
      const addressSnapshot = address;
      const emitTitle = (value: string | undefined) => {
        onTitleChange(normalizeBrowserPageTitle(value, pageUrl, addressSnapshot));
      };

      if (!node.executeJavaScript) {
        emitTitle(node.getTitle?.());
        return;
      }

      void node
        .executeJavaScript('document.title || ""')
        .then(result => {
          if (pageUrl && node.getURL?.() && node.getURL?.() !== pageUrl) return;
          emitTitle(typeof result === 'string' ? result : '');
        })
        .catch(() => {
          emitTitle(node.getTitle?.());
        });
    },
    [address, currentUrl, onTitleChange],
  );

  const syncNavigationState = useCallback(
    (node: BrowserWebviewElement | null) => {
      if (!node) return;
      setCanGoBack(node.canGoBack?.() ?? false);
      setCanGoForward(node.canGoForward?.() ?? false);
      syncBrowserTitle(node);
      const nextUrl = node.getURL?.();
      if (nextUrl && nextUrl !== BrowserPageUrl.Blank) {
        onCurrentUrlChange(nextUrl);
        onAddressChange(getBrowserAddressForUrl(nextUrl));
      }
    },
    [getBrowserAddressForUrl, onAddressChange, onCurrentUrlChange, syncBrowserTitle],
  );

  const getToolbarActionElement = useCallback(
    (action: BrowserToolbarAction): HTMLDivElement | null => {
      switch (action) {
        case BrowserToolbarAction.Annotate:
          return annotateButtonRef.current;
        case BrowserToolbarAction.Share:
          return shareButtonRef.current;
        case BrowserToolbarAction.OpenExternal:
          return openExternalButtonRef.current;
        default:
          return null;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!hoveredToolbarAction) {
      setToolbarTooltipPosition(null);
      return;
    }

    const updatePosition = () => {
      const element = getToolbarActionElement(hoveredToolbarAction);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const placement = rect.top >= 34 ? 'top' : 'bottom';
      const top = placement === 'top' ? rect.top - 8 : rect.bottom + 8;
      const left = Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2));
      setToolbarTooltipPosition({ left, top, placement });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [getToolbarActionElement, hoveredToolbarAction]);

  useLayoutEffect(() => {
    if (!webviewNode) return;

    const handleStartLoading = () => setIsLoading(true);
    const handleStopLoading = () => {
      setIsLoading(false);
      syncNavigationState(webviewNode);
    };
    const handleNavigate = (event: Event) => {
      const nextUrl = (event as Event & { url?: string }).url;
      if (nextUrl && nextUrl !== BrowserPageUrl.Blank) {
        onCurrentUrlChange(nextUrl);
        onAddressChange(getBrowserAddressForUrl(nextUrl));
      }
      syncNavigationState(webviewNode);
    };
    const handleTitleUpdated = () => {
      syncBrowserTitle(webviewNode);
    };
    const handleFailLoad = (event: Event) => {
      const detail = event as Event & { errorCode?: number };
      setIsLoading(false);
      if (detail.errorCode === -3) return;
      syncNavigationState(webviewNode);
    };
    const handleDomReady = () => {
      setIsWebviewReady(true);
      webviewNode.setZoomFactor?.(browserZoomFactor);
      handleStopLoading();
    };

    webviewNode.addEventListener('did-start-loading', handleStartLoading);
    webviewNode.addEventListener('did-stop-loading', handleStopLoading);
    webviewNode.addEventListener('did-fail-load', handleFailLoad);
    webviewNode.addEventListener('did-navigate', handleNavigate);
    webviewNode.addEventListener('did-navigate-in-page', handleNavigate);
    webviewNode.addEventListener('page-title-updated', handleTitleUpdated);
    webviewNode.addEventListener('dom-ready', handleDomReady);
    return () => {
      webviewNode.removeEventListener('did-start-loading', handleStartLoading);
      webviewNode.removeEventListener('did-stop-loading', handleStopLoading);
      webviewNode.removeEventListener('did-fail-load', handleFailLoad);
      webviewNode.removeEventListener('did-navigate', handleNavigate);
      webviewNode.removeEventListener('did-navigate-in-page', handleNavigate);
      webviewNode.removeEventListener('page-title-updated', handleTitleUpdated);
      webviewNode.removeEventListener('dom-ready', handleDomReady);
    };
  }, [
    browserZoomFactor,
    getBrowserAddressForUrl,
    onAddressChange,
    onCurrentUrlChange,
    syncBrowserTitle,
    syncNavigationState,
    webviewNode,
  ]);

  useEffect(() => {
    if (!isWebviewReady || !webviewNode?.setZoomFactor) return;
    webviewNode.setZoomFactor(browserZoomFactor);
  }, [browserZoomFactor, isWebviewReady, webviewNode]);

  useEffect(() => {
    if (!autoRefreshFilePath || !currentUrl) return;

    let cleanup: (() => void) | undefined;
    const watchedPath = autoRefreshFilePath;
    window.electron?.artifact?.watchFile(watchedPath);
    cleanup = window.electron?.artifact?.onFileChanged(({ filePath: changedPath }) => {
      if (changedPath !== watchedPath) return;
      if (autoRefreshTimeoutRef.current !== undefined) {
        window.clearTimeout(autoRefreshTimeoutRef.current);
      }
      autoRefreshTimeoutRef.current = window.setTimeout(() => {
        autoRefreshTimeoutRef.current = undefined;
        webviewNodeRef.current?.reload?.();
      }, 120);
    });

    return () => {
      if (autoRefreshTimeoutRef.current !== undefined) {
        window.clearTimeout(autoRefreshTimeoutRef.current);
        autoRefreshTimeoutRef.current = undefined;
      }
      cleanup?.();
      window.electron?.artifact?.unwatchFile(watchedPath);
    };
  }, [autoRefreshFilePath, currentUrl]);

  useEffect(() => {
    if (!currentUrl || !isWebviewReady || !webviewNode?.loadURL) return;

    const loadedUrl = webviewNode.getURL?.();
    const isSamePendingRequest =
      lastRequestedWebviewRef.current === webviewNode && lastRequestedUrlRef.current === currentUrl;
    if (loadedUrl === currentUrl || isSamePendingRequest) return;

    lastRequestedUrlRef.current = currentUrl;
    lastRequestedWebviewRef.current = webviewNode;
    setIsLoading(true);
    let loadPromise: Promise<void>;
    try {
      loadPromise = webviewNode.loadURL(currentUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('dom-ready') || message.includes('attached to the DOM')) {
        setIsWebviewReady(false);
        return;
      }
      lastRequestedUrlRef.current = '';
      lastRequestedWebviewRef.current = null;
      setIsLoading(false);
      return;
    }
    loadPromise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ERR_ABORTED') || message.includes('(-3)')) return;
      lastRequestedUrlRef.current = '';
      lastRequestedWebviewRef.current = null;
      setIsLoading(false);
    });
  }, [currentUrl, isWebviewReady, webviewNode]);

  const handleNavigate = useCallback(() => {
    const trimmedAddress = address.trim();
    reportBrowserAction('browser_address_submit', {
      browserUrlType: getArtifactBrowserUrlType(trimmedAddress),
    });
    if (
      autoRefreshFilePath &&
      localHtmlPreviewUrl &&
      trimmedAddress === autoRefreshFilePath
    ) {
      onTitleChange?.('');
      onCurrentUrlChange(localHtmlPreviewUrl);
      onAddressChange(autoRefreshFilePath);
      webviewNodeRef.current?.reload?.();
      return;
    }

    const nextUrl = normalizeBrowserUrl(address);
    if (!nextUrl) return;
    onTitleChange?.('');
    onCurrentUrlChange(nextUrl);
    onAddressChange(nextUrl);
  }, [
    address,
    autoRefreshFilePath,
    localHtmlPreviewUrl,
    onAddressChange,
    onCurrentUrlChange,
    onTitleChange,
    reportBrowserAction,
  ]);

  const handleOpenLocalService = useCallback(
    (service: LocalWebService) => {
      reportBrowserAction('browser_open_local_service', {
        browserUrlType: 'localhost',
        servicePort: service.port,
        serviceOnline: service.online,
      });
      onLocalServiceOpen?.(service);
      onTitleChange?.('');
      onCurrentUrlChange(service.url);
      onAddressChange(service.url);
    },
    [onAddressChange, onCurrentUrlChange, onLocalServiceOpen, onTitleChange, reportBrowserAction],
  );

  const handleAddressKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        handleNavigate();
      }
    },
    [handleNavigate],
  );

  const handleAddressFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
    setIsAddressBarFocused(true);
    event.currentTarget.select();
  }, []);

  const handleAddressBarFocusCapture = useCallback(() => {
    setIsAddressBarFocused(true);
  }, []);

  const handleAddressBarBlurCapture = useCallback(() => {
    window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (activeElement && addressBarRef.current?.contains(activeElement)) return;
      hideAddressOpenExternal();
    });
  }, [hideAddressOpenExternal]);

  const handleAddressBarMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    addressInputRef.current?.focus();
    addressInputRef.current?.select();
  }, []);

  const handleAddressOpenExternalMouseEnter = useCallback(() => {
    if (!currentUrl) return;
    setIsAddressOpenExternalHovered(true);
    setHoveredToolbarAction(BrowserToolbarAction.OpenExternal);
  }, [currentUrl]);

  const handleAddressOpenExternalMouseLeave = useCallback(() => {
    setIsAddressOpenExternalHovered(false);
    setHoveredToolbarAction(null);
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (!currentUrl) return;
    reportBrowserAction('browser_open_external', {
      browserUrlType: getArtifactBrowserUrlType(currentUrl),
    });
    window.electron?.shell?.openExternal(currentUrl);
  }, [currentUrl, reportBrowserAction]);

  const handleToggleDeviceToolbar = useCallback(() => {
    setIsDeviceToolbarVisible(value => {
      const nextVisible = !value;
      reportBrowserAction('browser_device_toolbar_toggle', {
        targetOpen: nextVisible,
      });
      return nextVisible;
    });
    setIsBrowserMenuOpen(false);
  }, [reportBrowserAction]);

  const handleDevicePresetChange = useCallback((value: string) => {
    const preset = BROWSER_DEVICE_PRESETS.find(item => item.id === value);
    if (!preset) return;
    reportBrowserAction('browser_device_preset_change', {
      targetDevicePreset: preset.id,
      targetDeviceWidth: preset.width,
      targetDeviceHeight: preset.height,
    });
    setDevicePresetId(preset.id);
    setDeviceWidth(preset.width);
    setDeviceHeight(preset.height);
  }, [reportBrowserAction]);

  const handleDeviceWidthChange = useCallback((value: string) => {
    reportBrowserAction('browser_device_size_change', {
      dimension: 'width',
      targetDeviceSize: clampBrowserDeviceSize(Number(value)),
    });
    setDevicePresetId(BrowserDevicePresetId.Responsive);
    setDeviceWidth(clampBrowserDeviceSize(Number(value)));
  }, [reportBrowserAction]);

  const handleDeviceHeightChange = useCallback((value: string) => {
    reportBrowserAction('browser_device_size_change', {
      dimension: 'height',
      targetDeviceSize: clampBrowserDeviceSize(Number(value)),
    });
    setDevicePresetId(BrowserDevicePresetId.Responsive);
    setDeviceHeight(clampBrowserDeviceSize(Number(value)));
  }, [reportBrowserAction]);

  const handleRotateDevice = useCallback(() => {
    reportBrowserAction('browser_device_rotate', {
      targetDeviceWidth: deviceHeight,
      targetDeviceHeight: deviceWidth,
    });
    setDevicePresetId(BrowserDevicePresetId.Responsive);
    setDeviceWidth(deviceHeight);
    setDeviceHeight(deviceWidth);
  }, [deviceHeight, deviceWidth, reportBrowserAction]);

  const handleDeviceScaleChange = useCallback((value: string) => {
    reportBrowserAction('browser_device_scale_change', {
      targetDeviceScalePercent: Math.round(clampBrowserDeviceScale(Number(value)) * 100),
    });
    setDeviceScale(clampBrowserDeviceScale(Number(value)));
  }, [reportBrowserAction]);

  const applyBrowserZoom = useCallback(
    (nextFactor: number) => {
      const clampedFactor = clampBrowserZoomFactor(nextFactor);
      setBrowserZoomFactor(clampedFactor);
      webviewNode?.setZoomFactor?.(clampedFactor);
    },
    [webviewNode],
  );

  const handleZoomOut = useCallback(() => {
    reportBrowserAction('browser_zoom_out', {
      targetBrowserZoomPercent: Math.round(clampBrowserZoomFactor(browserZoomFactor - BrowserZoom.Step) * 100),
    });
    applyBrowserZoom(browserZoomFactor - BrowserZoom.Step);
  }, [applyBrowserZoom, browserZoomFactor, reportBrowserAction]);

  const handleZoomIn = useCallback(() => {
    reportBrowserAction('browser_zoom_in', {
      targetBrowserZoomPercent: Math.round(clampBrowserZoomFactor(browserZoomFactor + BrowserZoom.Step) * 100),
    });
    applyBrowserZoom(browserZoomFactor + BrowserZoom.Step);
  }, [applyBrowserZoom, browserZoomFactor, reportBrowserAction]);

  const handleResetZoom = useCallback(() => {
    reportBrowserAction('browser_zoom_reset', {
      targetBrowserZoomPercent: Math.round(BrowserZoom.Default * 100),
    });
    applyBrowserZoom(BrowserZoom.Default);
  }, [applyBrowserZoom, reportBrowserAction]);

  const handleOpenBlankPage = useCallback(() => {
    reportBrowserAction('browser_open_blank_page');
    setIsBrowserMenuOpen(false);
    lastRequestedUrlRef.current = '';
    lastRequestedWebviewRef.current = null;
    onAddressChange('');
    onCurrentUrlChange('');
    onTitleChange?.('');
  }, [onAddressChange, onCurrentUrlChange, onTitleChange, reportBrowserAction]);

  const handleClearBrowserCookies = useCallback(async () => {
    setIsBrowserMenuOpen(false);
    let success = false;
    try {
      const result = await window.electron?.artifact?.clearBrowserCookies?.();
      success = Boolean(result?.success);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: result?.success
            ? t('artifactBrowserCookiesCleared')
            : result?.error || t('artifactBrowserClearCookiesFailed'),
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserClearCookiesFailed'),
        }),
      );
    } finally {
      reportBrowserAction('browser_clear_cookies', {
        result: success ? 'success' : 'failed',
      });
    }
  }, [reportBrowserAction]);

  const handleClearBrowserCache = useCallback(async () => {
    setIsBrowserMenuOpen(false);
    let success = false;
    try {
      const result = await window.electron?.artifact?.clearBrowserCache?.();
      success = Boolean(result?.success);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: result?.success
            ? t('artifactBrowserCacheCleared')
            : result?.error || t('artifactBrowserClearCacheFailed'),
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserClearCacheFailed'),
        }),
      );
    } finally {
      reportBrowserAction('browser_clear_cache', {
        result: success ? 'success' : 'failed',
      });
    }
  }, [reportBrowserAction]);

  const setTemporaryScreenshotStatus = useCallback((status: BrowserScreenshotStatus) => {
    setScreenshotStatus(status);
    if (screenshotStatusTimeoutRef.current !== undefined) {
      window.clearTimeout(screenshotStatusTimeoutRef.current);
    }
    screenshotStatusTimeoutRef.current = window.setTimeout(() => {
      setScreenshotStatus(BrowserScreenshotStatus.Idle);
      screenshotStatusTimeoutRef.current = undefined;
    }, 1600);
  }, []);

  const handleCaptureScreenshot = useCallback(async () => {
    if (!webviewNode?.capturePage || !currentUrl || isCapturingScreenshot) return;
    setIsCapturingScreenshot(true);
    try {
      const image = await webviewNode.capturePage();
      const result = await window.electron?.clipboard?.writeImageFromDataUrl(image.toDataURL());
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to write browser screenshot to clipboard');
      }
      setTemporaryScreenshotStatus(BrowserScreenshotStatus.Copied);
      reportBrowserAction('browser_screenshot', {
        result: 'success',
      });
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserScreenshotCopied'),
        }),
      );
    } catch {
      setTemporaryScreenshotStatus(BrowserScreenshotStatus.Error);
      reportBrowserAction('browser_screenshot', {
        result: 'failed',
      });
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserScreenshotFailed'),
        }),
      );
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [currentUrl, isCapturingScreenshot, reportBrowserAction, setTemporaryScreenshotStatus, webviewNode]);

  const handleCaptureScreenshotFromMenu = useCallback(() => {
    setIsBrowserMenuOpen(false);
    void handleCaptureScreenshot();
  }, [handleCaptureScreenshot]);

  const handleToggleAnnotation = useCallback(async () => {
    if (!webviewNode?.executeJavaScript || !webviewNode.capturePage || !currentUrl) return;
    if (isAnnotating) {
      reportBrowserAction('browser_annotate_cancel');
      await webviewNode
        .executeJavaScript('window.__lobsterAnnotationCleanup?.()')
        .catch(() => undefined);
      setIsAnnotating(false);
      return;
    }
    reportBrowserAction('browser_annotate_start');
    setIsAnnotating(true);
    try {
      const labels: BrowserAnnotationLabels = {
        instruction: t('artifactBrowserAnnotationInstruction'),
        placeholder: t('artifactBrowserAnnotationPlaceholder'),
        send: t('artifactBrowserAnnotationSend'),
        tag: t('artifactBrowserAnnotationLabelTag'),
        size: t('artifactBrowserAnnotationLabelSize'),
        color: t('artifactBrowserAnnotationLabelColor'),
        font: t('artifactBrowserAnnotationLabelFont'),
        statusSent: BrowserAnnotationStatus.Sent,
        statusCancelled: BrowserAnnotationStatus.Cancelled,
      };
      const result = (await webviewNode.executeJavaScript(buildBrowserAnnotationScript(labels))) as
        | BrowserAnnotationResult
        | undefined;
      if (result?.status !== BrowserAnnotationStatus.Sent || !result.element || !result.rect) {
        reportBrowserAction('browser_annotate_end', {
          result: result?.status === BrowserAnnotationStatus.Cancelled ? 'cancelled' : 'failed',
        });
        return;
      }

      await new Promise(resolve => window.setTimeout(resolve, 80));
      const image = await webviewNode.capturePage();
      const imageDataUrl = image.toDataURL();
      const imageSize = image.getSize?.();
      const screenshot: BrowserAnnotationScreenshotInfo = {
        width: Math.round(imageSize?.width || result.viewport?.width || 0),
        height: Math.round(imageSize?.height || result.viewport?.height || 0),
        devicePixelRatio: result.viewport?.devicePixelRatio || window.devicePixelRatio || 1,
      };
      const annotation = normalizeBrowserAnnotationRect(result.rect, result.viewport, screenshot);
      onAnnotationCaptured?.({
        comment: result.comment?.trim() ?? '',
        imageDataUrl,
        pageUrl: result.pageUrl || currentUrl,
        pageTitle: result.pageTitle || '',
        screenshot,
        annotation,
        element: result.element,
      });
      reportBrowserAction('browser_annotate_send', {
        result: 'success',
        hasComment: Boolean(result.comment?.trim()),
        annotationElementTag: result.element.tagName,
      });
    } catch {
      reportBrowserAction('browser_annotate_send', {
        result: 'failed',
      });
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserScreenshotFailed'),
        }),
      );
    } finally {
      await webviewNode
        ?.executeJavaScript?.('window.__lobsterAnnotationCleanup?.()')
        .catch(() => undefined);
      setIsAnnotating(false);
    }
  }, [currentUrl, isAnnotating, onAnnotationCaptured, reportBrowserAction, webviewNode]);

  const screenshotButtonTitle =
    screenshotStatus === BrowserScreenshotStatus.Copied
      ? t('artifactBrowserScreenshotCopied')
      : screenshotStatus === BrowserScreenshotStatus.Error
        ? t('artifactBrowserScreenshotFailed')
        : t('artifactBrowserScreenshot');

  const hoveredToolbarLabel =
    hoveredToolbarAction === BrowserToolbarAction.Annotate
      ? t('artifactBrowserAnnotate')
      : hoveredToolbarAction === BrowserToolbarAction.Share
        ? shareButtonTitle
        : hoveredToolbarAction === BrowserToolbarAction.OpenExternal
          ? t('artifactBrowserOpenExternal')
          : '';
  const showAddressOpenExternal =
    Boolean(currentUrl) && (isAddressBarFocused || isAddressOpenExternalHovered);
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <button
          type="button"
          onClick={() => {
            reportBrowserAction('browser_back');
            webviewNode?.goBack?.();
          }}
          disabled={!canGoBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          title={t('artifactBrowserBack')}
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            reportBrowserAction('browser_forward');
            webviewNode?.goForward?.();
          }}
          disabled={!canGoForward}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          title={t('artifactBrowserForward')}
        >
          <ChevronRightBrowserIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            reportBrowserAction(isLoading ? 'browser_stop' : 'browser_reload');
            if (isLoading) {
              webviewNode?.stop?.();
            } else {
              webviewNode?.reload?.();
            }
          }}
          disabled={!currentUrl}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          title={isLoading ? t('artifactBrowserStop') : t('artifactBrowserReload')}
        >
          {isLoading ? <StopIcon /> : <RefreshIcon />}
        </button>
        <div
          ref={addressBarRef}
          className="relative flex min-w-0 flex-1 items-center rounded-md border border-border bg-surface px-2 pr-10 transition-colors focus-within:border-primary"
          onFocusCapture={handleAddressBarFocusCapture}
          onBlurCapture={handleAddressBarBlurCapture}
          onMouseDown={handleAddressBarMouseDown}
        >
          <input
            ref={addressInputRef}
            type="text"
            value={address}
            onChange={event => onAddressChange(event.target.value)}
            onKeyDown={handleAddressKeyDown}
            onFocus={handleAddressFocus}
            placeholder={t('artifactBrowserUrlPlaceholder')}
            className="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted"
          />
          <div
            ref={openExternalButtonRef}
            className={`absolute inset-y-0 right-0 flex w-8 items-center justify-center overflow-hidden rounded-r-[5px] transition-opacity duration-150 ${
              showAddressOpenExternal
                ? 'opacity-100'
                : 'opacity-0'
            }`}
            onMouseEnter={handleAddressOpenExternalMouseEnter}
            onMouseLeave={handleAddressOpenExternalMouseLeave}
          >
            <button
              type="button"
              onMouseDown={event => event.preventDefault()}
              onClick={handleOpenExternal}
              disabled={!currentUrl}
              tabIndex={showAddressOpenExternal ? 0 : -1}
              className="inline-flex h-full w-full items-center justify-center rounded-l-none rounded-r-[5px] border-l border-border bg-black/[0.035] text-secondary transition-colors hover:bg-black/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 dark:bg-white/[0.045] dark:hover:bg-white/[0.075]"
              aria-label={t('artifactBrowserOpenExternal')}
              title={t('artifactBrowserOpenExternal')}
            >
              <BrowserAddressOpenExternalIcon />
            </button>
          </div>
        </div>
        <div
          ref={annotateButtonRef}
          className="flex h-7 w-7 shrink-0 items-center justify-center"
          onMouseEnter={() => setHoveredToolbarAction(BrowserToolbarAction.Annotate)}
          onMouseLeave={() => setHoveredToolbarAction(null)}
        >
          <button
            type="button"
            onClick={handleToggleAnnotation}
            disabled={!currentUrl}
            className={`inline-flex h-7 w-7 items-center justify-center rounded text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              isAnnotating
                ? 'bg-primary/10 text-primary'
                : 'text-secondary hover:bg-surface hover:text-foreground'
            }`}
            aria-label={t('artifactBrowserAnnotate')}
            title={isAnnotating ? t('artifactBrowserAnnotating') : t('artifactBrowserAnnotate')}
          >
            <AnnotateIcon />
          </button>
        </div>
        {isAnnotating && (
          <button
            type="button"
            onClick={handleToggleAnnotation}
            className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/15"
            title={t('artifactBrowserAnnotating')}
          >
            {t('artifactBrowserAnnotating')}
          </button>
        )}
        <div
          ref={shareButtonRef}
          className="flex h-7 w-7 shrink-0 items-center justify-center"
          onMouseEnter={() => setHoveredToolbarAction(BrowserToolbarAction.Share)}
          onMouseLeave={() => setHoveredToolbarAction(null)}
        >
          <button
            type="button"
            onClick={() => void onShare?.()}
            disabled={!canShare || isSharing}
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              hasExistingShare
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : canShare
                ? 'text-secondary hover:bg-surface hover:text-foreground'
                : 'text-secondary'
            }`}
            aria-label={shareButtonTitle}
            title={shareButtonTitle}
          >
            <ShareIcon />
          </button>
        </div>
        <button
          ref={browserMenuButtonRef}
          type="button"
          onClick={() => setIsBrowserMenuOpen(value => {
            const nextOpen = !value;
            reportBrowserAction('browser_more_menu_toggle', {
              targetOpen: nextOpen,
            });
            return nextOpen;
          })}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors ${
            isBrowserMenuOpen
              ? 'bg-surface text-foreground'
              : 'text-secondary hover:bg-surface hover:text-foreground'
          }`}
          aria-label={t('artifactBrowserMenu')}
          title={t('artifactBrowserMenu')}
        >
          <MoreVerticalIcon />
        </button>
      </div>
      {isBrowserMenuOpen && (
        <div
          ref={browserMenuRef}
          className="absolute right-3 top-10 z-40 w-56 rounded-lg border border-border bg-surface-raised p-2 text-sm text-foreground shadow-xl"
        >
          <button
            type="button"
            onClick={handleCaptureScreenshotFromMenu}
            disabled={!currentUrl || isCapturingScreenshot}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35"
          >
            {screenshotButtonTitle}
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleOpenBlankPage}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
          >
            {t('artifactBrowserBlankPage')}
          </button>
          <button
            type="button"
            onClick={handleToggleDeviceToolbar}
            className={`flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface ${
              isDeviceToolbarVisible ? 'bg-surface text-foreground' : ''
            }`}
          >
            {isDeviceToolbarVisible
              ? t('artifactBrowserHideDeviceToolbar')
              : t('artifactBrowserShowDeviceToolbar')}
          </button>
          <div className="my-1 border-t border-border" />
          <div className="flex h-9 items-center gap-2 px-2">
            <span className="min-w-0 flex-1 text-xs text-secondary">
              {t('artifactBrowserZoom')}
            </span>
            <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-background">
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={browserZoomFactor <= BrowserZoom.Min}
                className="inline-flex h-full w-7 items-center justify-center text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                title={t('artifactBrowserZoomOut')}
              >
                <MinusIcon />
              </button>
              <button
                type="button"
                onClick={handleResetZoom}
                className="h-full min-w-[54px] border-x border-border px-2 text-center text-xs text-foreground transition-colors hover:bg-surface"
                title={t('artifactBrowserResetZoom')}
              >
                {Math.round(browserZoomFactor * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={browserZoomFactor >= BrowserZoom.Max}
                className="inline-flex h-full w-7 items-center justify-center text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                title={t('artifactBrowserZoomIn')}
              >
                <PlusIcon />
              </button>
            </div>
          </div>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleClearBrowserCookies}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
          >
            {t('artifactBrowserClearCookies')}
          </button>
          <button
            type="button"
            onClick={handleClearBrowserCache}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
          >
            {t('artifactBrowserClearCache')}
          </button>
        </div>
      )}
      {hoveredToolbarLabel &&
        toolbarTooltipPosition &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11px] leading-none text-background shadow-sm"
            style={{
              left: toolbarTooltipPosition.left,
              top: toolbarTooltipPosition.top,
              transform:
                toolbarTooltipPosition.placement === 'top'
                  ? 'translate(-50%, -100%)'
                  : 'translate(-50%, 0)',
            }}
          >
            {hoveredToolbarLabel}
          </div>,
          document.body,
        )}
      {currentUrl ? (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {isDeviceToolbarVisible && (
            <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-background px-2 text-xs text-secondary">
              <span className="shrink-0 text-foreground">{t('artifactBrowserDeviceSize')}</span>
              <select
                value={devicePresetId}
                onChange={event => handleDevicePresetChange(event.target.value)}
                className="h-7 w-[176px] rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-primary"
                title={t('artifactBrowserDevicePreset')}
              >
                {BROWSER_DEVICE_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {getBrowserDevicePresetLabel(preset)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={BrowserDeviceViewport.MinSize}
                max={BrowserDeviceViewport.MaxSize}
                value={deviceWidth}
                onChange={event => handleDeviceWidthChange(event.target.value)}
                className="h-7 w-[72px] rounded-md border border-border bg-surface px-2 text-center text-xs text-foreground outline-none focus:border-primary"
                aria-label={t('artifactBrowserDeviceWidth')}
                title={t('artifactBrowserDeviceWidth')}
              />
              <span className="text-muted">x</span>
              <input
                type="number"
                min={BrowserDeviceViewport.MinSize}
                max={BrowserDeviceViewport.MaxSize}
                value={deviceHeight}
                onChange={event => handleDeviceHeightChange(event.target.value)}
                className="h-7 w-[72px] rounded-md border border-border bg-surface px-2 text-center text-xs text-foreground outline-none focus:border-primary"
                aria-label={t('artifactBrowserDeviceHeight')}
                title={t('artifactBrowserDeviceHeight')}
              />
              <button
                type="button"
                onClick={handleRotateDevice}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground"
                title={t('artifactBrowserDeviceRotate')}
              >
                <RotateDeviceIcon />
              </button>
              <select
                value={deviceScale}
                onChange={event => handleDeviceScaleChange(event.target.value)}
                className="h-7 w-[82px] rounded-md border border-border bg-transparent px-2 text-xs text-secondary outline-none hover:bg-surface hover:text-foreground focus:border-primary"
                title={t('artifactBrowserDeviceScale')}
              >
                {BROWSER_DEVICE_SCALE_OPTIONS.map(scale => (
                  <option key={scale} value={scale}>
                    {Math.round(scale * 100)}%
                  </option>
                ))}
              </select>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                onClick={() => setIsDeviceToolbarVisible(false)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground"
                title={t('artifactBrowserHideDeviceToolbar')}
              >
                <CloseIcon />
              </button>
            </div>
          )}
          <div
            className={`min-h-0 flex-1 overflow-auto ${isDeviceToolbarVisible ? 'bg-surface px-5 py-4' : 'bg-white'}`}
          >
            <div
              className={
                isDeviceToolbarVisible ? 'mx-auto overflow-hidden shadow-sm' : 'h-full w-full'
              }
              style={
                isDeviceToolbarVisible
                  ? {
                      width: deviceWidth * deviceScale,
                      height: deviceHeight * deviceScale,
                    }
                  : undefined
              }
            >
              <div
                className="h-full w-full origin-top-left bg-white"
                style={
                  isDeviceToolbarVisible
                    ? {
                        width: deviceWidth,
                        height: deviceHeight,
                        transform: `scale(${deviceScale})`,
                      }
                    : undefined
                }
              >
                {React.createElement('webview', {
                  ref: handleWebviewRef,
                  src: BrowserPageUrl.Blank,
                  partition: ArtifactBrowserPartition.Default,
                  className: 'h-full w-full bg-white',
                  allowpopups: 'false',
                })}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center overflow-auto px-6 py-10">
          <div className="w-full max-w-[420px]">
            <div className="mb-3 flex items-center justify-between px-1">
              <div className="text-xs text-muted">{t('artifactBrowserLocalServices')}</div>
              <button
                type="button"
                onClick={loadLocalServices}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title={t('artifactBrowserLocalServicesRefresh')}
                disabled={isLoadingLocalServices}
              >
                <RefreshIcon />
              </button>
            </div>
            {localServices.length > 0 ? (
              <div className="space-y-2">
                {localServices.map(service => (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() => handleOpenLocalService(service)}
                    className="group flex w-full items-center gap-3 rounded-lg border border-border bg-background p-2 text-left transition-colors hover:border-primary/35 hover:bg-surface"
                  >
                    <div className="flex h-[52px] w-[84px] shrink-0 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm">
                      <div className="flex h-3 items-center gap-1 border-b border-border px-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-red-400/70" />
                        <span className="h-1.5 w-1.5 rounded-full bg-yellow-400/70" />
                        <span className="h-1.5 w-1.5 rounded-full bg-green-400/70" />
                      </div>
                      <div className="flex flex-1 items-center px-2 text-[8px] leading-tight text-muted">
                        <span className="line-clamp-2">{service.title}</span>
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {service.title}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {service.host}:{service.port}
                      </div>
                    </div>
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${service.online ? 'bg-emerald-400' : 'bg-muted'}`}
                      title={service.online ? t('artifactBrowserLocalServiceOnline') : undefined}
                    />
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
                {isLoadingLocalServices
                  ? t('artifactBrowserLocalServicesLoading')
                  : t('artifactBrowserLocalServicesEmpty')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const FolderIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 4.5A1.5 1.5 0 013.5 3h2.879a1.5 1.5 0 011.06.44l.622.62a1.5 1.5 0 001.06.44H12.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" />
  </svg>
);

const BrowserIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="8" cy="8" r="6" />
    <ellipse cx="8" cy="8" rx="2.5" ry="6" />
    <path d="M2 8h12" />
  </svg>
);

const AnnotateIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8 2.25c3.35 0 6 2.2 6 5.05 0 2.84-2.65 5.05-6 5.05-.7 0-1.36-.1-1.98-.29L3.55 13.5c-.46.27-.96-.23-.69-.69l1.06-1.82C2.74 10.08 2 8.79 2 7.3c0-2.85 2.65-5.05 6-5.05z" />
    <path d="M8 5.75v3.5M6.25 7.5h3.5" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 3L5 8l5 5" />
  </svg>
);

const ChevronRightBrowserIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 3l5 5-5 5" />
  </svg>
);

const StopIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.25 4.25h7.5v7.5h-7.5z" />
  </svg>
);

const OpenExternalIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 9v3.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 012 12.5v-7A1.5 1.5 0 013.5 4H7" />
    <path d="M10 2h4v4" />
    <path d="M7 9l7-7" />
  </svg>
);

const BrowserAddressOpenExternalIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.75 11.25l6.5-6.5" />
    <path d="M7.75 4.75h3.5v3.5" />
  </svg>
);

const ShareIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="4" cy="8" r="1.8" />
    <circle cx="11.5" cy="4" r="1.8" />
    <circle cx="11.5" cy="12" r="1.8" />
    <path d="M5.6 7.15l4.3-2.3" />
    <path d="M5.6 8.85l4.3 2.3" />
  </svg>
);

const MoreHorizontalToolbarIcon = () => (
  <svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor" aria-hidden="true">
    <circle cx="4" cy="8.6" r="1.15" />
    <circle cx="8" cy="8.6" r="1.15" />
    <circle cx="12" cy="8.6" r="1.15" />
  </svg>
);

const ContentViewIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 3.5h11" />
    <path d="M2.5 8h11" />
    <path d="M2.5 12.5h6" />
  </svg>
);

const FileListIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.5 2.881c0-.644.522-1.167 1.167-1.167h2.552c.323 0 .635.117.878.33l.58.507c.243.213.555.33.877.33h3.351c.736 0 1.333.597 1.333 1.333v5.945c0 .49-.398.889-.889.889" />
    <path d="M1.143 6.476c0-.736.597-1.333 1.333-1.333h2.314c.323 0 .635.117.878.33l.58.507c.242.213.554.33.877.33h3.351c.736 0 1.333.597 1.333 1.334v4.833c0 .736-.597 1.333-1.333 1.333H2.476c-.736 0-1.333-.597-1.333-1.333V6.476z" />
  </svg>
);

const RefreshIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13.5 8a5.5 5.5 0 01-9.55 3.75" />
    <path d="M2.5 8a5.5 5.5 0 019.55-3.75" />
    <path d="M12.05 1.25v3h-3" />
    <path d="M3.95 14.75v-3h3" />
  </svg>
);

const MoreVerticalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="3.5" r="1.1" />
    <circle cx="8" cy="8" r="1.1" />
    <circle cx="8" cy="12.5" r="1.1" />
  </svg>
);

const MinusIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 8h8" />
  </svg>
);

const PlusIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M8 4v8" />
    <path d="M4 8h8" />
  </svg>
);

const RotateDeviceIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5.5 2.5h5A1.5 1.5 0 0112 4v8a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 014 12V4a1.5 1.5 0 011.5-1.5z" />
    <path d="M7 4h2" />
    <path d="M7.5 12h1" />
    <path d="M14 8a6 6 0 01-1.76 4.24" />
    <path d="M13.5 9.9L12.24 12.24 9.9 11" />
  </svg>
);

const CloseIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4.5 4.5l7 7" />
    <path d="M11.5 4.5l-7 7" />
  </svg>
);

export default ArtifactPanel;
