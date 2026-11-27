import { describe, expect, test } from 'vitest';

import {
  appendInstallLogChunk,
  buildOfferedRegistries,
  foldTerminalLines,
  formatRegistryNameList,
  getRegistryDisplayInfo,
  InstallModalPhase,
  isInstallPendingPhase,
  isValidCustomRegistryUrl,
  normalizeRegistryUrl,
  resolveGithubMirrorRecovery,
  resolveInitialRegistryChoice,
  resolveInstallFailureText,
  resolveInstallInputProblem,
  resolveSubjectKindLabelKey,
  settleInstallRuns,
  shouldShowMinimumReleaseAgeNotice,
  stripAnsiCodes,
} from './pluginInstallViewModel';
import { NPMMIRROR_REGISTRY, OFFICIAL_NPM_REGISTRY } from './pluginViewModel';

const identityT = (key: string) => key;

describe('pluginInstallViewModel', () => {
  test('normalizes and validates custom registry URLs', () => {
    expect(normalizeRegistryUrl('https://REGISTRY.NPMMIRROR.COM')).toBe(NPMMIRROR_REGISTRY);
    expect(normalizeRegistryUrl('http://npm.internal:4873/repo')).toBe('http://npm.internal:4873/repo/');
    expect(normalizeRegistryUrl('ftp://registry.example.com/')).toBeNull();
    expect(normalizeRegistryUrl('https://user:pass@registry.example.com/')).toBeNull();
    expect(normalizeRegistryUrl('https://registry.example.com/ with space')).toBeNull();
    expect(isValidCustomRegistryUrl('https://npm.corp.example/')).toBe(true);
    expect(isValidCustomRegistryUrl('not-a-url')).toBe(false);
  });

  test('deduplicates offered registries and promotes fastest mainland mirror when unconfigured', () => {
    const registries = {
      ok: true,
      registry: null,
      fallbackRegistries: [NPMMIRROR_REGISTRY],
      resolved: OFFICIAL_NPM_REGISTRY,
      fastest: NPMMIRROR_REGISTRY,
    };

    expect(buildOfferedRegistries(registries)).toEqual([null, NPMMIRROR_REGISTRY]);

    // First open without remembered preference promotes the fastest mirror.
    expect(resolveInitialRegistryChoice(null, registries)).toEqual({
      kind: 'offered',
      registry: NPMMIRROR_REGISTRY,
    });

    // When user remembered official npm (null), do not override with fastest mirror.
    expect(
      resolveInitialRegistryChoice({ kind: 'offered', registry: null }, registries),
    ).toEqual({
      kind: 'offered',
      registry: null,
    });

    // When pnpm's own config points to an internal registry, do not switch to public mirror.
    expect(
      resolveInitialRegistryChoice(null, {
        ok: true,
        registry: null,
        fallbackRegistries: [NPMMIRROR_REGISTRY],
        resolved: 'https://npm.corp.internal/',
        fastest: NPMMIRROR_REGISTRY,
      }),
    ).toEqual({
      kind: 'offered',
      registry: null,
    });

    // Remembered offered URL that is no longer in Host's offered list is preserved as custom.
    expect(
      resolveInitialRegistryChoice(
        { kind: 'offered', registry: 'https://old.mirror.example/' },
        registries,
      ),
    ).toEqual({
      kind: 'custom',
      url: 'https://old.mirror.example/',
    });
  });

  test('formats registry names, hosts, and multi-registry lists', () => {
    expect(getRegistryDisplayInfo(null, OFFICIAL_NPM_REGISTRY, identityT)).toEqual({
      name: 'dshPluginsRegistryOfficial',
      host: 'registry.npmjs.org',
    });
    expect(getRegistryDisplayInfo(NPMMIRROR_REGISTRY, OFFICIAL_NPM_REGISTRY, identityT)).toEqual({
      name: 'dshPluginsRegistryNpmMirror',
      host: 'registry.npmmirror.com',
    });
    expect(getRegistryDisplayInfo(null, null, identityT)).toEqual({
      name: 'dshPluginsRegistryDefault',
      host: 'registry.npmjs.org',
    });
    expect(getRegistryDisplayInfo('https://npm.acme.dev/', null, identityT)).toEqual({
      name: 'npm.acme.dev',
      host: 'npm.acme.dev',
    });

    const listT = (key: string) => {
      if (key === 'dshPluginsRegistryListSeparator') return ', ';
      if (key === 'dshPluginsRegistryNpmMirror') return 'China Mirror';
      if (key === 'dshPluginsRegistryOfficial') return 'npm Official';
      return key;
    };
    expect(
      formatRegistryNameList([NPMMIRROR_REGISTRY, null], OFFICIAL_NPM_REGISTRY, listT),
    ).toBe('China Mirror, npm Official');
  });

  test('strips ANSI codes, collapses CR progress lines, and folds long terminal output', () => {
    expect(stripAnsiCodes('\x1b[32mPackages: +1\x1b[39m\r\nProgress: 10%\rProgress: 100%\n')).toBe(
      'Packages: +1\nProgress: 100%\n',
    );

    const shortFold = foldTerminalLines('line1\nline2\nline3\n', 12);
    expect(shortFold).toEqual({
      head: ['line1', 'line2', 'line3'],
      tail: [],
      hiddenCount: 0,
      totalLines: 3,
    });

    const twentyLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n');
    const longFold = foldTerminalLines(twentyLines, 12);
    expect(longFold.totalLines).toBe(20);
    expect(longFold.hiddenCount).toBe(8);
    expect(longFold.head).toEqual(['line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6']);
    expect(longFold.tail).toEqual(['line-15', 'line-16', 'line-17', 'line-18', 'line-19', 'line-20']);
  });

  test('aggregates live install log chunks per jobId and settles open runs', () => {
    let runs = appendInstallLogChunk(
      [],
      {
        requestId: 'req-1',
        jobId: 'job-1',
        argv: ['pnpm', 'add', 'dsh-plugin-whale-pet'],
        cwd: '/tmp/profile',
        stream: 'stdout',
        text: 'Resolving...\n',
      },
      false,
    );
    runs = appendInstallLogChunk(
      runs,
      {
        requestId: 'req-1',
        jobId: 'job-1',
        argv: ['pnpm', 'add', 'dsh-plugin-whale-pet'],
        cwd: '/tmp/profile',
        stream: 'stdout',
        text: 'Done\n',
        exitCode: 0,
      },
      false,
    );
    runs = appendInstallLogChunk(
      runs,
      {
        requestId: 'req-1',
        jobId: 'job-2',
        argv: ['pnpm', 'add', 'dsh-plugin-whale-pet', '--registry=https://registry.npmjs.org/'],
        cwd: '/tmp/profile',
        stream: 'stderr',
        text: 'ERR_PNPM_FETCH\n',
      },
      false,
    );

    expect(runs).toHaveLength(2);
    expect(runs[0].output).toBe('Resolving...\nDone\n');
    expect(runs[0].exitCode).toBe(0);
    expect(runs[1].exitCode).toBeUndefined();

    const settled = settleInstallRuns(runs, 1);
    expect(settled[0].exitCode).toBe(0);
    expect(settled[1].exitCode).toBe(1);
  });

  test('formats inspect refusal messages including multi-registry network failures', () => {
    const t = (key: string) => {
      switch (key) {
        case 'dshPluginsProblemNetworkAll':
          return 'All failed: {registries}';
        case 'dshPluginsRegistryListSeparator':
          return ' / ';
        case 'dshPluginsRegistryNpmMirror':
          return 'Mirror';
        case 'dshPluginsRegistryOfficial':
          return 'Official';
        case 'dshPluginsProblemNotBundleReason':
          return 'Not bundle: {reason}';
        default:
          return key;
      }
    };

    expect(
      resolveInstallInputProblem(
        {
          ok: true,
          status: 'refused',
          problem: 'network',
          registries: [NPMMIRROR_REGISTRY, null],
        },
        OFFICIAL_NPM_REGISTRY,
        t,
      ),
    ).toBe('All failed: Mirror / Official');

    expect(
      resolveInstallInputProblem(
        {
          ok: true,
          status: 'refused',
          problem: 'not-a-bundle',
          reason: 'missing dsh.bundle',
        },
        OFFICIAL_NPM_REGISTRY,
        t,
      ),
    ).toBe('Not bundle: missing dsh.bundle');
  });

  test('resolves classified install failures across incompatibility, spec-host, multi-registry, and build-blocked', () => {
    const t = (key: string) => {
      switch (key) {
        case 'dshPluginsInstallIncompatibleDetail':
          return '{plugin} needs {requirements} on {runtime}.';
        case 'dshPluginsInstallIncompatibleHint':
          return 'Install compatible version.';
        case 'dshPluginsSentenceSeparator':
          return ' ';
        case 'dshPluginsInstallFailureNetworkHost':
          return 'Cannot reach {host}';
        case 'dshPluginsInstallFailureNetworkAll':
          return 'All registries failed: {registries}';
        case 'dshPluginsRegistryListSeparator':
          return ', ';
        case 'dshPluginsRegistryNpmMirror':
          return 'Mirror';
        case 'dshPluginsRegistryOfficial':
          return 'Official';
        default:
          return key;
      }
    };

    expect(
      resolveInstallFailureText(
        {
          ok: false,
          errorCode: 'incompatible-version',
          incompatible: [
            {
              name: 'dsh-plugin-foo',
              version: '2.0.0',
              runtimeVersion: '0.2.2-rc.5',
              requirements: { 'engines.dsh': '>=0.3.0' },
            },
          ],
        },
        {},
        t,
      ),
    ).toBe('dsh-plugin-foo@2.0.0 needs engines.dsh >=0.3.0 on 0.2.2-rc.5. Install compatible version.');

    expect(
      resolveInstallFailureText(
        { ok: false, failedAt: 'spec-host', failureKind: 'network' },
        { subjectHost: 'github.com' },
        t,
      ),
    ).toBe('Cannot reach github.com');

    expect(
      resolveInstallFailureText(
        {
          ok: false,
          failedAt: 'registry',
          failureKind: 'timeout',
          registries: [NPMMIRROR_REGISTRY, null],
        },
        { resolvedRegistry: OFFICIAL_NPM_REGISTRY },
        t,
      ),
    ).toBe('All registries failed: Mirror, Official');

    expect(
      resolveInstallFailureText({ ok: false, failureKind: 'build-blocked' }, {}, t),
    ).toBe('dshPluginsInstallFailureBuildBlockedManual');

    expect(
      resolveInstallFailureText(
        { ok: false, failureKind: 'build-blocked', pendingBuilds: ['esbuild'] },
        {},
        t,
      ),
    ).toBe('dshPluginsInstallFailureBuildBlocked');

    expect(
      resolveInstallFailureText({ ok: false, stage: 'enable', enabled: true }, {}, t),
    ).toBe('dshPluginsInstallFailedEnabling');
  });

  test('detects GitHub mirror recovery and minimumReleaseAge notices', () => {
    const registries = {
      ok: true,
      registry: null,
      fallbackRegistries: [NPMMIRROR_REGISTRY],
      resolved: OFFICIAL_NPM_REGISTRY,
    };

    const recovery = resolveGithubMirrorRecovery({
      failure: { ok: false, failedAt: 'spec-host', failureKind: 'timeout' },
      subjectHost: 'github.com',
      registries,
      currentChoice: { kind: 'offered', registry: null },
    });
    expect(recovery).toEqual({
      applicable: true,
      mirrorRegistry: NPMMIRROR_REGISTRY,
      alreadyUsingMirror: false,
      isTimeout: true,
    });

    const alreadyMirror = resolveGithubMirrorRecovery({
      failure: { ok: false, failedAt: 'spec-host', failureKind: 'network' },
      subjectHost: 'api.github.com',
      registries,
      currentChoice: { kind: 'offered', registry: NPMMIRROR_REGISTRY },
    });
    expect(alreadyMirror.applicable).toBe(true);
    expect(alreadyMirror.alreadyUsingMirror).toBe(true);
    expect(alreadyMirror.isTimeout).toBe(false);

    expect(
      shouldShowMinimumReleaseAgeNotice({
        inspection: {
          ok: true,
          status: 'accepted',
          kind: 'registry',
          name: 'dsh-plugin-whale-pet',
          version: '1.2.0',
        },
        result: { ok: true, version: '1.1.0' },
        attemptedCount: 1,
      }),
    ).toEqual({
      installed: '1.1.0',
      latest: '1.2.0',
      exactSpec: 'dsh-plugin-whale-pet@1.2.0',
    });

    // Multi-registry fallback skips minimumReleaseAge notice.
    expect(
      shouldShowMinimumReleaseAgeNotice({
        inspection: {
          ok: true,
          status: 'accepted',
          kind: 'registry',
          name: 'dsh-plugin-whale-pet',
          version: '1.2.0',
        },
        result: { ok: true, version: '1.1.0' },
        attemptedCount: 2,
      }),
    ).toBeNull();
  });

  test('identifies pending modal phases and subject kind labels', () => {
    expect(isInstallPendingPhase(InstallModalPhase.Starting)).toBe(true);
    expect(isInstallPendingPhase(InstallModalPhase.Running)).toBe(true);
    expect(isInstallPendingPhase(InstallModalPhase.Cancelling)).toBe(true);
    expect(isInstallPendingPhase(InstallModalPhase.Applying)).toBe(true);
    expect(isInstallPendingPhase(InstallModalPhase.Idle)).toBe(false);
    expect(isInstallPendingPhase(InstallModalPhase.Done)).toBe(false);
    expect(isInstallPendingPhase(InstallModalPhase.Failed)).toBe(false);

    expect(resolveSubjectKindLabelKey('git')).toBe('dshPluginsInstallSubjectGit');
    expect(resolveSubjectKindLabelKey('path')).toBe('dshPluginsInstallSubjectPath');
    expect(resolveSubjectKindLabelKey('tarball')).toBe('dshPluginsInstallSubjectTarball');
    expect(resolveSubjectKindLabelKey('registry')).toBeNull();
  });
});
