/** Resolved IM delivery target extracted from a gateway cron "finished" event. */
export interface CronDeliveredTarget {
  channel: string;
  to: string;
  accountId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extracts the resolved delivery target from a cron event payload when the
 * run finished and its announce delivery actually went out. Cron deliveries
 * mirror into the target conversation's gateway transcript without bumping
 * the session's activity timestamp, so LobsterAI uses this signal to pull the
 * mirrored message into the mapped IM conversation record.
 *
 * Returns null for non-finished events, undelivered runs, or payloads without
 * a resolved channel target.
 */
export function extractCronDeliveredTarget(payload: unknown): CronDeliveredTarget | null {
  if (!isRecord(payload)) return null;
  if (payload.action !== 'finished') return null;

  const delivery = isRecord(payload.delivery) ? payload.delivery : null;
  const delivered = payload.delivered === true || delivery?.delivered === true;
  if (!delivered) return null;

  const resolved = delivery && isRecord(delivery.resolved) ? delivery.resolved : null;
  const channel = typeof resolved?.channel === 'string' ? resolved.channel.trim() : '';
  const to = typeof resolved?.to === 'string' ? resolved.to.trim() : '';
  if (!channel || !to) return null;

  const accountId =
    typeof resolved?.accountId === 'string' && resolved.accountId.trim()
      ? resolved.accountId.trim()
      : undefined;

  return { channel, to, ...(accountId ? { accountId } : {}) };
}
