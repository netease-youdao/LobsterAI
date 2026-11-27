// Pure state, registry-plan, terminal-log, and error-recovery helpers for the
// DSH plugin installation dialog. Kept React- and DOM-free so Vitest can verify
// every behavior under Node.

import type {
  DshPluginInspectResult,
  DshPluginInstallLogChunk,
  DshPluginMutationResult,
  DshPluginRegistriesResult,
  PersistedInstallRegistryChoice,
} from '../../services/dshHost';
import {
  formatIncompatibleRequirements,
  resolveUpdateRestartReasonText,
} from './pluginUpdateViewModel';
import {
  NPMMIRROR_REGISTRY,
  OFFICIAL_NPM_REGISTRY,
} from './pluginViewModel';

export type InstallRegistryChoice = PersistedInstallRegistryChoice;

export const OFFICIAL_NPM_HOST = 'registry.npmjs.org';
export const NPMMIRROR_HOST = 'registry.npmmirror.com';
export const INSTALL_EXAMPLE_PACKAGE = 'dsh-plugin-whale-pet';
export const INSTALL_GIT_TEMPLATE = 'https://github.com/author/dsh-plugin';
export const INSTALL_PATH_TEMPLATE = '/Users/name/my-plugin';
export const INSTALL_TERMINAL_MAX_LINES = 12;

export const InstallModalPhase = {
  Idle: 'idle',
  Checking: 'checking',
  Preview: 'preview',
  Starting: 'starting',
  Running: 'running',
  Cancelling: 'cancelling',
  Applying: 'applying',
  Done: 'done',
  Failed: 'failed',
} as const;
export type InstallModalPhase = typeof InstallModalPhase[keyof typeof InstallModalPhase];

export interface PluginInstallRun {
  readonly jobId: string;
  readonly command: string;
  readonly cwd: string;
  readonly output: string;
  readonly exitCode?: number | null;
}

export interface RegistryDisplayInfo {
  readonly name: string;
  readonly host: string;
}

export interface GithubMirrorRecoveryInfo {
  readonly applicable: boolean;
  readonly mirrorRegistry: string | null;
  readonly alreadyUsingMirror: boolean;
  readonly isTimeout: boolean;
}

export interface MinimumReleaseAgeNotice {
  readonly installed: string;
  readonly latest: string;
  readonly exactSpec: string;
}

export interface FoldedTerminalLines {
  readonly head: string[];
  readonly tail: string[];
  readonly hiddenCount: number;
  readonly totalLines: number;
}

export function isInstallPendingPhase(phase: InstallModalPhase): boolean {
  return (
    phase === InstallModalPhase.Starting
    || phase === InstallModalPhase.Running
    || phase === InstallModalPhase.Cancelling
    || phase === InstallModalPhase.Applying
  );
}

/**
 * Normalizes an http(s) registry URL into pnpm's comparison form:
 * lowercase host + trailing slash, rejecting credentials, whitespace, and
 * control characters.
 */
export function normalizeRegistryUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.pathname.endsWith('/')) {
      parsed.pathname += '/';
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function isValidCustomRegistryUrl(raw: string): boolean {
  return normalizeRegistryUrl(raw) !== null;
}

export function getRegistryComparisonKey(
  registry: string | null,
  resolved: string | null | undefined,
): string {
  const url = registry ?? resolved ?? null;
  if (!url) return '';
  return normalizeRegistryUrl(url) ?? url.trim();
}

/**
 * Returns the deduplicated registries offered by the dialog, in order:
 * the Host's configured first registry, its fallbacks, and pnpm's own config (`null`).
 */
export function buildOfferedRegistries(
  registries: DshPluginRegistriesResult | null,
): Array<string | null> {
  const candidates: Array<string | null> = registries
    ? [
        registries.registry ?? null,
        ...(registries.fallbackRegistries ?? []),
        null,
      ]
    : [null];
  const resolved = registries?.resolved ?? null;
  const offered: Array<string | null> = [];
  const seenKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = getRegistryComparisonKey(candidate, resolved);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    offered.push(candidate);
  }
  return offered;
}

/**
 * Resolves the initial registry choice for a newly opened dialog:
 * - Preserves and reconciles a remembered user choice against current offered registries.
 * - When no choice is remembered and pnpm's resolved registry is unconfigured official npm,
 *   automatically promotes the probed fastest public mirror (e.g. npmmirror in China).
 */
export function resolveInitialRegistryChoice(
  remembered: InstallRegistryChoice | null,
  registries: DshPluginRegistriesResult | null,
): InstallRegistryChoice {
  if (!registries) {
    return remembered ?? { kind: 'offered', registry: null };
  }
  const resolved = registries.resolved ?? null;
  if (remembered) {
    if (remembered.kind === 'custom' || remembered.registry === null) {
      return remembered;
    }
    const key = getRegistryComparisonKey(remembered.registry, resolved);
    const matching = buildOfferedRegistries(registries).find(
      (candidate) => getRegistryComparisonKey(candidate, resolved) === key,
    );
    return matching !== undefined
      ? { kind: 'offered', registry: matching }
      : { kind: 'custom', url: remembered.registry };
  }

  const configuredFirst = registries.registry ?? null;
  const normalizedResolved = resolved ? normalizeRegistryUrl(resolved) : null;
  const normalizedFastest = registries.fastest ? normalizeRegistryUrl(registries.fastest) : null;
  if (
    configuredFirst === null
    && normalizedResolved === OFFICIAL_NPM_REGISTRY
    && normalizedFastest === NPMMIRROR_REGISTRY
  ) {
    const mirror = (registries.fallbackRegistries ?? []).find(
      (item) => normalizeRegistryUrl(item) === NPMMIRROR_REGISTRY,
    );
    if (mirror) {
      return { kind: 'offered', registry: mirror };
    }
  }
  return { kind: 'offered', registry: configuredFirst };
}

export function resolveRegistryValueForRpc(choice: InstallRegistryChoice): string | null {
  return choice.kind === 'custom' ? choice.url.trim() : choice.registry;
}

function extractRegistryHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

export function getRegistryDisplayInfo(
  registry: string | null,
  resolved: string | null | undefined,
  t: (key: string) => string,
): RegistryDisplayInfo {
  const url = registry ?? resolved ?? null;
  if (!url) {
    return {
      name: t('dshPluginsRegistryDefault'),
      host: OFFICIAL_NPM_HOST,
    };
  }
  const host = extractRegistryHost(url);
  if (host === OFFICIAL_NPM_HOST) {
    return {
      name: t('dshPluginsRegistryOfficial'),
      host,
    };
  }
  if (host === NPMMIRROR_HOST) {
    return {
      name: t('dshPluginsRegistryNpmMirror'),
      host,
    };
  }
  return { name: host, host };
}

export function formatRegistryNameList(
  registries: ReadonlyArray<string | null>,
  resolved: string | null | undefined,
  t: (key: string) => string,
): string {
  return registries
    .map((registry) => getRegistryDisplayInfo(registry, resolved, t).name)
    .join(t('dshPluginsRegistryListSeparator'));
}

/**
 * Strips ANSI escape sequences (CSI/OSC) and collapses carriage-return progress
 * overwrites so streamed pnpm terminal logs stay crisp in plain monospace views.
 */
export function stripAnsiCodes(text: string): string {
  if (!text) return '';
  const withoutAnsi = text.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, '');
  const normalizedNewlines = withoutAnsi.replace(/\r\n/g, '\n');
  return normalizedNewlines
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r');
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i].length > 0) return parts[i];
      }
      return '';
    })
    .join('\n');
}

export function foldTerminalLines(
  rawOutput: string,
  maxLines: number = INSTALL_TERMINAL_MAX_LINES,
): FoldedTerminalLines {
  const clean = stripAnsiCodes(rawOutput);
  if (!clean.trim()) {
    return { head: [], tail: [], hiddenCount: 0, totalLines: 0 };
  }
  const lines = clean.replace(/\n$/, '').split('\n');
  const safeMax = Math.max(2, Math.floor(maxLines));
  if (lines.length <= safeMax) {
    return { head: lines, tail: [], hiddenCount: 0, totalLines: lines.length };
  }
  const headCount = Math.floor(safeMax / 2);
  const tailCount = safeMax - headCount;
  return {
    head: lines.slice(0, headCount),
    tail: lines.slice(lines.length - tailCount),
    hiddenCount: lines.length - safeMax,
    totalLines: lines.length,
  };
}

export function appendInstallLogChunk(
  runs: readonly PluginInstallRun[],
  chunk: DshPluginInstallLogChunk,
  settled: boolean,
): PluginInstallRun[] {
  const existingIndex = runs.findIndex((run) => run.jobId === chunk.jobId);
  const exitPatch = chunk.exitCode === undefined ? {} : { exitCode: chunk.exitCode };
  if (existingIndex === -1) {
    return [
      ...runs,
      {
        jobId: chunk.jobId,
        command: chunk.argv.join(' '),
        cwd: chunk.cwd,
        output: chunk.text,
        ...(settled && chunk.exitCode === undefined ? { exitCode: null } : exitPatch),
      },
    ];
  }
  return runs.map((run, idx) =>
    idx === existingIndex
      ? {
          ...run,
          output: run.output + chunk.text,
          ...exitPatch,
        }
      : run,
  );
}

export function settleInstallRuns(
  runs: readonly PluginInstallRun[],
  exitCode: number | null,
): PluginInstallRun[] {
  return runs.map((run) => (run.exitCode === undefined ? { ...run, exitCode } : run));
}

export function resolveInstallInputProblem(
  result: DshPluginInspectResult,
  resolvedRegistry: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!result.ok) {
    return result.error || t('dshPluginsInspectFailed');
  }
  const asked = result.registries ?? [];
  if (result.problem === 'network' && asked.length > 1) {
    return t('dshPluginsProblemNetworkAll').replace(
      '{registries}',
      formatRegistryNameList(asked, resolvedRegistry, t),
    );
  }
  const reason = result.reason?.trim() ?? '';
  switch (result.problem) {
    case 'already-installed':
      return t('dshPluginsProblemAlreadyInstalled');
    case 'not-found':
      return t('dshPluginsProblemNotFound');
    case 'not-a-bundle':
      return reason
        ? t('dshPluginsProblemNotBundleReason').replace('{reason}', reason)
        : t('dshPluginsProblemNotBundle');
    case 'not-a-package':
      return t('dshPluginsProblemNotPackage');
    case 'invalid-spec':
      return reason
        ? t('dshPluginsProblemInvalidSpecReason').replace('{reason}', reason)
        : t('dshPluginsProblemInvalidSpec');
    case 'network':
      return t('dshPluginsProblemNetwork');
    default:
      return reason
        ? t('dshPluginsProblemUnknownReason').replace('{reason}', reason)
        : t('dshPluginsInspectFailed');
  }
}

function resolveFailureKindText(
  kind: string | undefined,
  t: (key: string) => string,
): string | null {
  switch (kind) {
    case 'pnpm-missing':
      return t('dshPluginsInstallFailurePnpmMissing');
    case 'timeout':
      return t('dshPluginsInstallFailureTimeout');
    case 'not-found':
      return t('dshPluginsProblemNotFound');
    case 'no-matching-version':
      return t('dshPluginsInstallFailureNoMatchingVersion');
    case 'network':
      return t('dshPluginsInstallFailureNetwork');
    case 'disk-full':
      return t('dshPluginsInstallFailureDiskFull');
    case 'permission':
      return t('dshPluginsInstallFailurePermission');
    case 'build-blocked':
      return t('dshPluginsInstallFailureBuildBlocked');
    case 'integrity':
      return t('dshPluginsInstallFailureIntegrity');
    case 'unknown':
      return t('dshPluginsInstallFailureGeneric');
    default:
      return null;
  }
}

function resolveManagementErrorCodeText(
  code: string | undefined,
  t: (key: string) => string,
): string | null {
  switch (code) {
    case 'already-installed':
      return t('dshPluginsProblemAlreadyInstalled');
    case 'not-bundle':
      return t('dshPluginsProblemNotBundle');
    case 'invalid-spec':
      return t('dshPluginsProblemInvalidSpec');
    case 'unsupported-platform':
      return t('dshPluginsErrorUnsupportedPlatform');
    case 'ambiguous-install':
      return t('dshPluginsReasonAmbiguousInstall');
    case 'stale-approval':
      return t('dshPluginsReasonStaleApproval');
    case 'unexpected-package':
      return t('dshPluginsReasonUnexpectedPackage');
    default:
      return null;
  }
}

export function resolveInstallFailureText(
  failure: DshPluginMutationResult | null,
  context: {
    subjectHost?: string;
    attemptedRegistries?: ReadonlyArray<string | null>;
    resolvedRegistry?: string | null;
  },
  t: (key: string) => string,
): string {
  if (!failure) return t('dshPluginsInstallFailureGeneric');

  if (failure.errorCode === 'incompatible-version') {
    const named = failure.incompatible ?? [];
    if (named.length === 0) {
      return t('dshPluginsErrorIncompatible');
    }
    const separator = t('dshPluginsSentenceSeparator');
    const sentences = named.map((plugin) =>
      t('dshPluginsInstallIncompatibleDetail')
        .replace('{plugin}', `${plugin.name}@${plugin.version}`)
        .replace('{runtime}', plugin.runtimeVersion)
        .replace('{requirements}', formatIncompatibleRequirements(plugin)),
    );
    return [...sentences, t('dshPluginsInstallIncompatibleHint')].join(separator);
  }

  if (failure.failureKind === 'build-blocked' && (!failure.pendingBuilds || failure.pendingBuilds.length === 0)) {
    return t('dshPluginsInstallFailureBuildBlockedManual');
  }

  if (failure.failedAt === 'spec-host' && context.subjectHost) {
    return t('dshPluginsInstallFailureNetworkHost').replace('{host}', context.subjectHost);
  }

  const asked = context.attemptedRegistries ?? failure.registries ?? [];
  if (
    failure.failedAt === 'registry'
    && (failure.failureKind === 'network' || failure.failureKind === 'timeout')
    && asked.length > 1
  ) {
    return t('dshPluginsInstallFailureNetworkAll').replace(
      '{registries}',
      formatRegistryNameList(asked, context.resolvedRegistry, t),
    );
  }

  const kindText = resolveFailureKindText(failure.failureKind, t);
  if (kindText) return kindText;

  const codeText = resolveManagementErrorCodeText(failure.errorCode, t);
  if (codeText) return codeText;

  if (failure.stage === 'enable' && failure.enabled === true) {
    return t('dshPluginsInstallFailedEnabling');
  }

  if (failure.error?.trim()) return failure.error.trim();
  return t('dshPluginsInstallFailureGeneric');
}

function isGithubHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase().split(':')[0];
  return normalized === 'github.com' || normalized.endsWith('.github.com');
}

/**
 * Determines whether a failed GitHub spec installation should offer the
 * one-click switch to the mainland China npmmirror registry.
 */
export function resolveGithubMirrorRecovery(options: {
  failure: DshPluginMutationResult | null;
  subjectHost?: string;
  registries: DshPluginRegistriesResult | null;
  currentChoice: InstallRegistryChoice;
}): GithubMirrorRecoveryInfo {
  const { failure, subjectHost, registries, currentChoice } = options;
  const noRecovery: GithubMirrorRecoveryInfo = {
    applicable: false,
    mirrorRegistry: null,
    alreadyUsingMirror: false,
    isTimeout: false,
  };
  if (!failure || failure.ok) return noRecovery;
  if (failure.failedAt !== 'spec-host') return noRecovery;
  if (failure.failureKind !== 'network' && failure.failureKind !== 'timeout') return noRecovery;
  if (!isGithubHost(subjectHost)) return noRecovery;

  const resolved = registries?.resolved ?? null;
  const offered = buildOfferedRegistries(registries);
  const mirrorEntry = offered.find(
    (entry) => getRegistryComparisonKey(entry, resolved) === NPMMIRROR_REGISTRY,
  );
  if (mirrorEntry === undefined) return noRecovery;

  const currentKey = getRegistryComparisonKey(
    resolveRegistryValueForRpc(currentChoice),
    resolved,
  );
  return {
    applicable: true,
    mirrorRegistry: mirrorEntry,
    alreadyUsingMirror: currentKey === NPMMIRROR_REGISTRY,
    isTimeout: failure.failureKind === 'timeout',
  };
}

/**
 * Explains pnpm's `minimumReleaseAge` policy when a single-registry install
 * resolves to an older version than the newest version reported during inspect.
 */
export function shouldShowMinimumReleaseAgeNotice(options: {
  inspection: DshPluginInspectResult | null;
  result: DshPluginMutationResult | null;
  attemptedCount: number;
}): MinimumReleaseAgeNotice | null {
  const { inspection, result, attemptedCount } = options;
  if (!inspection || !result || !result.ok) return null;
  if (inspection.kind !== 'registry') return null;
  if (!inspection.name || !inspection.version) return null;
  if (!result.version || result.version === inspection.version) return null;
  if (attemptedCount > 1) return null;
  return {
    installed: result.version,
    latest: inspection.version,
    exactSpec: `${inspection.name}@${inspection.version}`,
  };
}

export function resolveInstallRestartReasonText(
  reason: string | undefined,
  t: (key: string) => string,
): string {
  return resolveUpdateRestartReasonText(reason, t);
}

export function resolveSubjectKindLabelKey(
  kind: DshPluginInspectResult['kind'] | undefined,
): string | null {
  switch (kind) {
    case 'path':
      return 'dshPluginsInstallSubjectPath';
    case 'git':
      return 'dshPluginsInstallSubjectGit';
    case 'tarball':
      return 'dshPluginsInstallSubjectTarball';
    default:
      return null;
  }
}
