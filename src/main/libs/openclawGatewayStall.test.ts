import { describe, expect, test } from 'vitest';

import {
  describeOpenClawGatewayStall,
  parseOpenClawGatewayStall,
} from './openclawGatewayStall';

// Verbatim gateway output from the 2026-08-18 field report, where moltbot-popo
// ran `npm install -g @fabric/cli` through execFileSync on the start path.
const BLOCKED_LINE = '2026-08-18T11:41:00.739+08:00 [diagnostic] liveness warning: '
  + 'reasons=event_loop_utilization interval=62s eventLoopDelayP99Ms=0 eventLoopDelayMaxMs=0 '
  + 'eventLoopUtilization=1 cpuCoreRatio=0.044 active=0 waiting=0 queued=0 '
  + 'recentPhases=sidecars.plugin-services:20ms,sidecars.memory:0ms,sidecars.total:179ms,'
  + 'gateway.ready:1309ms,sidecars.model-prewarm:60583ms,post-ready.agent-runtime-plugins:168ms';

// Same warning shape from the same session while the gateway was merely busy.
const BUSY_LINE = '2026-08-18T10:00:33.689+08:00 [diagnostic] liveness warning: '
  + 'reasons=event_loop_delay interval=30s eventLoopDelayP99Ms=48.9 eventLoopDelayMaxMs=1560.3 '
  + 'eventLoopUtilization=0.061 cpuCoreRatio=0.014 active=0 waiting=0 queued=0 '
  + 'recentPhases=sidecars.main-session-recovery:0ms,post-attach.update-check:1ms';

describe('parseOpenClawGatewayStall', () => {
  test('detects a fully blocked event loop and names the phase that consumed it', () => {
    const stall = parseOpenClawGatewayStall(BLOCKED_LINE);

    expect(stall).toEqual({
      intervalSeconds: 62,
      eventLoopUtilization: 1,
      slowestPhase: { name: 'sidecars.model-prewarm', durationMs: 60583 },
    });
  });

  test('ignores a busy but responsive event loop', () => {
    expect(parseOpenClawGatewayStall(BUSY_LINE)).toBeNull();
  });

  test('ignores lines that are not liveness warnings', () => {
    const heartbeat = '2026-08-18T10:32:04.173+08:00 [diagnostic] heartbeat: '
      + 'webhooks=0/0/0 active=0 waiting=0 queued=0';

    expect(parseOpenClawGatewayStall(heartbeat)).toBeNull();
  });

  test('ignores a blocked sample too short to be worth reporting', () => {
    const brief = '[diagnostic] liveness warning: interval=2s eventLoopUtilization=1';

    expect(parseOpenClawGatewayStall(brief)).toBeNull();
  });

  test('reports a stall without a phase breakdown', () => {
    const noPhases = '[diagnostic] liveness warning: interval=30s eventLoopUtilization=0.98';

    expect(parseOpenClawGatewayStall(noPhases)).toEqual({
      intervalSeconds: 30,
      eventLoopUtilization: 0.98,
      slowestPhase: null,
    });
  });
});

describe('describeOpenClawGatewayStall', () => {
  test('summary carries the duration and the blocking phase', () => {
    const stall = parseOpenClawGatewayStall(BLOCKED_LINE);
    const summary = describeOpenClawGatewayStall(stall!);

    expect(summary).toContain('~62s');
    expect(summary).toContain('sidecars.model-prewarm (60583ms)');
  });

  test('summary stays useful when the gateway reported no phases', () => {
    const summary = describeOpenClawGatewayStall({
      intervalSeconds: 30,
      eventLoopUtilization: 1,
      slowestPhase: null,
    });

    expect(summary).toContain('unknown');
  });
});
