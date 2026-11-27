import { DshDeliveryOutcome } from '../../../shared/dshEngine/hostConstants';
import type { CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';

/** Only a definitive pre-admission failure can be retried against the original row. */
export function getRetryableUserMessage(store: CoworkStore, sessionId: string, messageId: string, owner: string) {
  const message = store.getLatestUserMessage(sessionId);
  if (message?.id !== messageId || message.metadata?.dshDelivery !== DshDeliveryOutcome.Unsent
    || typeof message.metadata.requestId !== 'string' || !message.metadata.requestId
    || store.getSession(sessionId, 0)?.status === 'running') throw new Error(t('coworkUnsentRetryUnavailable'));
  if (message.metadata.submissionOwner !== owner) throw new Error(t('authAccountChanged'));
  return { message, requestId: message.metadata.requestId };
}
