import { describe, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectPatchContains,
} from './patchTestUtils';

describe('provider transport OpenClaw patch decisions', () => {
  test('does not carry extra_body passthrough patch because OpenClaw has upstream support', () => {
    expectCurrentOpenClawPatchMissing('openclaw-extra-body-passthrough.patch');
  });

  test('does not carry Codex native transport patch because OpenClaw routes ChatGPT Codex natively', () => {
    expectCurrentOpenClawPatchMissing('openclaw-codex-use-native-transport.patch');
  });

  test('does not carry DeepSeek V4 thinking mode patch because OpenClaw has upstream thinking wrappers', () => {
    expectCurrentOpenClawPatchMissing('openclaw-deepseek-v4-thinking-mode.patch');
  });

  test('does not carry DeepSeek/MiMo reasoning replay patch because OpenClaw has upstream replay hooks', () => {
    expectCurrentOpenClawPatchMissing('openclaw-deepseek-mimo-reasoning-replay.patch');
  });

  test('carries transient provider fetch retry patch for replayable no-response transport failures', () => {
    expectPatchContains('openclaw-provider-fetch-transient-retry.patch', [
      'TRANSIENT_PROVIDER_FETCH_ERROR_CODES = new Set([',
      '"UND_ERR_SOCKET"',
      '"UND_ERR_CONNECT_TIMEOUT"',
      'function isReplayableProviderFetchBody',
      'function shouldRetryProviderFetch',
      '[model-fetch] transient transport failure; retrying provider=',
      'retries a replayable request once after a transient transport failure',
      'gpt-5.4',
      'does not retry a transient failure when the body cannot be replayed',
    ]);
  });
});
