import { describe, expect, test } from 'vitest';

import { validRemoteTelemetryUi } from './telemetryUi';

const input = { expectedAccountEpoch: 'owner-epoch', uiInteractionId: '00000000-0000-4000-8000-000000000001',
  uiAction: 'enable', uiStage: 'click', surface: 'settings' };
describe('remote UI telemetry IPC', () => {
  test('accepts the finite contract and rejects arbitrary action, identifier and account data', () => {
    expect(validRemoteTelemetryUi(input)).toBe(true);
    for (const patch of [{ uiAction: 'my prompt' }, { uiInteractionId: 'private-file-path' }, { expectedAccountEpoch: 123 },
      { uiStage: 'network' }, { surface: 'any-url' }, { outcome: 'private error' }]) expect(validRemoteTelemetryUi({ ...input, ...patch })).toBe(false);
    expect(validRemoteTelemetryUi(null)).toBe(false);
  });
});
