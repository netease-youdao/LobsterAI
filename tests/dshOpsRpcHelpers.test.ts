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
    expect(merged.context.permissionPresetExplicit).toBe(false);
  });

  test('preserves and overrides permissionPresetExplicit independently of customSystemPrompt clears', async () => {
    const { mergeBoundSessionContext } = await loadHelpers();

    const explicit = mergeBoundSessionContext(
      {},
      {
        permissionPreset: 'danger-full-access',
        permissionPresetExplicit: true,
        customSystemPrompt: '# Plan Mode',
      },
    );
    expect(explicit.context.permissionPreset).toBe('danger-full-access');
    expect(explicit.context.permissionPresetExplicit).toBe(true);

    // Subsequent turn clears Plan Mode without specifying permissionPresetExplicit -> stays explicit.
    const nextTurn = mergeBoundSessionContext(explicit.context, {
      customSystemPrompt: '',
    });
    expect(nextTurn.context.customSystemPrompt).toBe('');
    expect(nextTurn.context.permissionPresetExplicit).toBe(true);

    // Explicit false clears the flag.
    const reset = mergeBoundSessionContext(nextTurn.context, {
      permissionPresetExplicit: false,
    });
    expect(reset.context.permissionPresetExplicit).toBe(false);
  });

  test('sets, preserves, and clears mediaTurnInstruction across turns', async () => {
    const { mergeBoundSessionContext } = await loadHelpers();

    const turn1 = mergeBoundSessionContext(
      {},
      {
        agentId: 'main',
        mediaTurnInstruction: 'For an explicit request to generate an image, use lobsterai_image_generate.',
      },
    );
    expect(turn1.context.mediaTurnInstruction).toContain('lobsterai_image_generate');

    // Non-turn context patch omitting mediaTurnInstruction keeps the bound instruction intact.
    const patched = mergeBoundSessionContext(turn1.context, {
      contextWindowOverride: 200_000,
    });
    expect(patched.context.mediaTurnInstruction).toBe(turn1.context.mediaTurnInstruction);

    // Explicit empty string or null clears mediaTurnInstruction on the next turn.
    const clearedEmpty = mergeBoundSessionContext(patched.context, {
      mediaTurnInstruction: '',
    });
    expect(clearedEmpty.context.mediaTurnInstruction).toBe('');

    const clearedNull = mergeBoundSessionContext(patched.context, {
      mediaTurnInstruction: null,
    });
    expect(clearedNull.context.mediaTurnInstruction).toBe('');
  });

  test('merges goalToolsEnabled monotonically once enabled in a session', async () => {
    const { mergeBoundSessionContext } = await loadHelpers();

    const nonGoal = mergeBoundSessionContext({}, { agentId: 'main' });
    expect(nonGoal.context.goalToolsEnabled).toBeUndefined();

    const enabled = mergeBoundSessionContext(nonGoal.context, { goalToolsEnabled: true });
    expect(enabled.context.goalToolsEnabled).toBe(true);

    // Subsequent ordinary turn in the same session keeps goal tools admitted for cache stability.
    const nextTurn = mergeBoundSessionContext(enabled.context, { goalToolsEnabled: false });
    expect(nextTurn.context.goalToolsEnabled).toBe(true);
  });
});
