import { expect, test } from 'vitest';

import { type ConfigDeliveryReceipt,ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';
import { guardConfigReceiptGeneration } from './openclawConfigReceiptGeneration';

const receipt: ConfigDeliveryReceipt = { state: ConfigDeliveryState.Applied, mutationId: 'mutation-a',
  desiredRevision: 'revision-a', persistedRevision: 'revision-a', appliedRevision: 'revision-a', gatewayGeneration: 3 };

test('the same process retains its confirmed receipt', () => {
  expect(guardConfigReceiptGeneration(receipt, 3)).toBe(receipt);
});

test.each([4, 2])('generation %s cannot claim another process applied its candidate', generation => {
  expect(guardConfigReceiptGeneration(receipt, generation)).toEqual({ ...receipt,
    state: ConfigDeliveryState.Pending, appliedRevision: undefined });
  expect(receipt.state).toBe(ConfigDeliveryState.Applied);
});

test('late acknowledgements cannot restore applied after shutdown begins', () => {
  expect(guardConfigReceiptGeneration(receipt, 3, true).state).toBe(ConfigDeliveryState.Pending);
});

test('unversioned application is unconfirmed and pending preserves the original mutation', () => {
  const result = guardConfigReceiptGeneration({ ...receipt, gatewayGeneration: undefined }, 3);
  expect(result.state).toBe(ConfigDeliveryState.Pending);
  expect(result.mutationId).toBe('mutation-a');
  expect(guardConfigReceiptGeneration(result, 4)).toBe(result);
});
