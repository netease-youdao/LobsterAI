import { UsageOutcome, UsageStage } from '../shared/analytics/usage';
import { ConfirmationBehavior, MediaConfirmationReason, type MediaConfirmationResponse } from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import type { AskUserRequest } from './libs/mcpBridgeServer';

type Translate = (key: string, params?: Record<string, string | number>) => string;
const ImageBillingUnit = { PerImage: 'per_image' } as const;

/** Missing, malformed, denied, or free-text replies never authorize a paid submission. */
export function isMediaGenerationConfirmed(response: unknown, question: string, acceptLabel: string): boolean {
  if (!response || typeof response !== 'object') return false;
  const result = response as { behavior?: unknown; answers?: Record<string, unknown> };
  return result.behavior === ConfirmationBehavior.Allow && result.answers?.[question] === acceptLabel;
}

export function imageConfirmationQuestions(
  model: { pricingDescription?: string; pricing?: Record<string, unknown> },
  t: Translate,
): AskUserRequest['questions'] {
  const price = model.pricing?.costYuan;
  const rate = model.pricing?.billingUnit === ImageBillingUnit.PerImage && !model.pricing.tiers
    && typeof price === 'number' && Number.isFinite(price) && price >= 0
    ? t('mediaImageConfirmUnitPrice', { credits: Math.round(price * 10000) / 100 }) : undefined;
  return [{
    question: t('mediaExtraImageConfirmDescription'),
    title: t('mediaExtraImageConfirmTitle'),
    subtitle: [rate, model.pricingDescription?.trim()].filter(Boolean).join('\n') || t('mediaImageConfirmCostUnknown'),
    quoteKey: JSON.stringify(model.pricing ?? null),
    options: [
      { label: t('mediaVideoConfirmAccept'), description: t('mediaVideoConfirmStart') },
      { label: t('mediaVideoConfirmCancel'), description: t('mediaVideoConfirmLater') },
    ],
  }];
}

export function imageConfirmationFailure(response: MediaConfirmationResponse | null, t: Translate) {
  const reason = response?.reason ?? MediaConfirmationReason.NoRoute;
  const timeout = reason === MediaConfirmationReason.Timeout || reason === MediaConfirmationReason.NotDisplayed;
  const interrupted = reason === MediaConfirmationReason.Interrupted || reason === MediaConfirmationReason.AccountChanged;
  const declined = reason === MediaConfirmationReason.UserCancelled || reason === MediaConfirmationReason.Skipped
    || reason === MediaConfirmationReason.InvalidAnswer;
  return {
    isError: true,
    content: [{ type: 'text', text: t(timeout ? 'mediaImageConfirmationTimedOut'
      : reason === MediaConfirmationReason.UserCancelled ? 'mediaExtraImageDeclined' : 'mediaImageConfirmationUnavailable') }],
    details: {
      status: timeout ? MediaTaskStatus.Timeout : interrupted ? UsageOutcome.Interrupted
        : declined ? MediaTaskStatus.Cancelled : MediaTaskStatus.Failed,
      reason, failureCode: reason, failureStage: UsageStage.Confirmation,
    },
  };
}
