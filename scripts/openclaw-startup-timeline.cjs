'use strict';

// Shared parsing for the OpenClaw startup tools: the isolated benchmark
// (bench-openclaw-startup.cjs) and the real-log analyzer
// (analyze-openclaw-startup-logs.cjs). Pure functions only, so tests can cover them.

/**
 * Gateway milestones in startup order, as OpenClaw v2026.8.1 logs them
 * (src/cli/gateway-cli/run.ts, src/gateway/server-runtime-state-prepare.ts,
 * server-startup-post-attach.ts).
 */
const GATEWAY_MILESTONES = [
  { key: 'configLoading', pattern: /\[gateway\] loading configuration/ },
  { key: 'authResolving', pattern: /\[gateway\] resolving authentication/ },
  { key: 'gatewayStarting', pattern: /\[gateway\] starting\.\.\./ },
  { key: 'pluginsAutoEnabled', pattern: /\[gateway\] auto-enabled plugins/ },
  { key: 'httpStarting', pattern: /\[gateway\] starting HTTP server/ },
  { key: 'channelsStarting', pattern: /\[gateway\] starting channels and sidecars/ },
  { key: 'httpListening', pattern: /\[gateway\] http server listening/ },
  { key: 'gatewayReady', pattern: /\[gateway\] ready\b/ },
];

/**
 * Startup phases, each between two marks. `spawn` is the fork and `probeReady`
 * the first successful /startupz probe; the others are gateway milestones.
 */
const STARTUP_PHASES = [
  // Module loading plus OpenClaw's own state migrations: no output until it ends.
  { key: 'boot', from: 'spawn', to: 'configLoading' },
  { key: 'config', from: 'configLoading', to: 'httpStarting' },
  { key: 'plugins', from: 'httpStarting', to: 'channelsStarting' },
  { key: 'sidecars', from: 'channelsStarting', to: 'gatewayReady' },
  // How long LobsterAI's readiness probe takes to notice.
  { key: 'detect', from: 'gatewayReady', to: 'probeReady' },
  { key: 'total', from: 'spawn', to: 'probeReady' },
];

const PLUGIN_LIST_RE = /http server listening \((\d+) plugins?: ([^;)]*)/;
// eslint-disable-next-line no-control-regex -- matching terminal color codes is the point
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

/** A TTY-attached gateway (development) colors its output. */
function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, '');
}

/** Milestone keys a chunk of gateway output announces, in startup order. */
function matchGatewayMilestones(text) {
  const plain = stripAnsi(text);
  return GATEWAY_MILESTONES.filter(m => m.pattern.test(plain)).map(m => m.key);
}

/** Plugin ids from the `http server listening (N plugins: a, b; 2.7s)` line. */
function parseLoadedPlugins(text) {
  const match = PLUGIN_LIST_RE.exec(stripAnsi(text));
  if (!match) return null;
  return match[2].split(',').map(id => id.trim()).filter(Boolean).sort();
}

/** Phase durations from a `{ mark: ms since spawn }` map; a missing mark leaves its phase null. */
function computeStartupPhases(marks) {
  const phases = {};
  for (const phase of STARTUP_PHASES) {
    const from = phase.from === 'spawn' ? 0 : marks[phase.from];
    const to = marks[phase.to];
    phases[phase.key] = typeof from === 'number' && typeof to === 'number' ? to - from : null;
  }
  return phases;
}

// OpenClaw v2026.8.1 src/infra/startup-migration-checkpoint.ts formatStartupMigrationCheckpoint:
// the parts joined with newlines into schema_meta.app_version, in this order.
const STARTUP_MIGRATION_CHECKPOINT_PARTS = [
  'version', 'format', 'buildIdentity', 'effectiveConfig', 'pluginDoctorConfig', 'pluginMigration',
];

/** hit/miss plus the checkpoint parts that changed, from the row before and after a start. */
function compareStartupCheckpoints(before, after) {
  if (!after) return { outcome: 'unknown', changed: [] };
  if (before && before.updatedAt === after.updatedAt) return { outcome: 'hit', changed: [] };
  const a = (before?.value || '').split('\n');
  const b = (after.value || '').split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) changed.push(STARTUP_MIGRATION_CHECKPOINT_PARTS[i] ?? `part${i}`);
  }
  return { outcome: 'miss', changed };
}

/**
 * Self time per function and per file from a V8 .cpuprofile, limited to the
 * first `untilMs` of the profile (e.g. the boot phase). Times are in ms.
 */
function summarizeCpuProfile(profile, { untilMs = Infinity, top = 15, rootsToStrip = [] } = {}) {
  const nodesById = new Map(profile.nodes.map(node => [node.id, node]));
  const selfByNode = new Map();
  let elapsedUs = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    elapsedUs += profile.timeDeltas[i] || 0;
    if (elapsedUs / 1000 > untilMs) break;
    const next = profile.timeDeltas[i + 1] || 0;
    selfByNode.set(profile.samples[i], (selfByNode.get(profile.samples[i]) || 0) + next);
  }
  const byFunction = new Map();
  const byFile = new Map();
  let totalUs = 0;
  for (const [id, us] of selfByNode) {
    const frame = nodesById.get(id)?.callFrame;
    if (!frame) continue;
    totalUs += us;
    let url = frame.url || `(${frame.functionName || 'native'})`;
    for (const root of rootsToStrip) url = url.split(root).join('');
    const fn = `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
    byFunction.set(fn, (byFunction.get(fn) || 0) + us);
    byFile.set(url, (byFile.get(url) || 0) + us);
  }
  const rank = map => [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, top)
    .map(([name, us]) => ({ name, ms: Math.round(us / 1000) }));
  return { sampledMs: Math.round(totalUs / 1000), functions: rank(byFunction), files: rank(byFile) };
}

function median(values) {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ---------------------------------------------------------------------------
// main-YYYY-MM-DD.log parsing
// ---------------------------------------------------------------------------

const LOG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(\w+)\]\s+(.*)$/;
const APP_STARTED_RE = /^LobsterAI started \(/;
const START_REASON_RE = /startGateway: reason=([^,]+), currentPhase=(\w+)/;
const PREP_SKIPPED_RE = /\[OpenClaw\] startup preparation skipped/;
const PREP_RAN_RE = /\[OpenClaw\] running startup preparation helpers \(([^)]*)\)/;
const PROCESS_CREATED_RE = /\[OpenClaw\] startGateway: gateway process created \((\d+)ms\)/;
const MILESTONE_RE = /\[OpenClaw\] startup milestone \((\d+)ms since spawn\): (.*)$/;
const WAIT_RETURNED_RE = /\[OpenClaw\] startGateway: waitForGatewayReady returned \((\d+)ms\), ready=(true|false)/;
const SUMMARY_RE = /\[OpenClaw\] startup summary: prep=(\w+) checkpoint=(\w+)(?: checkpointChanged=(\S+))?/;
const STOP_REQUESTED_RE = /stopGatewayProcess: requesting graceful shutdown for pid=(\d+)/;
const SIGKILL_RE = /gateway shutdown exceeded (\d+)ms; sending SIGKILL to pid=(\d+)/;
const PROCESS_EXITED_RE = /gateway process exited with code=(\S+), signal=(\S+)/;

function parseLogTimestamp(stamp) {
  return new Date(stamp.replace(' ', 'T')).getTime();
}

/**
 * Splits LobsterAI main logs into gateway start attempts and shutdowns.
 * `lines` is the concatenated log in time order.
 */
function parseMainLogStartups(lines) {
  const attempts = [];
  const shutdowns = [];
  let appStartedAt = null;
  let pendingReason = null;
  let pendingPrep = null;
  let current = null;
  let stopping = null;

  const finishAttempt = () => {
    if (!current) return;
    current.phases = computeStartupPhases(current.marks);
    attempts.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = LOG_LINE_RE.exec(raw);
    if (!line) continue;
    const at = parseLogTimestamp(line[1]);
    const message = line[3];
    let match;

    if (APP_STARTED_RE.test(message)) {
      finishAttempt();
      appStartedAt = at;
      pendingReason = null;
      pendingPrep = null;
      continue;
    }
    if ((match = START_REASON_RE.exec(message)) && match[2] !== 'running') {
      // `running` means an ensure-ready check on a live gateway, not a start.
      pendingReason = match[1];
      continue;
    }
    if (PREP_SKIPPED_RE.test(message)) { pendingPrep = 'skipped'; continue; }
    if ((match = PREP_RAN_RE.exec(message))) { pendingPrep = `ran(${match[1]})`; continue; }
    if ((match = PROCESS_CREATED_RE.exec(message))) {
      finishAttempt();
      const preSpawnMs = Number(match[1]);
      current = {
        spawnedAt: at,
        startedAt: line[1],
        reason: pendingReason ?? 'unknown',
        prep: pendingPrep ?? 'unknown',
        preSpawnMs,
        // Only the first start after a launch measures the app launch.
        sinceAppStartMs: appStartedAt === null ? null : at - appStartedAt - preSpawnMs,
        marks: {},
        plugins: null,
        ready: null,
        waitMs: null,
        checkpoint: null,
        checkpointChanged: null,
      };
      appStartedAt = null;
      pendingReason = null;
      pendingPrep = null;
      continue;
    }
    if (current && (match = MILESTONE_RE.exec(message))) {
      const sinceSpawn = Number(match[1]);
      for (const key of matchGatewayMilestones(match[2])) {
        if (current.marks[key] === undefined) current.marks[key] = sinceSpawn;
      }
      current.plugins = current.plugins ?? parseLoadedPlugins(match[2]);
      continue;
    }
    if (current && (match = WAIT_RETURNED_RE.exec(message))) {
      current.ready = match[2] === 'true';
      current.waitMs = Number(match[1]);
      // waitForGatewayReady's elapsed counts from startGateway, not the fork.
      if (current.ready) current.marks.probeReady = Math.max(0, at - current.spawnedAt);
      continue;
    }
    if (current && (match = SUMMARY_RE.exec(message))) {
      current.checkpoint = match[2];
      current.checkpointChanged = match[3] ? match[3].split(',') : null;
      finishAttempt();
      continue;
    }
    if ((match = STOP_REQUESTED_RE.exec(message))) {
      stopping = { pid: match[1], requestedAt: at, startedAt: line[1], killed: false };
      continue;
    }
    if (stopping && SIGKILL_RE.test(message)) { stopping.killed = true; continue; }
    if (stopping && (match = PROCESS_EXITED_RE.exec(message))) {
      shutdowns.push({
        pid: stopping.pid,
        startedAt: stopping.startedAt,
        durationMs: at - stopping.requestedAt,
        killed: stopping.killed || match[2] === 'SIGKILL',
      });
      stopping = null;
    }
  }
  finishAttempt();
  return { attempts, shutdowns };
}

module.exports = {
  GATEWAY_MILESTONES,
  STARTUP_MIGRATION_CHECKPOINT_PARTS,
  compareStartupCheckpoints,
  summarizeCpuProfile,
  STARTUP_PHASES,
  computeStartupPhases,
  matchGatewayMilestones,
  median,
  parseLoadedPlugins,
  parseMainLogStartups,
  stripAnsi,
};
