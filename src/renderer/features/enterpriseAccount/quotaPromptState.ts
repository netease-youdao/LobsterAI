import type { EnterpriseQuotaReason } from '../../../shared/enterpriseAccount/constants';
import { EnterpriseQuotaMessageMetadataKey } from '../../../shared/enterpriseAccount/constants';
import { isEnterpriseQuotaReason } from '../../../shared/enterpriseAccount/quotaError';
import type { EnterpriseAccountContext } from '../../../shared/enterpriseAccount/types';
import type { Model } from '../../store/slices/modelSlice';
import {
  type CoworkMessage,
  type CoworkSession,
  CoworkSessionStatusValue,
} from '../../types/cowork';
import { resolveBlockingEnterpriseQuotaReason } from './modelQuotaGate';

export interface EnterpriseQuotaSignal {
  messageId: string;
  reason: EnterpriseQuotaReason;
}

export const findCurrentEnterpriseQuotaSignal = (
  session: CoworkSession | null,
  messages: CoworkMessage[] = session?.messages ?? [],
): EnterpriseQuotaSignal | null => {
  if (!session) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'user') return null;

    if (message.type === 'tool_result' && message.metadata?.isError === true) {
      const details = message.metadata.toolResultDetails;
      const detailsRecord = details && typeof details === 'object' && !Array.isArray(details)
        ? details as Record<string, unknown>
        : null;
      const reason = detailsRecord?.[EnterpriseQuotaMessageMetadataKey.Reason]
        ?? message.metadata[EnterpriseQuotaMessageMetadataKey.Reason];
      return isEnterpriseQuotaReason(reason)
        ? { messageId: message.id, reason }
        : null;
    }

    if (message.type !== 'system' || typeof message.metadata?.error !== 'string') {
      continue;
    }

    if (session.status !== CoworkSessionStatusValue.Error) return null;
    const reason = message.metadata[EnterpriseQuotaMessageMetadataKey.Reason];
    return isEnterpriseQuotaReason(reason)
      ? { messageId: message.id, reason }
      : null;
  }

  return null;
};

export const resolveActiveEnterpriseQuotaSignal = (
  historicalSignal: EnterpriseQuotaSignal | null,
  context: EnterpriseAccountContext | null,
  model: Pick<Model, 'isServerModel' | 'providerKey'> | null | undefined,
): EnterpriseQuotaSignal | null => {
  if (
    !historicalSignal
    || !context
    || context.quotaStatus.available !== false
  ) {
    return null;
  }

  const blockingReason = resolveBlockingEnterpriseQuotaReason(
    context.quotaStatus.reason,
    model,
  );
  return blockingReason
    ? { messageId: historicalSignal.messageId, reason: blockingReason }
    : null;
};
