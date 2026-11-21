import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/ops-rpc-helpers.mjs'),
).href;

type OpsRpcHelpers = {
  VALID_PERMISSION_PRESETS: Set<string>;
  mergeBoundSessionContext: (
    prev: Record<string, unknown>,
    payload: Record<string, unknown>,
    validPermissionPresets?: Set<string>,
  ) => {
    nextPreset: string | undefined;
    context: Record<string, unknown>;
  };
};

let cachedHelpers: OpsRpcHelpers | null = null;
async function loadHelpers(): Promise<OpsRpcHelpers> {
  if (!cachedHelpers) {
    cachedHelpers = (await import(HELPERS_URL)) as OpsRpcHelpers;
  }
  return cachedHelpers;
}

describe('ops-rpc-helpers mergeBoundSessionContext', () => {
  test('clears previous turn Plan Mode customSystemPrompt when explicit empty string or null is bound', async () => {
    const { mergeBoundSessionContext } = await loadHelpers();

    const turn1 = mergeBoundSessionContext(
      {},
      {
        agentId: 'main',
        coworkSessionId: 'cw-1',
        customSystemPrompt: '# Plan Mode\nDo not write files.',
        permissionPreset: 'workspace-write',
      },
    );
    expect(turn1.context.customSystemPrompt).toBe('# Plan Mode\nDo not write files.');
    expect(turn1.nextPreset).toBe('workspace-write');

    // Turn 2: Confirm & Execute turns Plan Mode off with explicit empty string.
    const turn2 = mergeBoundSessionContext(turn1.context, {
      agentId: 'main',
      coworkSessionId: 'cw-1',
      customSystemPrompt: '',
    });
    expect(turn2.context.customSystemPrompt).toBe('');
    expect(turn2.context.permissionPreset).toBe('workspace-write');

    // Defensive null also clears customSystemPrompt.
    const turn3 = mergeBoundSessionContext(
      { customSystemPrompt: '# Plan Mode' },
      { customSystemPrompt: null },
    );
    expect(turn3.context.customSystemPrompt).toBe('');
  });

  test('preserves previous customSystemPrompt when omitted and merges unlockedCapabilities', async () => {
    const { mergeBoundSessionContext } = await loadHelpers();

    const merged = mergeBoundSessionContext(
      {
        customSystemPrompt: 'Base prompt',
        unlockedCapabilities: ['browser'],
        permissionPreset: 'read-only',
      },
      {
        traceId: 'trace-123',
        unlockedCapabilities: ['excel', 'browser'],
        permissionPreset: 'invalid-preset',
      },
    );

    expect(merged.nextPreset).toBeUndefined();
    expect(merged.context.customSystemPrompt).toBe('Base prompt');
    expect(merged.context.permissionPreset).toBe('read-only');
    expect(merged.context.traceId).toBe('trace-123');
    expect(merged.context.unlockedCapabilities).toEqual(['browser', 'excel']);
  });
});
