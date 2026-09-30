import { writeConfigDiagnostic } from './openclawConfigObservation';

/**
 * OpenClaw rewrites its config at read time when the file looks clobbered
 * (e.g. a >50% size drop against its last-known-good baseline, which a
 * sign-out causes by removing the plan model catalog) or invalid. It reports
 * this only as one warning line, and the gateway then runs a config LobsterAI
 * did not author: models and providers the user can no longer select.
 */

export const OpenClawConfigRestoreSource = {
  Backup: 'backup',
  LastKnownGood: 'last-known-good',
} as const;
export type OpenClawConfigRestoreSource =
  typeof OpenClawConfigRestoreSource[keyof typeof OpenClawConfigRestoreSource];

export type OpenClawConfigAutoRestore = {
  source: OpenClawConfigRestoreSource;
  /** OpenClaw's suspicion reasons, e.g. `size-drop-vs-last-good:33753->13837`. */
  reasons: string;
};

export type OpenClawConfigAutoRestoreEvent = OpenClawConfigAutoRestore & {
  gatewayGeneration: number;
};

export const OPENCLAW_CONFIG_AUTO_RESTORE_SYNC_REASON = 'config-auto-restored';

const AUTO_RESTORE_PATTERN = /Config auto-restored from (backup|last-known-good): (.*)$/;
// Reasons are the last parenthesized group; last-known-good appends "; Rejected validation details: ...".
const REASONS_PATTERN = /\(([^()]*)\)(?:;.*)?$/;

export function parseOpenClawConfigAutoRestore(output: string): OpenClawConfigAutoRestore | null {
  for (const line of output.split(/\r?\n/)) {
    const match = AUTO_RESTORE_PATTERN.exec(line.trimEnd());
    if (!match) continue;
    return {
      source: match[1] as OpenClawConfigRestoreSource,
      reasons: REASONS_PATTERN.exec(match[2])?.[1].trim() ?? '',
    };
  }
  return null;
}

/** Enough to converge after sign-in/sign-out cycles without a persistent failure respawning forever. */
const MAX_AUTO_RESTORE_RESYNCS = 3;

/**
 * Re-apply LobsterAI's config once per distinct restore. With the aligned
 * backup the restore rewrote identical bytes and the resync is a no-op;
 * otherwise config delivery replaces the restored file (restarting when the
 * gateway refuses the shrink). A repeated restore means the host write does
 * not stick, so stop rather than restart in a loop.
 */
export function createOpenClawConfigAutoRestoreHandler(deps: {
  isShuttingDown: () => boolean;
  resync: (reason: string) => void;
}): (event: OpenClawConfigAutoRestoreEvent) => void {
  const handled = new Set<string>();
  return (event) => {
    const signature = `${event.source}:${event.reasons}`;
    const repeated = handled.has(signature);
    const exhausted = !repeated && handled.size >= MAX_AUTO_RESTORE_RESYNCS;
    writeConfigDiagnostic({
      event: 'config-auto-restored',
      source: event.source,
      reasons: event.reasons,
      gatewayGeneration: event.gatewayGeneration,
      repeated,
    }, true);
    if (deps.isShuttingDown()) return;
    if (repeated || exhausted) {
      console.error(
        `[OpenClaw] Gateway restored its config from ${event.source} again (${event.reasons}); `
          + 'not resyncing to avoid a restart loop. The gateway may use models LobsterAI no longer offers.',
      );
      return;
    }
    handled.add(signature);
    console.warn(
      `[OpenClaw] Gateway restored its config from ${event.source} (${event.reasons}); re-applying LobsterAI config.`,
    );
    deps.resync(OPENCLAW_CONFIG_AUTO_RESTORE_SYNC_REASON);
  };
}
