import { describe, expect, test } from 'vitest';

import {
  AgentAvatarSvg,
  DefaultAgentAvatar,
  DefaultAgentAvatarIcon,
  encodeAgentAvatarIcon,
  normalizeAgentAvatarIcon,
  parseAgentAvatarIcon,
} from './avatar';

describe('agent avatar icon encoding', () => {
  test('round-trips svg avatar selections', () => {
    const value = encodeAgentAvatarIcon({
      svg: AgentAvatarSvg.Code,
    });

    expect(parseAgentAvatarIcon(value)).toEqual({
      svg: AgentAvatarSvg.Code,
    });
  });

  test('exposes the default svg avatar icon', () => {
    expect(parseAgentAvatarIcon(DefaultAgentAvatarIcon)).toEqual(DefaultAgentAvatar);
  });

  test('does not parse legacy emoji icons', () => {
    expect(parseAgentAvatarIcon('🤖')).toBeNull();
  });

  test('normalizes empty and legacy icons to the default svg avatar', () => {
    expect(normalizeAgentAvatarIcon('')).toBe(DefaultAgentAvatarIcon);
    expect(normalizeAgentAvatarIcon('🤖')).toBe(DefaultAgentAvatarIcon);
    expect(normalizeAgentAvatarIcon('legacy-icon')).toBe(DefaultAgentAvatarIcon);
    expect(normalizeAgentAvatarIcon('agent-avatar:blue:code')).toBe(DefaultAgentAvatarIcon);
    expect(normalizeAgentAvatarIcon('agent-avatar:blue:missing')).toBe(DefaultAgentAvatarIcon);
  });

  test('preserves valid svg avatars when normalizing', () => {
    const value = encodeAgentAvatarIcon({
      svg: AgentAvatarSvg.Brain,
    });

    expect(normalizeAgentAvatarIcon(` ${value} `)).toBe(value);
  });

  test('rejects malformed avatar values', () => {
    expect(parseAgentAvatarIcon('agent-avatar:code')).toBeNull();
    expect(parseAgentAvatarIcon('agent-avatar:blue:code')).toBeNull();
    expect(parseAgentAvatarIcon('agent-avatar:blue:missing')).toBeNull();
    expect(parseAgentAvatarIcon('agent-avatar:missing:code')).toBeNull();
    expect(parseAgentAvatarIcon('agent-avatar-svg:missing')).toBeNull();
  });
});
