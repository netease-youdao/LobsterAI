import fs from 'fs';
import path from 'path';

import {
  OPENCLAW_LEGACY_DISCOVERY_KEY,
  OPENCLAW_RETIRED_GATEWAY_RELOAD_KEYS,
  OPENCLAW_STARTUP_COMPATIBILITY_ENTRY,
  OpenClawGatewayReloadMode,
} from '../../shared/openclawEngine/startupCompatibility';
import { OPENCLAW_STARTUP_MIGRATION_ENTRY } from '../../shared/openclawEngine/startupMigration';
import { NSP_CLAWGUARD } from '../plugins/nspClawguardCompatibility';

export const OPENCLAW_STARTUP_PREP_MARKER_FILE = 'startup-prep-marker.json';
// Revalidate periodically: some legacy inputs (workspace setup files) have no
// fixed probe path and can only appear through a downgrade or restore.
export const OPENCLAW_STARTUP_PREP_MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MARKER_VERSION = 1;
const MISSING_SIGNATURE = 'missing';
const LEGACY_RELOAD_MODES = new Set<string>([OpenClawGatewayReloadMode.LegacyHot, OpenClawGatewayReloadMode.LegacyRestart]);

type StartupPrepMarkerFile = {
  version: typeof MARKER_VERSION;
  identity: string;
  stateDatabase: string;
  createdAt: number;
  probes: Record<string, string>;
};

export type StartupPrepMarkerCheck = { valid: boolean; reason: string };

/** Size and mtime detect a legacy source that appeared, changed or was removed. */
export function readStartupPrepProbeSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.isDirectory() ? 'dir' : 'file'}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? MISSING_SIGNATURE : `error:${code ?? 'unknown'}`;
  }
}

/** A restored or replaced shared-state database gets a new file identity. */
function readStateDatabaseSignature(stateDir: string): string {
  try {
    const stat = fs.statSync(path.join(stateDir, 'state', 'openclaw.sqlite'));
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return MISSING_SIGNATURE;
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Changes whenever the runtime, the helpers or the app that ran them changes. */
export function resolveStartupPrepIdentity(runtimeRoot: string, appVersion: string): string {
  const runtimeVersion = (readJson(path.join(runtimeRoot, 'package.json')) as { version?: unknown } | null)?.version;
  const builtAt = (readJson(path.join(runtimeRoot, 'dist', 'build-info.json')) as { builtAt?: unknown } | null)?.builtAt;
  return JSON.stringify([
    appVersion,
    typeof runtimeVersion === 'string' ? runtimeVersion : null,
    typeof builtAt === 'string' ? builtAt : null,
    readStartupPrepProbeSignature(path.join(runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY)),
    readStartupPrepProbeSignature(path.join(runtimeRoot, OPENCLAW_STARTUP_MIGRATION_ENTRY)),
  ]);
}

/** Config states that the compatibility helper must handle on every start. */
export function configRequiresStartupCompatibility(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const { plugins, gateway } = config as {
    plugins?: { entries?: Record<string, { enabled?: unknown } | undefined> } & Record<string, unknown>;
    gateway?: { reload?: Record<string, unknown> };
  };
  if (plugins && Object.hasOwn(plugins, OPENCLAW_LEGACY_DISCOVERY_KEY)) return true;
  if (plugins?.entries?.[NSP_CLAWGUARD.Id]?.enabled === true) return true;
  const reload = gateway?.reload;
  if (!reload || typeof reload !== 'object') return false;
  return (typeof reload.mode === 'string' && LEGACY_RELOAD_MODES.has(reload.mode))
    || OPENCLAW_RETIRED_GATEWAY_RELOAD_KEYS.some(key => Object.hasOwn(reload, key));
}

/**
 * Records that both pre-spawn startup helpers found nothing to migrate, so
 * later starts can skip their process spawns until an input changes.
 */
export class OpenClawStartupPrepMarker {
  constructor(
    private readonly markerPath: string,
    private readonly stateDir: string,
  ) {}

  check(identity: string, now = Date.now()): StartupPrepMarkerCheck {
    const marker = readJson(this.markerPath) as Partial<StartupPrepMarkerFile> | null;
    if (!marker) return { valid: false, reason: 'no-marker' };
    if (marker.version !== MARKER_VERSION || typeof marker.createdAt !== 'number'
      || !marker.probes || typeof marker.probes !== 'object') {
      return { valid: false, reason: 'unreadable-marker' };
    }
    if (marker.identity !== identity) return { valid: false, reason: 'runtime-changed' };
    if (marker.createdAt > now || now - marker.createdAt > OPENCLAW_STARTUP_PREP_MARKER_MAX_AGE_MS) {
      return { valid: false, reason: 'expired' };
    }
    if (marker.stateDatabase !== readStateDatabaseSignature(this.stateDir)) {
      return { valid: false, reason: 'state-database-replaced' };
    }
    for (const [probePath, signature] of Object.entries(marker.probes)) {
      if (readStartupPrepProbeSignature(probePath) !== signature) {
        return { valid: false, reason: `legacy-input-changed:${path.basename(probePath)}` };
      }
    }
    return { valid: true, reason: 'unchanged' };
  }

  record(identity: string, probePaths: readonly string[], now = Date.now()): void {
    const marker: StartupPrepMarkerFile = {
      version: MARKER_VERSION,
      identity,
      stateDatabase: readStateDatabaseSignature(this.stateDir),
      createdAt: now,
      probes: Object.fromEntries([...new Set(probePaths)].sort()
        .map(probePath => [probePath, readStartupPrepProbeSignature(probePath)])),
    };
    const tempPath = `${this.markerPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, this.markerPath);
    } catch (error) {
      console.warn('[OpenClaw] failed to record the startup preparation marker:', error);
      try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    }
  }

  clear(reason: string): void {
    try {
      fs.rmSync(this.markerPath);
      console.log(`[OpenClaw] startup preparation marker cleared: ${reason}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[OpenClaw] failed to clear the startup preparation marker:', error);
      }
    }
  }
}
