import { describe, test } from 'vitest';

import { expectCurrentOpenClawPatchMissing, expectPatchContains } from './patchTestUtils';

describe('Kimi K3 and model compatibility patch decisions', () => {
  test('drops the Moonshot K3 backport because v2026.8.1 ships native Kimi providers', () => {
    expectCurrentOpenClawPatchMissing('openclaw-kimi-k3-support.patch');
  });

  test('keeps the plugin API owner separate from concrete model transports', () => {
    expectPatchContains('openclaw-lobsterai-model-compat-api.patch', [
      'LOBSTERAI_MODEL_COMPAT_API = "lobsterai-model-compat"',
      'MODEL_TRANSPORT_APIS',
      'ModelTransportApiSchema',
      'keeps a provider API owner out of model transport resolution',
      'rejects arbitrary provider API owner strings',
      'rejects compatibility ownership at model level',
    ]);
  });

  test('drops the replay-error backport because the packages/ai transport owns it upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-openai-compatible-replay-errors.patch');
  });

  test('drops the repeated tool-call ID backport because pairing is occurrence-aware upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-repeated-tool-call-id.patch');
  });
});
