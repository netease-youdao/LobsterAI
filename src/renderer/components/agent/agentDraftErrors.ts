import { AgentDraftErrorCode } from '@shared/agent';

import { i18nService } from '../../services/i18n';

export function formatAgentDraftError(errorCode: AgentDraftErrorCode): string {
  switch (errorCode) {
    case AgentDraftErrorCode.EmptyInput:
      return i18nService.t('agentDraftErrorEmpty');
    case AgentDraftErrorCode.NoModel:
      return i18nService.t('agentDraftErrorNoModel');
    case AgentDraftErrorCode.UnsupportedModel:
      return i18nService.t('agentDraftErrorUnsupportedModel');
    case AgentDraftErrorCode.Timeout:
      return i18nService.t('agentDraftErrorTimeout');
    default:
      return i18nService.t('agentDraftErrorFailed');
  }
}
