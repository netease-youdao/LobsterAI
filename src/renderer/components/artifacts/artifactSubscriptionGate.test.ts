import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { describe, expect, test, vi } from 'vitest';

import {
  ArtifactSubscriptionBlockReason,
  ArtifactSubscriptionFeature,
  getArtifactSubscriptionDecision,
  getArtifactSubscriptionPromptCopyKeys,
  resolveArtifactSubscriptionDecision,
} from './artifactSubscriptionGate';

describe('artifactSubscriptionGate', () => {
  test('allows an active subscriber without refreshing auth state', async () => {
    const refreshSnapshot = vi.fn();
    await expect(resolveArtifactSubscriptionDecision({
      isLoggedIn: true,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    }, refreshSnapshot, ArtifactSubscriptionFeature.Share)).resolves.toEqual({ allowed: true });
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });

  test('allows a logged-in free user without refreshing auth state', async () => {
    const refreshSnapshot = vi.fn().mockResolvedValue({
      isLoggedIn: true,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await expect(resolveArtifactSubscriptionDecision({
      isLoggedIn: true,
      subscriptionStatus: AuthSubscriptionStatus.Free,
    }, refreshSnapshot, ArtifactSubscriptionFeature.Share)).resolves.toEqual({ allowed: true });
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });

  test('blocks logged-out users and allows logged-in personal users', () => {
    expect(getArtifactSubscriptionDecision({
      isLoggedIn: false,
      subscriptionStatus: AuthSubscriptionStatus.Free,
    }, ArtifactSubscriptionFeature.Share)).toEqual({
      allowed: false,
      reason: ArtifactSubscriptionBlockReason.LoginRequired,
    });
    expect(getArtifactSubscriptionDecision({
      isLoggedIn: true,
      subscriptionStatus: AuthSubscriptionStatus.Free,
      shareEntitled: false,
    }, ArtifactSubscriptionFeature.Share)).toEqual({ allowed: true });
  });

  test('allows enterprise sharing and deployment only from explicit server entitlements', () => {
    const enterpriseSnapshot = {
      isLoggedIn: true,
      subscriptionStatus: AuthSubscriptionStatus.Enterprise,
      accountMode: 'enterprise',
      shareEntitled: true,
      deploymentEntitled: true,
    };
    expect(getArtifactSubscriptionDecision(
      enterpriseSnapshot,
      ArtifactSubscriptionFeature.Share,
    )).toEqual({ allowed: true });
    expect(getArtifactSubscriptionDecision(
      enterpriseSnapshot,
      ArtifactSubscriptionFeature.Deployment,
    )).toEqual({ allowed: true });
  });

  test('fails closed for enterprise accounts when explicit entitlement is unavailable', () => {
    expect(getArtifactSubscriptionDecision({
      isLoggedIn: true,
      subscriptionStatus: AuthSubscriptionStatus.Enterprise,
      accountMode: 'enterprise',
    }, ArtifactSubscriptionFeature.Share)).toEqual({
      allowed: false,
      reason: ArtifactSubscriptionBlockReason.EnterpriseUnavailable,
    });
  });

  test.each([
    [
      ArtifactSubscriptionFeature.Share,
      ArtifactSubscriptionBlockReason.LoginRequired,
      'htmlShareLoginRequiredTitle',
    ],
    [
      ArtifactSubscriptionFeature.Share,
      ArtifactSubscriptionBlockReason.SubscriptionRequired,
      'htmlShareSubscriptionRequiredTitle',
    ],
    [
      ArtifactSubscriptionFeature.Deployment,
      ArtifactSubscriptionBlockReason.LoginRequired,
      'nodeDeploymentLoginRequiredTitle',
    ],
    [
      ArtifactSubscriptionFeature.Deployment,
      ArtifactSubscriptionBlockReason.SubscriptionRequired,
      'nodeDeploymentSubscriptionRequiredTitle',
    ],
    [
      ArtifactSubscriptionFeature.Share,
      ArtifactSubscriptionBlockReason.EnterpriseUnavailable,
      'htmlShareEnterpriseUnavailableTitle',
    ],
  ])('maps %s and %s to feature-specific copy', (feature, reason, expectedTitleKey) => {
    expect(getArtifactSubscriptionPromptCopyKeys(feature, reason).titleKey).toBe(expectedTitleKey);
  });
});
