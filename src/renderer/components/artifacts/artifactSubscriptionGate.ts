import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';

export const ArtifactSubscriptionFeature = {
  Share: 'share',
  Deployment: 'deployment',
} as const;

export type ArtifactSubscriptionFeature =
  (typeof ArtifactSubscriptionFeature)[keyof typeof ArtifactSubscriptionFeature];

export const ArtifactSubscriptionBlockReason = {
  LoginRequired: 'login_required',
  SubscriptionRequired: 'subscription_required',
  EnterpriseUnavailable: 'enterprise_unavailable',
} as const;

export type ArtifactSubscriptionBlockReason =
  (typeof ArtifactSubscriptionBlockReason)[keyof typeof ArtifactSubscriptionBlockReason];

export interface ArtifactSubscriptionPromptState {
  feature: ArtifactSubscriptionFeature;
  reason: ArtifactSubscriptionBlockReason;
}

export interface ArtifactSubscriptionSnapshot {
  isLoggedIn: boolean;
  subscriptionStatus?: string | null;
  accountMode?: string | null;
  shareEntitled?: boolean;
  deploymentEntitled?: boolean;
}

export type ArtifactSubscriptionDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: ArtifactSubscriptionBlockReason;
    };

export interface ArtifactSubscriptionPromptCopyKeys {
  titleKey: string;
  messageKey: string;
}

const ARTIFACT_SUBSCRIPTION_PROMPT_COPY_KEYS: Record<
  ArtifactSubscriptionFeature,
  Record<ArtifactSubscriptionBlockReason, ArtifactSubscriptionPromptCopyKeys>
> = {
  [ArtifactSubscriptionFeature.Share]: {
    [ArtifactSubscriptionBlockReason.LoginRequired]: {
      titleKey: 'htmlShareLoginRequiredTitle',
      messageKey: 'htmlShareLoginRequiredMessage',
    },
    [ArtifactSubscriptionBlockReason.SubscriptionRequired]: {
      titleKey: 'htmlShareSubscriptionRequiredTitle',
      messageKey: 'htmlShareSubscriptionRequiredMessage',
    },
    [ArtifactSubscriptionBlockReason.EnterpriseUnavailable]: {
      titleKey: 'htmlShareEnterpriseUnavailableTitle',
      messageKey: 'htmlShareEnterpriseUnavailableMessage',
    },
  },
  [ArtifactSubscriptionFeature.Deployment]: {
    [ArtifactSubscriptionBlockReason.LoginRequired]: {
      titleKey: 'nodeDeploymentLoginRequiredTitle',
      messageKey: 'nodeDeploymentLoginRequiredMessage',
    },
    [ArtifactSubscriptionBlockReason.SubscriptionRequired]: {
      titleKey: 'nodeDeploymentSubscriptionRequiredTitle',
      messageKey: 'nodeDeploymentSubscriptionRequiredMessage',
    },
    [ArtifactSubscriptionBlockReason.EnterpriseUnavailable]: {
      titleKey: 'nodeDeploymentEnterpriseUnavailableTitle',
      messageKey: 'nodeDeploymentEnterpriseUnavailableMessage',
    },
  },
};

export function getArtifactSubscriptionDecision(
  snapshot: ArtifactSubscriptionSnapshot,
  feature: ArtifactSubscriptionFeature,
): ArtifactSubscriptionDecision {
  if (!snapshot.isLoggedIn) {
    return {
      allowed: false,
      reason: ArtifactSubscriptionBlockReason.LoginRequired,
    };
  }
  const isEnterprise = snapshot.accountMode === EnterpriseAccountMode.Enterprise
    || snapshot.subscriptionStatus === AuthSubscriptionStatus.Enterprise;
  if (isEnterprise) {
    const entitled = feature === ArtifactSubscriptionFeature.Share
      ? snapshot.shareEntitled
      : snapshot.deploymentEntitled;
    if (entitled === true) return { allowed: true };
    return {
      allowed: false,
      reason: ArtifactSubscriptionBlockReason.EnterpriseUnavailable,
    };
  }
  // Logged-in personal accounts are allowed through. The server resolves the
  // current subscription plan and enforces either free or subscriber quotas.
  return { allowed: true };
}

export async function resolveArtifactSubscriptionDecision(
  snapshot: ArtifactSubscriptionSnapshot,
  refreshSnapshot: () => Promise<ArtifactSubscriptionSnapshot>,
  feature: ArtifactSubscriptionFeature,
): Promise<ArtifactSubscriptionDecision> {
  const initialDecision = getArtifactSubscriptionDecision(snapshot, feature);
  if (initialDecision.allowed) return initialDecision;
  return getArtifactSubscriptionDecision(await refreshSnapshot(), feature);
}

export function getArtifactSubscriptionPromptCopyKeys(
  feature: ArtifactSubscriptionFeature,
  reason: ArtifactSubscriptionBlockReason,
): ArtifactSubscriptionPromptCopyKeys {
  return ARTIFACT_SUBSCRIPTION_PROMPT_COPY_KEYS[feature][reason];
}
