import {
  PublishingResourceKind,
  type PublishingResourceKind as PublishingResourceKindValue,
} from '@shared/publishing/constants';

export interface PublishingAccountContext {
  accountGeneration: number;
  ownerAccountKey: string | null;
}

export interface PublishingAccountTransition {
  changed: boolean;
  staleLocalServiceDeploymentRequestId: number | null;
}

export function resolvePublishingAccountTransition(
  previous: PublishingAccountContext,
  current: PublishingAccountContext,
  pendingLocalServiceDeploymentRequestId?: number | null,
): PublishingAccountTransition {
  const changed = previous.accountGeneration !== current.accountGeneration
    || previous.ownerAccountKey !== current.ownerAccountKey;
  return {
    changed,
    staleLocalServiceDeploymentRequestId:
      changed && pendingLocalServiceDeploymentRequestId != null
        ? pendingLocalServiceDeploymentRequestId
        : null,
  };
}

export function shouldCompleteLocalServiceDeploymentRequestForQuota(
  resourceKind: PublishingResourceKindValue,
): boolean {
  return resourceKind === PublishingResourceKind.Site;
}
