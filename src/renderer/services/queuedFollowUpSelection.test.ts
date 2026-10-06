import { describe, expect, test } from 'vitest';

import {
  type CoworkPendingSteer,
  CoworkSteerStatus,
} from '../../shared/cowork/steer';
import { selectQueuedFollowUp } from './queuedFollowUpSelection';

const makePendingSteer = (id: string): CoworkPendingSteer => ({
  id,
  sessionId: 'session-1',
  ownerAccountKey: 'personal:6',
  accountGeneration: 1,
  text: `message-${id}`,
  status: CoworkSteerStatus.Pending,
  createdAt: 1,
  updatedAt: 1,
});

describe('selectQueuedFollowUp', () => {
  const pendingSteers = [
    makePendingSteer('steer-1'),
    makePendingSteer('steer-2'),
    makePendingSteer('steer-3'),
  ];

  test('selects only the requested queued follow-up', () => {
    expect(selectQueuedFollowUp(pendingSteers, 'steer-2')).toBe(pendingSteers[1]);
  });

  test('selects the first queued follow-up when processing the queue naturally', () => {
    expect(selectQueuedFollowUp(pendingSteers)).toBe(pendingSteers[0]);
  });

  test('does not fall back to another follow-up when the requested item no longer exists', () => {
    expect(selectQueuedFollowUp(pendingSteers, 'steer-missing')).toBeUndefined();
  });

  test('returns undefined for an empty queue', () => {
    expect(selectQueuedFollowUp([])).toBeUndefined();
  });
});
