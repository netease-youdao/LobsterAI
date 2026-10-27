import { OpenClawGatewayMethod } from './constants';

type GatewayClient = {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Abort acceptance alone is not proof: require a fresh, exact, inactive session row. */
export async function confirmOpenClawSessionStopped(
  client: GatewayClient,
  sessionKey: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    if (!sessionKey.trim() || !isCurrent()) return false;
    const result = await client.request(OpenClawGatewayMethod.SessionsAbort, {
      key: sessionKey,
      clearQueued: true,
    }, { timeoutMs: 15_000 });
    if (!isCurrent() || !record(result) || result.ok !== true) return false;
    const snapshot = await client.request(OpenClawGatewayMethod.SessionsList, {
      search: sessionKey,
      limit: 50,
      archived: 'all',
    }, { timeoutMs: 2_000 });
    if (!isCurrent() || !record(snapshot) || !Array.isArray(snapshot.sessions)) return false;
    const matches = snapshot.sessions.filter((value): value is Record<string, unknown> => record(value) && value.key === sessionKey);
    if (matches.length !== 1) return false;
    const row = matches[0];
    return row.hasActiveRun === false && (row.hasActiveSubagentRun === undefined || row.hasActiveSubagentRun === false);
  } catch {
    return false;
  }
}
