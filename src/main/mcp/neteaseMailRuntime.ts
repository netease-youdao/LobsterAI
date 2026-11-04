import { NeteaseMailRuntimeRpc } from '../../shared/neteaseMail/constants';
import type { OpenClawConfigRpcClient } from '../libs/openclawConfigDelivery';

/** Refresh the running gateway after an out-of-process credential mutation. */
export async function reloadNeteaseMailCredentials(
  ensureRpcClient: () => Promise<OpenClawConfigRpcClient | null>,
): Promise<boolean> {
  try {
    const client = await ensureRpcClient();
    if (!client) return false;
    const result = await client.request<{ ok: boolean; warningCount: number }>(
      NeteaseMailRuntimeRpc.ReloadCredentials, {}, { timeoutMs: 15_000 },
    );
    if (result?.ok !== true) return false;
    console.log('[NeteaseMail] Gateway credentials reloaded');
    return true;
  } catch {
    // Keep upstream credential/config diagnostics out of application logs.
    console.warn('[NeteaseMail] Gateway credential reload failed');
    return false;
  }
}
