import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshPermissionPreset } from '../../shared/dshEngine/hostConstants';
import {
  DSH_PERMISSION_PRESET_CHANGED_EVENT,
  dshHostService,
  shouldApplyPermissionPresetEvent,
} from './dshHost';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldApplyPermissionPresetEvent', () => {
  test('isolates per-session events so Session B and Home ignore Session A switches', () => {
    const detail = {
      preset: DshPermissionPreset.FullAccess,
      defaultPreset: DshPermissionPreset.WorkspaceWrite,
      sessionId: 'session-a',
    };

    expect(shouldApplyPermissionPresetEvent('session-a', detail)).toEqual({
      apply: true,
      nextPreset: DshPermissionPreset.FullAccess,
    });
    expect(shouldApplyPermissionPresetEvent('session-b', detail)).toEqual({
      apply: false,
    });
    expect(shouldApplyPermissionPresetEvent(undefined, detail)).toEqual({
      apply: false,
    });
    expect(shouldApplyPermissionPresetEvent(null, detail)).toEqual({
      apply: false,
    });
  });

  test('applies global default events directly to Home and requests refetch for active sessions', () => {
    const detail = {
      preset: DshPermissionPreset.ReadOnly,
      defaultPreset: DshPermissionPreset.ReadOnly,
    };

    expect(shouldApplyPermissionPresetEvent(undefined, detail)).toEqual({
      apply: true,
      nextPreset: DshPermissionPreset.ReadOnly,
    });
    expect(shouldApplyPermissionPresetEvent('session-b', detail)).toEqual({
      apply: false,
      refetch: true,
    });
  });
});

describe('dshHostService.setPermissionPreset', () => {
  test('forwards sessionId and dispatches session-scoped event without clobbering defaultPreset', async () => {
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    const setPermissionPreset = vi.fn(async () => ({
      ok: true,
      preset: DshPermissionPreset.FullAccess,
      defaultPreset: DshPermissionPreset.WorkspaceWrite,
    }));

    vi.stubGlobal('CustomEvent', class MockCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      electron: { dshHost: { setPermissionPreset } },
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        dispatched.push(event);
        return true;
      },
    });

    await dshHostService.setPermissionPreset(DshPermissionPreset.FullAccess, 'session-a');

    expect(setPermissionPreset).toHaveBeenCalledWith(DshPermissionPreset.FullAccess, 'session-a');
    expect(dispatched).toEqual([
      {
        type: DSH_PERMISSION_PRESET_CHANGED_EVENT,
        detail: {
          preset: DshPermissionPreset.FullAccess,
          defaultPreset: DshPermissionPreset.WorkspaceWrite,
          sessionId: 'session-a',
        },
      },
    ]);
  });
});
