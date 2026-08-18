/**
 * Detection for OpenClaw gateway event-loop stalls.
 *
 * The gateway periodically reports its own liveness, e.g.
 *
 *   [diagnostic] liveness warning: reasons=event_loop_utilization interval=62s
 *   eventLoopDelayP99Ms=0 eventLoopDelayMaxMs=0 eventLoopUtilization=1
 *   cpuCoreRatio=0.044 active=0 waiting=0 queued=0
 *   recentPhases=sidecars.plugin-services:20ms,gateway.ready:1309ms,
 *   sidecars.model-prewarm:60583ms,post-ready.agent-runtime-plugins:168ms
 *
 * `eventLoopUtilization=1` means the loop spent the whole window inside
 * synchronous JS — nothing was served, no timer fired. A plugin calling
 * `execFileSync`/`spawnSync` on the start path produces exactly this, and from
 * the outside it is indistinguishable from a dead gateway: health polls hang,
 * the RPC handshake times out, and LobsterAI restarts a gateway that was fine.
 *
 * The warning is retrospective — it is emitted once the window closes, so it
 * cannot gate a restart that is already in flight. Its value is naming the
 * culprit: `recentPhases` carries the phase that consumed the window.
 */

/** At or above this utilization the loop was effectively blocked, not just busy. */
export const GATEWAY_STALL_UTILIZATION_THRESHOLD = 0.95;

/** Below this the window is too short to be worth reporting as a stall. */
export const GATEWAY_STALL_MIN_INTERVAL_SECONDS = 5;

export type OpenClawGatewayStallPhase = {
  name: string;
  durationMs: number;
};

export type OpenClawGatewayStall = {
  /** Sampling window the gateway reported, in seconds. */
  intervalSeconds: number;
  /** Event loop utilization across that window (1 = fully blocked). */
  eventLoopUtilization: number;
  /** Longest entry of the gateway's `recentPhases` breakdown, when present. */
  slowestPhase: OpenClawGatewayStallPhase | null;
};

const parseNumber = (source: string, key: string): number | null => {
  const match = source.match(new RegExp(`${key}=([0-9]*\\.?[0-9]+)`));
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const parseSlowestPhase = (source: string): OpenClawGatewayStallPhase | null => {
  const match = source.match(/recentPhases=(\S+)/);
  if (!match) {
    return null;
  }
  let slowest: OpenClawGatewayStallPhase | null = null;
  for (const entry of match[1].split(',')) {
    const phase = entry.match(/^(.+):([0-9]+)ms$/);
    if (!phase) {
      continue;
    }
    const durationMs = Number(phase[2]);
    if (!Number.isFinite(durationMs)) {
      continue;
    }
    if (!slowest || durationMs > slowest.durationMs) {
      slowest = { name: phase[1], durationMs };
    }
  }
  return slowest;
};

/**
 * Extract a stall from one gateway liveness warning line, or null when the line
 * is not a liveness warning or the loop was merely busy rather than blocked.
 */
export function parseOpenClawGatewayStall(line: string): OpenClawGatewayStall | null {
  if (!line.includes('liveness warning')) {
    return null;
  }
  const eventLoopUtilization = parseNumber(line, 'eventLoopUtilization');
  if (eventLoopUtilization === null || eventLoopUtilization < GATEWAY_STALL_UTILIZATION_THRESHOLD) {
    return null;
  }
  const intervalSeconds = parseNumber(line, 'interval');
  if (intervalSeconds === null || intervalSeconds < GATEWAY_STALL_MIN_INTERVAL_SECONDS) {
    return null;
  }
  return {
    intervalSeconds,
    eventLoopUtilization,
    slowestPhase: parseSlowestPhase(line),
  };
}

/** One-line, greppable summary for the main log. */
export function describeOpenClawGatewayStall(stall: OpenClawGatewayStall): string {
  const culprit = stall.slowestPhase
    ? `${stall.slowestPhase.name} (${stall.slowestPhase.durationMs}ms)`
    : 'unknown (no recentPhases reported)';
  return (
    `gateway event loop was blocked for ~${stall.intervalSeconds}s `
    + `(eventLoopUtilization=${stall.eventLoopUtilization}); slowest phase: ${culprit}. `
    + 'Health checks, the RPC handshake and every timer were stalled for that window.'
  );
}
