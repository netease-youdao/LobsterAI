import { expect, test, vi } from 'vitest';

import { DshDeliveryOutcome } from '../../../shared/dshEngine/hostConstants';
import type { CoworkStore } from '../../coworkStore';
import { getRetryableUserMessage } from './prepareUnsentRetry';

vi.mock('../../i18n', () => ({ t: (key: string) => key }));

const storeFor = (delivery: DshDeliveryOutcome | null, status = 'idle') => ({
  getLatestUserMessage: () => ({ id: 'last', content: 'hello', metadata: { dshDelivery: delivery, submissionOwner: 'same', requestId: 'desktop-original' } }),
  getSession: () => ({ status }),
}) as unknown as CoworkStore;

test('only the latest confirmed unsent message can reuse its original request', () => {
  const store = storeFor(DshDeliveryOutcome.Unsent);
  expect(getRetryableUserMessage(store, 'chat', 'last', 'same').requestId).toBe('desktop-original');
  expect(() => getRetryableUserMessage(store, 'chat', 'older', 'same')).toThrow();
  expect(() => getRetryableUserMessage(store, 'chat', 'last', 'different')).toThrow();
  expect(() => getRetryableUserMessage(storeFor(DshDeliveryOutcome.Unsent, 'running'), 'chat', 'last', 'same')).toThrow();
});

test.each([null, DshDeliveryOutcome.Unconfirmed, DshDeliveryOutcome.Interrupted, DshDeliveryOutcome.Cancelled])(
  'delivery state %s cannot be submitted again', delivery => {
    expect(() => getRetryableUserMessage(storeFor(delivery), 'chat', 'last', 'same')).toThrow();
  },
);
