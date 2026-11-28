import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/ops-rpc-helpers.mjs'),
).href;
const MODEL_BRIDGE_HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/model-bridge-helpers.mjs'),
).href;

type OpsRpcHelpers = {
  VALID_PERMISSION_PRESETS: Set<string>;
  deriveExternalTurnTraceId: (dshSessionId: string, seq: number) => string | undefined;
  extractExternalUserMessageText: (content: unknown) => string;
  mergeBoundSessionContext: (
    prev: Record<string, unknown>,
    payload: Record<string, unknown>,
    validPermissionPresets?: Set<string>,
  ) => {
    nextPreset: string | undefined;
    context: Record<string, unknown>;
  };
  resolveFallbackAgentContextForExternalSession: (
    state: Record<string, unknown>,
    cwd?: string,
    platform?: NodeJS.Platform,
  ) => Record<string, unknown>;
};

type ModelBridgeHelpers = {
  resolveRequestTurnTraceId: (
    request: { purpose?: unknown } | undefined,
    bound: Record<string, unknown> | undefined,
  ) => string | undefined;
  applyLobsterRequestHeaders: (params: {
    request?: { purpose?: unknown };
    headers: Headers;
    instanceId?: unknown;
    sessionId?: unknown;
    bound?: Record<string, unknown>;
    buildTraceParent: (traceId: string) => string;
  }) => void;
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

describe('ops-rpc-helpers resolveFallbackAgentContextForExternalSession', () => {
  test('matches exact agent workingDirectory, deepest nested directory, and falls back to main', async () => {
    const { resolveFallbackAgentContextForExternalSession } = await loadHelpers();
    const state = {
      defaultPermissionPreset: 'read-only',
      memoryEnabled: true,
      agents: new Map([
        ['main', {
          id: 'main',
          workingDirectory: '/Users/dev/workspace',
          allowedSkillIds: null,
          hostCapabilities: ['browser'],
          systemPrompt: 'Main persona',
        }],
        ['research', {
          id: 'research',
          workingDirectory: '/Users/dev/workspace/research',
          allowedSkillIds: ['web-search', 'notes'],
          hostCapabilities: ['media'],
          systemPrompt: 'Research persona',
        }],
      ]),
    };

    const exact = resolveFallbackAgentContextForExternalSession(
      state,
      '/Users/dev/workspace/research/',
      'darwin',
    );
    expect(exact).toMatchObject({
      agentId: 'research',
      workspaceDir: '/Users/dev/workspace/research/',
      allowedSkillIds: ['web-search', 'notes'],
      customSystemPrompt: 'Research persona',
      unlockedCapabilities: ['media'],
      permissionPreset: 'read-only',
      permissionPresetExplicit: false,
      memoryEnabled: true,
      externalDefaultFallback: true,
    });

    const nested = resolveFallbackAgentContextForExternalSession(
      state,
      '/Users/dev/workspace/research/subproject/src',
      'darwin',
    );
    expect(nested.agentId).toBe('research');
    expect(nested.workspaceDir).toBe('/Users/dev/workspace/research/subproject/src');

    const unmatched = resolveFallbackAgentContextForExternalSession(
      state,
      '/tmp/unrelated-folder',
      'darwin',
    );
    expect(unmatched).toMatchObject({
      agentId: 'main',
      workspaceDir: '/tmp/unrelated-folder',
      allowedSkillIds: null,
      customSystemPrompt: 'Main persona',
      unlockedCapabilities: ['browser'],
      permissionPreset: 'read-only',
      externalDefaultFallback: true,
    });
  });

  test('normalizes Windows paths case-insensitively and defaults permission preset safely', async () => {
    const { resolveFallbackAgentContextForExternalSession } = await loadHelpers();
    const state = {
      defaultPermissionPreset: 'invalid-value',
      memoryEnabled: false,
      agents: new Map([
        ['win-agent', {
          id: 'win-agent',
          workingDirectory: 'C:\\Users\\Dev\\Projects',
          allowedSkillIds: ['skill-a'],
        }],
      ]),
    };

    const matched = resolveFallbackAgentContextForExternalSession(
      state,
      'c:\\users\\dev\\projects\\demo',
      'win32',
    );
    expect(matched.agentId).toBe('win-agent');
    expect(matched.permissionPreset).toBe('workspace-write');
    expect(matched.memoryEnabled).toBe(false);
  });

  test('explicit bindSessionContext cleanly overrides fallback defaults', async () => {
    const { mergeBoundSessionContext, resolveFallbackAgentContextForExternalSession } = await loadHelpers();
    const fallback = resolveFallbackAgentContextForExternalSession(
      {
        defaultPermissionPreset: 'workspace-write',
        memoryEnabled: true,
        agents: new Map([
          ['main', { id: 'main', workingDirectory: '/work', systemPrompt: 'Fallback prompt' }],
        ]),
      },
      '/work',
      'darwin',
    );

    const { context } = mergeBoundSessionContext(fallback, {
      agentId: 'coder',
      coworkSessionId: 'cw-123',
      customSystemPrompt: '',
      permissionPreset: 'danger-full-access',
      permissionPresetExplicit: true,
    });

    expect(context.agentId).toBe('coder');
    expect(context.coworkSessionId).toBe('cw-123');
    expect(context.customSystemPrompt).toBe('');
    expect(context.permissionPreset).toBe('danger-full-access');
    expect(context.permissionPresetExplicit).toBe(true);
  });

  test('external turn traceId overrides stale desktop traceId and clears on desktop takeover', async () => {
    const {
      deriveExternalTurnTraceId,
      extractExternalUserMessageText,
      mergeBoundSessionContext,
    } = await loadHelpers();
    const { applyLobsterRequestHeaders, resolveRequestTurnTraceId } =
      (await import(MODEL_BRIDGE_HELPERS_URL)) as ModelBridgeHelpers;

    const extTraceId = deriveExternalTurnTraceId('session-abc', 9);
    expect(extTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(extTraceId).toBe(deriveExternalTurnTraceId('session-abc', 9));
    expect(extTraceId).not.toBe(deriveExternalTurnTraceId('session-abc', 10));

    const userText = extractExternalUserMessageText([{ type: 'text', text: '  Hello from pocket  ' }]);
    expect(userText).toBe('Hello from pocket');

    const boundWithExternalTurn = {
      coworkSessionId: 'cw-1',
      dshSessionId: 'session-abc',
      traceId: 'a'.repeat(32),
      requestId: 'desktop-req-1',
      externalTurnActive: true,
      externalTurnTraceId: extTraceId,
      externalTurnUserText: userText,
    };

    expect(resolveRequestTurnTraceId({ purpose: 'agent-step' }, boundWithExternalTurn)).toBe(extTraceId);
    expect(resolveRequestTurnTraceId({ purpose: 'session-title' }, boundWithExternalTurn)).toBeUndefined();

    const headers = new Headers();
    applyLobsterRequestHeaders({
      request: { purpose: 'agent-step' },
      headers,
      instanceId: 'inst-1',
      sessionId: 'session-abc',
      bound: boundWithExternalTurn,
      buildTraceParent: (id) => `00-${id}-1111111111111111-01`,
    });
    expect(headers.get('traceparent')).toBe(`00-${extTraceId}-1111111111111111-01`);
    expect(headers.get('x-lobsterai-dsh-session')).toBe('session-abc');
    expect(headers.get('x-lobsterai-session')).toBe('cw-1');
    expect(headers.get('x-lobsterai-external-user-message')).toBe(encodeURIComponent('Hello from pocket'));

    // Next LobsterAI desktop bindSessionContext clears externalTurnActive.
    const { context: desktopBound } = mergeBoundSessionContext(boundWithExternalTurn, {
      traceId: 'b'.repeat(32),
      requestId: 'desktop-req-2',
    });
    expect(desktopBound.externalTurnActive).toBe(false);
    expect(desktopBound.requestId).toBe('desktop-req-2');
    expect(resolveRequestTurnTraceId({ purpose: 'agent-step' }, desktopBound)).toBe('b'.repeat(32));
  });
});
