import { describe, expect, test } from 'vitest';

import { DshPermissionPreset } from '../dshEngine/hostConstants';
import {
  buildImChannelPermissionKey,
  resolveImChannelPermissionPreset,
  updateImChannelPermissionPresets,
} from './permissionPolicy';

describe('im permissionPolicy', () => {
  test('builds scoped storage keys matching IM session mappings', () => {
    expect(buildImChannelPermissionKey('weixin')).toBe('weixin');
    expect(buildImChannelPermissionKey('weixin', 'default')).toBe('weixin');
    expect(buildImChannelPermissionKey('weixin', 'custom')).toBe('weixin');
    expect(buildImChannelPermissionKey('feishu', 'default')).toBe('feishu');
    expect(buildImChannelPermissionKey('feishu', 'bot-1')).toBe('feishu:bot-1');
    expect(buildImChannelPermissionKey('feishu:bot-1')).toBe('feishu:bot-1');
  });

  test('resolves exact instance preset, falls back to platform preset, and ignores invalid values', () => {
    const presets = {
      weixin: DshPermissionPreset.ReadOnly,
      feishu: DshPermissionPreset.WorkspaceWrite,
      'feishu:bot-vip': DshPermissionPreset.FullAccess,
      dingtalk: 'invalid-mode',
    };

    expect(resolveImChannelPermissionPreset(presets, 'weixin')).toBe(DshPermissionPreset.ReadOnly);
    expect(resolveImChannelPermissionPreset(presets, 'feishu', 'bot-vip')).toBe(DshPermissionPreset.FullAccess);
    expect(resolveImChannelPermissionPreset(presets, 'feishu:bot-vip')).toBe(DshPermissionPreset.FullAccess);
    expect(resolveImChannelPermissionPreset(presets, 'feishu', 'bot-other')).toBe(DshPermissionPreset.WorkspaceWrite);
    expect(resolveImChannelPermissionPreset(presets, 'dingtalk')).toBeNull();
    expect(resolveImChannelPermissionPreset(presets, 'telegram')).toBeNull();
    expect(resolveImChannelPermissionPreset(undefined, 'weixin')).toBeNull();
  });

  test('updates and clears channel permission presets immutably', () => {
    const initial = { weixin: DshPermissionPreset.ReadOnly };
    const added = updateImChannelPermissionPresets(initial, 'feishu:bot-1', DshPermissionPreset.WorkspaceWrite);
    expect(added).toEqual({
      weixin: DshPermissionPreset.ReadOnly,
      'feishu:bot-1': DshPermissionPreset.WorkspaceWrite,
    });
    expect(initial).toEqual({ weixin: DshPermissionPreset.ReadOnly });

    const cleared = updateImChannelPermissionPresets(added, 'weixin', null);
    expect(cleared).toEqual({
      'feishu:bot-1': DshPermissionPreset.WorkspaceWrite,
    });
  });
});
