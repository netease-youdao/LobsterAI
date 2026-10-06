import { PublishingResourceKind } from '@shared/publishing/constants';
import { describe, expect, test } from 'vitest';

import {
  resolvePublishingAccountTransition,
  shouldCompleteLocalServiceDeploymentRequestForQuota,
} from './localServiceDeploymentRequestLifecycle';

describe('localServiceDeploymentRequestLifecycle', () => {
  test('does not consume a request when the account context is unchanged', () => {
    expect(resolvePublishingAccountTransition(
      { accountGeneration: 3, ownerAccountKey: 'account-a' },
      { accountGeneration: 3, ownerAccountKey: 'account-a' },
      7,
    )).toEqual({
      changed: false,
      staleLocalServiceDeploymentRequestId: null,
    });
  });

  test.each([
    [
      { accountGeneration: 3, ownerAccountKey: 'account-a' },
      { accountGeneration: 4, ownerAccountKey: null },
    ],
    [
      { accountGeneration: 3, ownerAccountKey: 'account-a' },
      { accountGeneration: 4, ownerAccountKey: 'account-b' },
    ],
    [
      { accountGeneration: 3, ownerAccountKey: 'account-a' },
      { accountGeneration: 4, ownerAccountKey: 'account-a' },
    ],
  ])('invalidates a pending request when the account context changes', (previous, current) => {
    expect(resolvePublishingAccountTransition(previous, current, 7)).toEqual({
      changed: true,
      staleLocalServiceDeploymentRequestId: 7,
    });
  });

  test('completes only site quota dialogs as local-service deployment requests', () => {
    expect(shouldCompleteLocalServiceDeploymentRequestForQuota(
      PublishingResourceKind.Site,
    )).toBe(true);
    expect(shouldCompleteLocalServiceDeploymentRequestForQuota(
      PublishingResourceKind.File,
    )).toBe(false);
  });
});
