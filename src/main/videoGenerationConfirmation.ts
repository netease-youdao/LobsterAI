import { UsageOutcome, UsageStage } from '../shared/analytics/usage';
import {
  MediaConfirmationReason,
  type MediaConfirmationResponse,
} from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import { estimateVideoCredits } from '../shared/media/videoCreditEstimate';
import type { AskUserRequest } from './libs/mcpBridgeServer';

export type VideoConfirmationModel = {
  pricing?: Record<string, unknown>;
  pricingDescription?: string;
};
export interface VideoConfirmationInput {
  model: string;
  params: Record<string, unknown>;
  prompt: string;
  portalUrl: string;
}
type Translate = (key: string, params?: Record<string, string | number>) => string;

export function videoConfirmationQuestions(
  input: VideoConfirmationInput,
  model: VideoConfirmationModel,
  t: Translate,
): AskUserRequest['questions'] {
  const estimate = estimateVideoCredits(model.pricing, input.params);
  return [
    {
      question:
        t('mediaVideoConfirmDescription').replace('{url}', input.portalUrl) +
        '\n\n' +
        t('mediaVideoConfirmRequest', {
          model: input.model,
          resolution: String(input.params.resolution ?? '-'),
          duration: String(input.params.durationSeconds ?? '-'),
          prompt: input.prompt.slice(0, 500),
        }),
      title: t('mediaVideoConfirmTitle'),
      subtitle:
        estimate !== undefined
          ? t('mediaVideoConfirmCostEstimate', { credits: estimate })
          : [t('mediaVideoConfirmCostUnknown'), model.pricingDescription?.trim()]
              .filter(Boolean)
              .join('\n'),
      options: [
        { label: t('mediaVideoConfirmAccept'), description: t('mediaVideoConfirmStart') },
        { label: t('mediaVideoConfirmCancel'), description: t('mediaVideoConfirmLater') },
      ],
    },
  ];
}

export function videoConfirmationFailure(response: MediaConfirmationResponse | null, t: Translate) {
  const reason = response?.reason ?? MediaConfirmationReason.NoRoute;
  const timeout =
    reason === MediaConfirmationReason.Timeout || reason === MediaConfirmationReason.NotDisplayed;
  const interrupted = reason === MediaConfirmationReason.Interrupted || reason === MediaConfirmationReason.AccountChanged;
  const declined = reason === MediaConfirmationReason.UserCancelled || reason === MediaConfirmationReason.Skipped || reason === MediaConfirmationReason.InvalidAnswer;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: t(
          timeout
            ? 'mediaVideoConfirmationTimedOut'
            : reason === MediaConfirmationReason.UserCancelled
              ? 'mediaVideoConfirmationCancelled'
              : 'mediaVideoConfirmationUnavailable',
        ),
      },
    ],
    details: {
      status: timeout ? MediaTaskStatus.Timeout : interrupted ? UsageOutcome.Interrupted : declined ? MediaTaskStatus.Cancelled : MediaTaskStatus.Failed,
      reason,
      failureCode: reason,
      failureStage: UsageStage.Confirmation,
    },
  };
}
