import { describe, test } from 'vitest';

import { expectCurrentOpenClawPatchMissing } from './patchTestUtils';

describe('browser/web access OpenClaw patch decisions', () => {
  test('does not carry duplicate browser launch patch because OpenClaw 6.1 has upstream coverage', () => {
    expectCurrentOpenClawPatchMissing('openclaw-browser-duplicate-launch.patch');
  });

  test('does not carry legacy web fetch env proxy patch because LobsterAI no longer writes useEnvProxy', () => {
    expectCurrentOpenClawPatchMissing('openclaw-web-fetch-env-proxy.patch');
  });
});
