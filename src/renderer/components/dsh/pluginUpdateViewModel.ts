// Pure presentation and state helpers for third-party DSH plugin version checks
// and HMR updates. Kept React- and DOM-free so Vitest can verify every rule under Node.

import {
  DshPluginApplicationStatus,
  DshPluginUpdateKind,
  DshPluginUpdateOutcomeKind,
  DshPluginUpdateStep,
} from '../../../shared/dshEngine/hostConstants';
import type {
  DshPluginEntry,
  DshPluginIncompatibleInfo,
  DshPluginUpdateOutcome,
  DshPluginVersionInfo,
  DshPluginVersionList,
} from '../../services/dshHost';

export type PluginVersionCheckState =
  | { readonly phase: 'checking' }
  | { readonly phase: 'done'; readonly checkedAt: number; readonly list: DshPluginVersionList };

export const PluginUpdateStepVisualState = {
  Running: 'running',
  Done: 'done',
  Failed: 'failed',
  Unknown: 'unknown',
} as const;
export type PluginUpdateStepVisualState =
  typeof PluginUpdateStepVisualState[keyof typeof PluginUpdateStepVisualState];

export const BatchUpdateCheckSummaryTone = {
  Info: 'info',
  Success: 'success',
  Error: 'error',
} as const;
export type BatchUpdateCheckSummaryTone =
  typeof BatchUpdateCheckSummaryTone[keyof typeof BatchUpdateCheckSummaryTone];

export interface BatchUpdateCheckSummary {
  text: string;
  tone: BatchUpdateCheckSummaryTone;
}

export const UPDATE_STEP_ORDER: readonly DshPluginUpdateStep[] = [
  DshPluginUpdateStep.Checking,
  DshPluginUpdateStep.Removing,
  DshPluginUpdateStep.Installing,
  DshPluginUpdateStep.Restoring,
];

/**
 * Third-party npm Registry plugins managed by the user profile.
 * Built-in managed bundles and DSH official packages update alongside LobsterAI releases.
 */
export function isRegistryUpdatablePlugin(plugin: DshPluginEntry): boolean {
  return !plugin.managed && !plugin.official && plugin.update === DshPluginUpdateKind.Registry;
}

export function isPluginVersionInstallable(version: DshPluginVersionInfo): boolean {
  return version.bundle && version.incompatible === undefined;
}

/**
 * Selects the newest published version that declares a DSH bundle, matches the
 * running DSH runtime, and is neither deprecated nor a prerelease.
 */
export function pickRecommendedPluginUpdate(
  list: DshPluginVersionList | undefined,
): DshPluginVersionInfo | undefined {
  if (!list || list.status !== 'listed') return undefined;
  return list.versions.find(
    (version) =>
      isPluginVersionInstallable(version)
      && version.deprecated === undefined
      && !version.prerelease,
  );
}

export function getPluginRecommendedVersion(
  check: PluginVersionCheckState | undefined,
): string | undefined {
  if (check?.phase !== 'done') return undefined;
  return pickRecommendedPluginUpdate(check.list)?.version;
}

export function getPluginVersionCheckRegistry(
  check: PluginVersionCheckState | undefined,
): string | null | undefined {
  if (check?.phase !== 'done' || check.list.status !== 'listed') return undefined;
  return check.list.registry;
}

/**
 * Removes version-check entries that no longer describe a currently installed
 * third-party Registry plugin (e.g. removed, upgraded externally via CLI or DSH Web).
 */
export function dropStaleVersionChecks(
  plugins: readonly DshPluginEntry[],
  checks: Readonly<Record<string, PluginVersionCheckState>>,
): Record<string, PluginVersionCheckState> {
  const byName = new Map<string, DshPluginEntry>();
  for (const plugin of plugins) {
    byName.set(plugin.name, plugin);
  }
  const next: Record<string, PluginVersionCheckState> = {};
  for (const [name, check] of Object.entries(checks)) {
    const plugin = byName.get(name);
    if (!plugin || !isRegistryUpdatablePlugin(plugin)) continue;
    if (
      check.phase === 'checking'
      || check.list.status !== 'listed'
      || check.list.installed === plugin.version
    ) {
      next[name] = check;
    }
  }
  return next;
}

export function summarizeBatchUpdateCheck(
  plugins: readonly DshPluginEntry[],
  checks: Readonly<Record<string, PluginVersionCheckState>>,
  t: (key: string) => string,
): BatchUpdateCheckSummary | null {
  const targets = plugins.filter(isRegistryUpdatablePlugin);
  if (targets.length === 0) return null;
  const resolved = targets.map((plugin) => checks[plugin.name]);
  if (resolved.some((check) => !check || check.phase === 'checking')) return null;

  let availableCount = 0;
  let failedCount = 0;
  for (const check of resolved) {
    if (!check || check.phase !== 'done') continue;
    if (check.list.status === 'refused') {
      failedCount += 1;
    } else if (pickRecommendedPluginUpdate(check.list)) {
      availableCount += 1;
    }
  }

  if (availableCount > 0) {
    return {
      text: t('dshPluginsUpdatesAvailableCount').replace('{count}', String(availableCount)),
      tone: BatchUpdateCheckSummaryTone.Info,
    };
  }
  if (failedCount > 0) {
    return {
      text: t('dshPluginsUpdatesCheckFailedSummary'),
      tone: BatchUpdateCheckSummaryTone.Error,
    };
  }
  return {
    text: t('dshPluginsUpdatesAllLatest'),
    tone: BatchUpdateCheckSummaryTone.Success,
  };
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatPluginPublishedDate(publishedAt: string | undefined): string | null {
  if (!publishedAt) return null;
  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${padTwo(parsed.getMonth() + 1)}-${padTwo(parsed.getDate())}`;
}

export function formatPluginCheckedTime(checkedAt: number): string {
  const date = new Date(checkedAt);
  if (Number.isNaN(date.getTime())) return '';
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

export function formatIncompatibleRequirements(incompatible: DshPluginIncompatibleInfo): string {
  return Object.entries(incompatible.requirements)
    .map(([key, range]) => `${key} ${range}`)
    .join(', ');
}

/**
 * Joins Host-announced progress steps with the steps implied by the settled
 * update outcome so a dropped progress frame never hides a step that ran.
 */
export function mergeSettledUpdateSteps(
  announced: readonly DshPluginUpdateStep[],
  outcome: DshPluginUpdateOutcome | null,
): DshPluginUpdateStep[] {
  if (!outcome) return [...announced];
  const implied = new Set<DshPluginUpdateStep>([DshPluginUpdateStep.Checking, ...announced]);
  if (outcome.step === 'remove') {
    implied.add(DshPluginUpdateStep.Removing);
  }
  if (outcome.step === 'install') {
    implied.add(DshPluginUpdateStep.Installing);
  }
  if (outcome.restored !== undefined) {
    implied.add(DshPluginUpdateStep.Removing);
    implied.add(DshPluginUpdateStep.Restoring);
  }
  return UPDATE_STEP_ORDER.filter((step) => implied.has(step));
}

function isFailedStatus(application: DshPluginApplicationStatus | undefined): boolean {
  return (
    application === DshPluginApplicationStatus.Failed
    || application === DshPluginApplicationStatus.Cancelled
  );
}

export function resolveUpdateStepVisualState(
  step: DshPluginUpdateStep,
  isRunning: boolean,
  isLast: boolean,
  outcome: DshPluginUpdateOutcome | null,
): PluginUpdateStepVisualState {
  if (isRunning) {
    return isLast ? PluginUpdateStepVisualState.Running : PluginUpdateStepVisualState.Done;
  }
  if (!outcome || outcome.outcome === DshPluginUpdateOutcomeKind.TransportLost) {
    return isLast ? PluginUpdateStepVisualState.Unknown : PluginUpdateStepVisualState.Done;
  }
  switch (step) {
    case DshPluginUpdateStep.Checking:
      return outcome.step === 'check'
        ? PluginUpdateStepVisualState.Failed
        : PluginUpdateStepVisualState.Done;
    case DshPluginUpdateStep.Removing:
      return outcome.step === 'remove'
        ? PluginUpdateStepVisualState.Failed
        : PluginUpdateStepVisualState.Done;
    case DshPluginUpdateStep.Installing:
      return !outcome.ok || isFailedStatus(outcome.application)
        ? PluginUpdateStepVisualState.Failed
        : PluginUpdateStepVisualState.Done;
    case DshPluginUpdateStep.Restoring:
      return outcome.restored === false || isFailedStatus(outcome.restoreApplication)
        ? PluginUpdateStepVisualState.Failed
        : PluginUpdateStepVisualState.Done;
  }
}

export function resolveUpdateRestartReasonText(
  reason: string | undefined,
  t: (key: string) => string,
): string {
  switch (reason) {
    case 'no-hmr':
      return t('dshPluginsRestartReasonNoHmr');
    case 'package-moved':
      return t('dshPluginsRestartReasonPackageMoved');
    case 'host-module':
      return t('dshPluginsRestartReasonHostModule');
    case 'unmanaged-plugin':
      return t('dshPluginsRestartReasonUnmanagedPlugin');
    case 'module-comparison':
      return t('dshPluginsRestartReasonModuleComparison');
    default:
      return t('dshPluginsRestartRequiredBanner');
  }
}

export function resolveUpdateFailureDetail(
  outcome: DshPluginUpdateOutcome,
  t: (key: string) => string,
): string {
  if (outcome.errorCode === 'incompatible-version') {
    const first = outcome.incompatible?.[0];
    if (first) {
      return t('dshPluginsUpdateIncompatibleDetail')
        .replace('{peers}', formatIncompatibleRequirements(first))
        .replace('{runtime}', first.runtimeVersion);
    }
    return t('dshPluginsErrorIncompatible');
  }
  if (outcome.errorCode === 'not-bundle') {
    return t('dshPluginsProblemNotBundle');
  }
  if (outcome.errorCode === 'unsupported-platform') {
    return t('dshPluginsErrorUnsupportedPlatform');
  }
  if (outcome.errorCode === 'bundle-in-use') {
    return t('dshPluginsUpdateErrorBundleInUse');
  }
  if (outcome.pendingBuilds && outcome.pendingBuilds.length > 0) {
    return t('dshPluginsUpdateBuildBlockedDetail').replace(
      '{packages}',
      outcome.pendingBuilds.join(', '),
    );
  }
  if (outcome.failureKind === 'network' || outcome.failureKind === 'timeout') {
    return t('dshPluginsProblemNetwork');
  }
  if (outcome.failureKind === 'not-found' || outcome.failureKind === 'no-matching-version') {
    return t('dshPluginsProblemNotFound');
  }
  if (outcome.failureKind === 'build-blocked') {
    return t('dshPluginsBuildBlockedTitle');
  }
  return outcome.error || t('dshPluginsUpdateGenericFailed');
}

export function resolveRegistryAttemptProblemText(
  problem: 'not-found' | 'network' | 'unknown' | undefined,
  t: (key: string) => string,
): string {
  switch (problem) {
    case 'network':
      return t('dshPluginsVersionsProblemNetwork');
    case 'not-found':
      return t('dshPluginsVersionsProblemNotFound');
    default:
      return t('dshPluginsVersionsProblemUnknown');
  }
}
