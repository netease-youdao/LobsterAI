import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

import { expectCurrentOpenClawPatchMissing, expectPatchContains } from './patchTestUtils';

describe('Kimi K3 and model compatibility patch decisions', () => {
  test('drops the Moonshot K3 backport because v2026.8.1 ships native Kimi providers', () => {
    expectCurrentOpenClawPatchMissing('openclaw-kimi-k3-support.patch');
  });

  test('keeps the Kimi K3 request contract inside the compatibility extension', () => {
    // Upstream folded the K3 contract into createMoonshotThinkingWrapper and only
    // applies it to provider "moonshot". The retired backport was the sole source
    // of the createMoonshotKimiK3Wrapper SDK export, so the extension that serves
    // custom and package K3 models must carry the contract itself.
    const extensionEntry = fs.readFileSync(
      path.resolve('openclaw-extensions/lobsterai-model-compat/index.ts'),
      'utf8',
    );
    expect(extensionEntry).not.toContain('createMoonshotKimiK3Wrapper');
    expect(extensionEntry).toContain("from './kimiK3StreamWrapper'");
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
