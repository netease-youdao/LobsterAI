import { describe, expect, test } from 'vitest';

const {
  compareStartupCheckpoints,
  computeStartupPhases,
  matchGatewayMilestones,
  median,
  parseLoadedPlugins,
  parseMainLogStartups,
  summarizeCpuProfile,
} = require('../scripts/openclaw-startup-timeline.cjs');

describe('gateway milestones', () => {
  test('matches plain and TTY-colored milestone lines', () => {
    expect(matchGatewayMilestones('2026-11-02T11:25:17.651+09:00 [gateway] loading configuration…')).toEqual(['configLoading']);
    const colored = '\u001b[90m2026-10-30T16:56:31.843+09:00\u001b[39m \u001b[36m[gateway]\u001b[39m \u001b[36mstarting HTTP server...\u001b[39m';
    expect(matchGatewayMilestones(colored)).toEqual(['httpStarting']);
  });

  test('does not mistake other "ready" lines for gateway readiness', () => {
    expect(matchGatewayMilestones("[info]: [ 'event-dispatch is ready' ]")).toEqual([]);
    expect(matchGatewayMilestones('[gateway] ready')).toEqual(['gatewayReady']);
  });

  test('reads the loaded plugin list', () => {
    expect(parseLoadedPlugins('[gateway] http server listening (3 plugins: xai, browser, memory-core; 2.7s)'))
      .toEqual(['browser', 'memory-core', 'xai']);
    expect(parseLoadedPlugins('[gateway] ready')).toBeNull();
  });
});

describe('startup phases', () => {
  test('derives phase durations and leaves missing ones null', () => {
    const phases = computeStartupPhases({
      configLoading: 4000, httpStarting: 6000, channelsStarting: 7000, gatewayReady: 8000, probeReady: 8100,
    });
    expect(phases).toEqual({ boot: 4000, config: 2000, plugins: 1000, sidecars: 1000, detect: 100, total: 8100 });
    expect(computeStartupPhases({ configLoading: 4000 }).total).toBeNull();
  });

  test('median ignores missing values', () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([1, 4])).toBe(3);
    expect(median([null])).toBeNull();
  });
});

describe('migration checkpoints', () => {
  const row = (updatedAt: number, parts: string[]) => ({ updatedAt, value: parts.join('\n') });

  test('an unchanged row is a hit', () => {
    expect(compareStartupCheckpoints(row(1, ['v', 'f']), row(1, ['v', 'f']))).toEqual({ outcome: 'hit', changed: [] });
  });

  test('a rewritten row names the parts that changed', () => {
    const before = row(1, ['v', 'f', 'build', 'cfg-a', 'doctor', 'plugins']);
    const after = row(2, ['v', 'f', 'build', 'cfg-b', 'doctor', 'plugins-2']);
    expect(compareStartupCheckpoints(before, after)).toEqual({ outcome: 'miss', changed: ['effectiveConfig', 'pluginMigration'] });
  });

  test('a missing row after the start is unknown', () => {
    expect(compareStartupCheckpoints(null, null).outcome).toBe('unknown');
  });
});

describe('main log parsing', () => {
  const log = [
    '[2026-10-30 20:13:25.112] [info]  LobsterAI started (darwin arm64)',
    '[2026-10-30 20:13:27.996] [info]  [GW-RESTART-DIAG] x startGateway: reason=ensure-running-for-cowork, currentPhase=ready, port=none',
    '[2026-10-30 20:13:28.014] [info]  [OpenClaw] running startup preparation helpers (runtime-changed)',
    '[2026-10-30 20:13:30.448] [info]  [OpenClaw] startGateway: gateway process created (2452ms), platform=darwin, launcher=spawn',
    '[2026-10-30 20:13:41.589] [info]  [OpenClaw] startup milestone (11141ms since spawn): t [gateway] loading configuration…',
    '[2026-10-30 20:13:43.720] [info]  [OpenClaw] startup milestone (13272ms since spawn): t [gateway] starting HTTP server...',
    '[2026-10-30 20:13:44.962] [info]  [OpenClaw] startup milestone (14514ms since spawn): t [gateway] starting channels and sidecars...',
    '[2026-10-30 20:13:44.966] [info]  [OpenClaw] startup milestone (14518ms since spawn): t [gateway] http server listening (2 plugins: xai, browser; 1.2s)',
    '[2026-10-30 20:13:45.900] [info]  [OpenClaw] startup milestone (15452ms since spawn): t [gateway] ready',
    '[2026-10-30 20:13:46.424] [info]  [OpenClaw] startGateway: waitForGatewayReady returned (18428ms), ready=true',
    '[2026-10-30 20:13:46.428] [info]  [OpenClaw] startup summary: prep=ran checkpoint=miss checkpointChanged=pluginMigration total=18432ms',
    '[2026-10-30 20:13:50.000] [info]  [GW-RESTART-DIAG] x startGateway: reason=channel-sync-ensure-ready, currentPhase=running, port=18789',
    '[2026-10-30 20:13:56.284] [info]  [GW-RESTART-DIAG] x stopGatewayProcess: requesting graceful shutdown for pid=98793',
    '[2026-10-30 20:14:02.300] [warn]  [OpenClaw] gateway shutdown exceeded 6000ms; sending SIGKILL to pid=98793',
    '[2026-10-30 20:14:02.384] [info]  [GW-RESTART-DIAG] x gateway process exited with code=null, signal=SIGKILL',
  ];

  test('splits a launch into a start attempt with phases and checkpoint detail', () => {
    const { attempts } = parseMainLogStartups(log);
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt).toMatchObject({
      reason: 'ensure-running-for-cowork',
      prep: 'ran(runtime-changed)',
      preSpawnMs: 2452,
      ready: true,
      checkpoint: 'miss',
      checkpointChanged: ['pluginMigration'],
      plugins: ['browser', 'xai'],
    });
    expect(attempt.sinceAppStartMs).toBe(5336 - 2452);
    expect(attempt.phases).toMatchObject({ boot: 11141, config: 2131, plugins: 1242, sidecars: 938 });
    expect(attempt.phases.total).toBe(15976);
  });

  test('ignores ensure-ready checks on a running gateway and records killed shutdowns', () => {
    const { attempts, shutdowns } = parseMainLogStartups(log);
    expect(attempts.map((a: { reason: string }) => a.reason)).toEqual(['ensure-running-for-cowork']);
    expect(shutdowns).toEqual([{ pid: '98793', startedAt: '2026-10-30 20:13:56.284', durationMs: 6100, killed: true }]);
  });
});

describe('cpu profile summary', () => {
  test('attributes self time to functions and files within the window', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
        { id: 2, callFrame: { functionName: 'runSqliteCheck', url: 'file:///rt/dist/sqlite-integrity.js', lineNumber: 110 } },
        { id: 3, callFrame: { functionName: 'load', url: 'file:///rt/dist/loader.js', lineNumber: 0 } },
      ],
      samples: [2, 2, 3, 3],
      // Microseconds before each sample; a sample's self time is the next delta.
      timeDeltas: [0, 1000, 1000, 1000],
    };
    const summary = summarizeCpuProfile(profile, { untilMs: 2.5, rootsToStrip: ['file:///rt'] });
    expect(summary.functions[0]).toEqual({ name: 'runSqliteCheck /dist/sqlite-integrity.js:111', ms: 2 });
    expect(summary.files.map((f: { name: string }) => f.name)).toEqual(['/dist/sqlite-integrity.js', '/dist/loader.js']);
    expect(summary.sampledMs).toBe(3);
  });
});
