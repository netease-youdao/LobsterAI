import type { CoworkSessionStatus } from '../../coworkStore';

export function resolveChannelSessionTerminalStatus(rawStatus: string): CoworkSessionStatus | null {
  if (
    rawStatus === 'failed' ||
    rawStatus === 'killed' ||
    rawStatus === 'timeout' ||
    rawStatus === 'error'
  ) {
    return 'error';
  }
  if (rawStatus === 'done' || rawStatus === 'completed') return 'completed';
  return null;
}

/**
 * Decides the next local status for a channel-synced session from a gateway
 * `sessions.list` row.
 *
 * `hasActiveRun` is the gateway's live run tracker and is authoritative when
 * present. The row's `status` field persists OpenClaw's *subagent* run status
 * ("running"/"done"/…) and can linger on conversation entries, so it only
 * counts as "running" when the live tracker is unavailable — honoring a stale
 * "running" alongside `hasActiveRun: false` pinned IM conversation records to
 * 执行中 forever once cron deliveries mirrored into them.
 *
 * Returns null when the local status should stay unchanged.
 */
export function resolveChannelSessionNextStatus(input: {
  hasActiveRun: boolean | null;
  rawStatus: string;
  currentStatus: CoworkSessionStatus;
}): CoworkSessionStatus | null {
  const { hasActiveRun, rawStatus, currentStatus } = input;

  if (hasActiveRun === true) return 'running';
  const terminalStatus = resolveChannelSessionTerminalStatus(rawStatus);
  if (terminalStatus) return terminalStatus;
  if (hasActiveRun === false) {
    return currentStatus === 'running' ? 'completed' : null;
  }
  // No live run flag on this row (older gateway): fall back to the raw status.
  return rawStatus === 'running' ? 'running' : null;
}
