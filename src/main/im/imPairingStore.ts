import { z } from 'zod';

import {
  IMPairingFailure,
  type IMPairingListResult,
  OpenClawPairingMethod,
} from '../../shared/im/pairing';
import { PlatformRegistry } from '../../shared/platform';

export class IMPairingError extends Error {
  constructor(readonly code: IMPairingFailure) {
    super(code);
  }
}

export interface PairingGatewayClient {
  request<T>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
}

const RPC_TIMEOUT_MS = 10_000;
const gatewayListSchema = z.object({
  accounts: z.array(z.object({
    channel: z.string().min(1), accountId: z.string().min(1), allowFrom: z.array(z.string()),
  })),
  requests: z.array(z.object({
    requestId: z.string().min(1), channel: z.string().min(1), accountId: z.string().min(1),
    senderId: z.string().min(1), code: z.string().min(1),
    createdAt: z.string(), lastSeenAt: z.string(), metadata: z.record(z.string(), z.string()).optional(),
  })),
});

/** Read the Gateway's current pairing state, never a parallel JSON/SQLite store. */
export async function listPairingRequests(
  client: PairingGatewayClient | null,
  platform: string,
  accountId?: string,
): Promise<Omit<IMPairingListResult, 'success' | 'error'>> {
  if (!client) throw new IMPairingError(IMPairingFailure.Unavailable);
  const platformId = PlatformRegistry.platforms.find(value => value === platform);
  if (!platformId
    || (accountId !== undefined && (typeof accountId !== 'string' || !accountId.trim()))) {
    throw new IMPairingError(IMPairingFailure.InvalidTarget);
  }
  const channel = PlatformRegistry.channelOf(platformId);
  const account = accountId?.trim().toLowerCase();
  const result = gatewayListSchema.safeParse(await client.request(OpenClawPairingMethod.List, {
    channel, ...(account ? { accountId: account } : {}), includeCodes: true, includeAllowFrom: true,
  }, { timeoutMs: RPC_TIMEOUT_MS }));
  if (!result.success) throw new IMPairingError(IMPairingFailure.InvalidResponse);
  const { accounts, requests } = result.data;
  // Reject an unexpected scope instead of approving a code from another bot.
  if ([...accounts, ...requests].some(item => item.channel !== channel || (account && item.accountId !== account))
    || requests.some(request => !accounts.some(item => item.accountId === request.accountId))) {
    throw new IMPairingError(IMPairingFailure.InvalidResponse);
  }
  return {
    accounts,
    requests: requests.map(request => ({
      id: request.senderId, requestId: request.requestId, channel: request.channel, accountId: request.accountId,
      code: request.code, createdAt: request.createdAt, lastSeenAt: request.lastSeenAt,
      meta: { ...request.metadata, accountId: request.accountId },
    })),
    allowFrom: [...new Set(accounts.flatMap(item => item.allowFrom))],
  };
}

async function resolvePairingCode(
  client: PairingGatewayClient | null,
  platform: string,
  code: string,
  method: typeof OpenClawPairingMethod.Approve | typeof OpenClawPairingMethod.Dismiss,
  accountId?: string,
): Promise<void> {
  if (typeof code !== 'string' || !code.trim()) throw new IMPairingError(IMPairingFailure.NotFound);
  const state = await listPairingRequests(client, platform, accountId);
  const matches = state.requests.filter(request => request.code.toUpperCase() === code.trim().toUpperCase());
  if (!matches.length) throw new IMPairingError(IMPairingFailure.NotFound);
  if (matches.length !== 1) throw new IMPairingError(IMPairingFailure.Ambiguous);
  const { channel, accountId: requestAccount, requestId } = matches[0];
  // The official transaction rechecks expiry and identity after this lookup.
  // Do not bootstrap command ownership, notify a sender, or rewrite config.
  await client!.request(method, { channel, accountId: requestAccount, requestId }, { timeoutMs: RPC_TIMEOUT_MS });
}

export function approvePairingCode(client: PairingGatewayClient | null, platform: string, code: string, accountId?: string) {
  return resolvePairingCode(client, platform, code, OpenClawPairingMethod.Approve, accountId);
}

export function rejectPairingRequest(client: PairingGatewayClient | null, platform: string, code: string, accountId?: string) {
  return resolvePairingCode(client, platform, code, OpenClawPairingMethod.Dismiss, accountId);
}
