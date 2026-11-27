import { describe, expect, test } from 'vitest';

import {
  DshPluginApplicationStatus,
  DshPluginUpdateKind,
  DshPluginUpdateOutcomeKind,
  DshPluginUpdateStep,
} from '../../../shared/dshEngine/hostConstants';
import type {
  DshPluginEntry,
  DshPluginUpdateOutcome,
  DshPluginVersionInfo,
  DshPluginVersionList,
} from '../../services/dshHost';
import {
  BatchUpdateCheckSummaryTone,
  dropStaleVersionChecks,
  formatIncompatibleRequirements,
  formatPluginCheckedTime,
  formatPluginPublishedDate,
  getPluginRecommendedVersion,
  getPluginVersionCheckRegistry,
  isPluginVersionInstallable,
  isRegistryUpdatablePlugin,
  mergeSettledUpdateSteps,
  pickRecommendedPluginUpdate,
  PluginUpdateStepVisualState,
  type PluginVersionCheckState,
  resolveRegistryAttemptProblemText,
  resolveUpdateFailureDetail,
  resolveUpdateRestartReasonText,
  resolveUpdateStepVisualState,
  summarizeBatchUpdateCheck,
} from './pluginUpdateViewModel';

const identityT = (key: string) => key;

function makePlugin(overrides: Partial<DshPluginEntry> = {}): DshPluginEntry {
  return {
    name: '@acme/demo-plugin',
    specifier: '^1.0.0',
    managed: false,
    official: false,
    enabled: true,
    version: '1.0.0',
    update: DshPluginUpdateKind.Registry,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<DshPluginVersionInfo> = {}): DshPluginVersionInfo {
  return {
    version: '1.2.0',
    tags: ['latest'],
    prerelease: false,
    bundle: true,
    ...overrides,
  };
}

describe('isRegistryUpdatablePlugin', () => {
  test('only accepts third-party registry plugins', () => {
    expect(isRegistryUpdatablePlugin(makePlugin())).toBe(true);
    expect(isRegistryUpdatablePlugin(makePlugin({ managed: true }))).toBe(false);
    expect(isRegistryUpdatablePlugin(makePlugin({ official: true }))).toBe(false);
    expect(isRegistryUpdatablePlugin(makePlugin({ update: DshPluginUpdateKind.Git }))).toBe(false);
    expect(isRegistryUpdatablePlugin(makePlugin({ update: undefined }))).toBe(false);
  });
});

describe('version candidate selection', () => {
  test('skips prerelease, deprecated, non-bundle, and incompatible versions', () => {
    const list: DshPluginVersionList = {
      status: 'listed',
      installed: '1.0.0',
      registry: 'https://registry.npmmirror.com/',
      attempts: [{ registry: 'https://registry.npmmirror.com/' }],
      omitted: 0,
      versions: [
        makeVersion({
          version: '3.0.0',
          incompatible: {
            name: '@acme/demo-plugin',
            version: '3.0.0',
            runtimeVersion: '0.2.2-rc.5',
            requirements: { 'engines.dsh': '>=0.3.0' },
          },
        }),
        makeVersion({ version: '2.1.0-beta.1', prerelease: true, tags: ['next'] }),
        makeVersion({ version: '2.0.0', deprecated: 'broken build' }),
        makeVersion({ version: '1.5.0', bundle: false }),
        makeVersion({ version: '1.2.0', tags: ['latest'] }),
        makeVersion({ version: '1.1.0', tags: [] }),
      ],
    };

    expect(isPluginVersionInstallable(list.versions[0])).toBe(false);
    expect(isPluginVersionInstallable(list.versions[3])).toBe(false);
    expect(isPluginVersionInstallable(list.versions[4])).toBe(true);
    expect(pickRecommendedPluginUpdate(list)?.version).toBe('1.2.0');

    const check: PluginVersionCheckState = { phase: 'done', checkedAt: 1000, list };
    expect(getPluginRecommendedVersion(check)).toBe('1.2.0');
    expect(getPluginVersionCheckRegistry(check)).toBe('https://registry.npmmirror.com/');
  });

  test('returns undefined when list is refused or has no eligible stable version', () => {
    const refused: DshPluginVersionList = {
      status: 'refused',
      problem: 'network',
      reason: 'ETIMEDOUT',
      attempts: [],
    };
    expect(pickRecommendedPluginUpdate(refused)).toBeUndefined();
    expect(
      getPluginVersionCheckRegistry({ phase: 'done', checkedAt: 1, list: refused }),
    ).toBeUndefined();
  });
});

describe('dropStaleVersionChecks', () => {
  test('removes entries for uninstalled, non-registry, or upgraded plugins while preserving in-flight and matching checks', () => {
    const plugins = [
      makePlugin({ name: 'kept-matching', version: '1.0.0' }),
      makePlugin({ name: 'upgraded', version: '1.2.0' }),
      makePlugin({ name: 'still-checking', version: '1.0.0' }),
      makePlugin({ name: 'refused-kept', version: '1.0.0' }),
      makePlugin({ name: 'now-official', version: '1.0.0', official: true }),
    ];

    const checks: Record<string, PluginVersionCheckState> = {
      'kept-matching': {
        phase: 'done',
        checkedAt: 1,
        list: {
          status: 'listed',
          installed: '1.0.0',
          registry: null,
          attempts: [],
          versions: [makeVersion({ version: '1.1.0' })],
          omitted: 0,
        },
      },
      upgraded: {
        phase: 'done',
        checkedAt: 1,
        list: {
          status: 'listed',
          installed: '1.0.0',
          registry: null,
          attempts: [],
          versions: [makeVersion({ version: '1.2.0' })],
          omitted: 0,
        },
      },
      'still-checking': { phase: 'checking' },
      'refused-kept': {
        phase: 'done',
        checkedAt: 1,
        list: { status: 'refused', problem: 'network', reason: 'offline', attempts: [] },
      },
      'now-official': {
        phase: 'done',
        checkedAt: 1,
        list: {
          status: 'listed',
          installed: '1.0.0',
          registry: null,
          attempts: [],
          versions: [],
          omitted: 0,
        },
      },
      removed: {
        phase: 'done',
        checkedAt: 1,
        list: {
          status: 'listed',
          installed: '1.0.0',
          registry: null,
          attempts: [],
          versions: [],
          omitted: 0,
        },
      },
    };

    const next = dropStaleVersionChecks(plugins, checks);
    expect(Object.keys(next).sort()).toEqual(['kept-matching', 'refused-kept', 'still-checking']);
  });
});

describe('summarizeBatchUpdateCheck', () => {
  test('summarizes available updates, all latest, failed checks, and suppresses incomplete checks', () => {
    const plugins = [
      makePlugin({ name: 'pkg-a' }),
      makePlugin({ name: 'pkg-b' }),
      makePlugin({ name: 'official-pkg', official: true }),
    ];

    const t = (key: string) =>
      key === 'dshPluginsUpdatesAvailableCount' ? '{count} updates' : key;

    // Incomplete check -> null
    expect(
      summarizeBatchUpdateCheck(
        plugins,
        {
          'pkg-a': { phase: 'checking' },
        },
        t,
      ),
    ).toBeNull();

    // One available
    expect(
      summarizeBatchUpdateCheck(
        plugins,
        {
          'pkg-a': {
            phase: 'done',
            checkedAt: 1,
            list: {
              status: 'listed',
              installed: '1.0.0',
              registry: null,
              attempts: [],
              versions: [makeVersion({ version: '1.3.0' })],
              omitted: 0,
            },
          },
          'pkg-b': {
            phase: 'done',
            checkedAt: 1,
            list: {
              status: 'listed',
              installed: '1.0.0',
              registry: null,
              attempts: [],
              versions: [],
              omitted: 0,
            },
          },
        },
        t,
      ),
    ).toEqual({ text: '1 updates', tone: BatchUpdateCheckSummaryTone.Info });

    // None available, one refused
    expect(
      summarizeBatchUpdateCheck(
        plugins,
        {
          'pkg-a': {
            phase: 'done',
            checkedAt: 1,
            list: { status: 'refused', problem: 'network', reason: 'err', attempts: [] },
          },
          'pkg-b': {
            phase: 'done',
            checkedAt: 1,
            list: {
              status: 'listed',
              installed: '1.0.0',
              registry: null,
              attempts: [],
              versions: [],
              omitted: 0,
            },
          },
        },
        t,
      ),
    ).toEqual({
      text: 'dshPluginsUpdatesCheckFailedSummary',
      tone: BatchUpdateCheckSummaryTone.Error,
    });

    // All up to date
    expect(
      summarizeBatchUpdateCheck(
        plugins,
        {
          'pkg-a': {
            phase: 'done',
            checkedAt: 1,
            list: {
              status: 'listed',
              installed: '1.0.0',
              registry: null,
              attempts: [],
              versions: [],
              omitted: 0,
            },
          },
          'pkg-b': {
            phase: 'done',
            checkedAt: 1,
            list: {
              status: 'listed',
              installed: '1.0.0',
              registry: null,
              attempts: [],
              versions: [],
              omitted: 0,
            },
          },
        },
        t,
      ),
    ).toEqual({
      text: 'dshPluginsUpdatesAllLatest',
      tone: BatchUpdateCheckSummaryTone.Success,
    });
  });
});

describe('step timeline merging and visual state', () => {
  test('recovers dropped steps from settled outcome including automatic restore', () => {
    const restoredOutcome: DshPluginUpdateOutcome = {
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.InstallFailedRestored,
      from: '1.0.0',
      to: '1.2.0',
      step: 'install',
      application: DshPluginApplicationStatus.Failed,
      restored: true,
      restoreApplication: DshPluginApplicationStatus.Applied,
    };

    const steps = mergeSettledUpdateSteps([DshPluginUpdateStep.Checking], restoredOutcome);
    expect(steps).toEqual([
      DshPluginUpdateStep.Checking,
      DshPluginUpdateStep.Removing,
      DshPluginUpdateStep.Installing,
      DshPluginUpdateStep.Restoring,
    ]);

    expect(
      resolveUpdateStepVisualState(DshPluginUpdateStep.Checking, false, false, restoredOutcome),
    ).toBe(PluginUpdateStepVisualState.Done);
    expect(
      resolveUpdateStepVisualState(DshPluginUpdateStep.Removing, false, false, restoredOutcome),
    ).toBe(PluginUpdateStepVisualState.Done);
    expect(
      resolveUpdateStepVisualState(DshPluginUpdateStep.Installing, false, false, restoredOutcome),
    ).toBe(PluginUpdateStepVisualState.Failed);
    expect(
      resolveUpdateStepVisualState(DshPluginUpdateStep.Restoring, false, true, restoredOutcome),
    ).toBe(PluginUpdateStepVisualState.Done);
  });

  test('marks last step running while active and unknown when transport was lost', () => {
    expect(
      resolveUpdateStepVisualState(DshPluginUpdateStep.Installing, true, true, null),
    ).toBe(PluginUpdateStepVisualState.Running);
    expect(
      resolveUpdateStepVisualState(DshPluginUpdateStep.Removing, true, false, null),
    ).toBe(PluginUpdateStepVisualState.Done);

    const lostOutcome: DshPluginUpdateOutcome = {
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.TransportLost,
      from: '1.0.0',
      to: '1.2.0',
      error: 'socket closed',
    };
    expect(
      resolveUpdateStepVisualState(DshPluginUpdateStep.Installing, false, true, lostOutcome),
    ).toBe(PluginUpdateStepVisualState.Unknown);
  });
});

describe('formatting and failure diagnostics', () => {
  test('formats dates, checked times, incompatible requirements, restart reasons, and failure messages', () => {
    expect(formatPluginPublishedDate('2026-11-26T04:00:00.000Z')).toMatch(/^2026-11-2[56]$/);
    expect(formatPluginPublishedDate('not-a-date')).toBeNull();
    expect(formatPluginCheckedTime(new Date(2026, 10, 26, 9, 5).getTime())).toBe('09:05');

    expect(
      formatIncompatibleRequirements({
        name: '@acme/demo',
        version: '2.0.0',
        runtimeVersion: '0.2.2-rc.5',
        requirements: { 'engines.dsh': '>=0.3.0', '@deepseek-ai/dsh-base': '^0.3.0' },
      }),
    ).toBe('engines.dsh >=0.3.0, @deepseek-ai/dsh-base ^0.3.0');

    expect(resolveUpdateRestartReasonText('host-module', identityT)).toBe(
      'dshPluginsRestartReasonHostModule',
    );
    expect(resolveUpdateRestartReasonText(undefined, identityT)).toBe(
      'dshPluginsRestartRequiredBanner',
    );

    expect(
      resolveUpdateFailureDetail(
        {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.CheckRefused,
          from: '1.0.0',
          to: '2.0.0',
          errorCode: 'incompatible-version',
          incompatible: [
            {
              name: '@acme/demo',
              version: '2.0.0',
              runtimeVersion: '0.2.2-rc.5',
              requirements: { 'engines.dsh': '>=0.3.0' },
            },
          ],
        },
        (key) =>
          key === 'dshPluginsUpdateIncompatibleDetail' ? '{peers} vs {runtime}' : key,
      ),
    ).toBe('engines.dsh >=0.3.0 vs 0.2.2-rc.5');

    expect(
      resolveUpdateFailureDetail(
        {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.InstallFailedRestored,
          from: '1.0.0',
          to: '1.2.0',
          pendingBuilds: ['esbuild', 'sharp'],
        },
        (key) =>
          key === 'dshPluginsUpdateBuildBlockedDetail' ? 'blocked: {packages}' : key,
      ),
    ).toBe('blocked: esbuild, sharp');

    expect(resolveRegistryAttemptProblemText('network', identityT)).toBe(
      'dshPluginsVersionsProblemNetwork',
    );
    expect(resolveRegistryAttemptProblemText('not-found', identityT)).toBe(
      'dshPluginsVersionsProblemNotFound',
    );
    expect(resolveRegistryAttemptProblemText(undefined, identityT)).toBe(
      'dshPluginsVersionsProblemUnknown',
    );
  });
});
