import { describe, test } from 'vitest';

import { expectCurrentOpenClawPatchMissing } from './patchTestUtils';

describe('startup and diagnostics OpenClaw patch decisions', () => {
  test('does not carry gateway startup profiler patch because OpenClaw 6.1 has startup trace diagnostics', () => {
    expectCurrentOpenClawPatchMissing('openclaw-gateway-startup-profiler.patch');
  });

  test('does not carry first response timing logs patch because it was temporary diagnostics', () => {
    expectCurrentOpenClawPatchMissing('zz-openclaw-first-response-timing-logs.patch');
  });

  test('does not carry model pricing bootstrap patch because OpenClaw 6.1 gates pricing refresh upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-disable-model-pricing-bootstrap.patch');
  });

  test('does not carry facade runtime static import patch because OpenClaw 6.1 uses cached facade loader resolution', () => {
    expectCurrentOpenClawPatchMissing('openclaw-facade-runtime-static-import.patch');
  });

  test('does not carry jiti alias pre-normalization patch because OpenClaw 6.1 pre-normalizes aliases upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-jiti-alias-prenormalize.patch');
  });
});
