import { expect, test } from 'vitest';

import { AgentAvatarSvg, DefaultAgentAvatarIcon, encodeAgentAvatarIcon } from './avatar';
import { AgentId, AgentSource } from './constants';
import { usesManagedPresetAvatar } from './presetAvatar';

test('legacy template defaults are recognized by preset identity, including renamed installations', () => {
  expect(usesManagedPresetAvatar({ id: 'renamed-id', presetId: 'data-advisor', source: AgentSource.Preset,
    icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Data }) })).toBe(true);
  expect(usesManagedPresetAvatar({ id: 'new-expert', source: AgentSource.Preset, icon: DefaultAgentAvatarIcon })).toBe(true);
});

test('legacy avatars differing from their shipped defaults remain user-owned', () => {
  expect(usesManagedPresetAvatar({ id: 'data-advisor', source: AgentSource.Preset,
    icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Creation }) })).toBe(false);
  expect(usesManagedPresetAvatar({ id: 'unknown-template', source: AgentSource.Preset,
    icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Data }) })).toBe(false);
  expect(usesManagedPresetAvatar({ id: 'data-advisor', source: AgentSource.Preset,
    icon: 'https://ydhardwarecommon.nosdn.127.net/user.webp' })).toBe(false);
  expect(usesManagedPresetAvatar({ id: 'data-advisor', source: AgentSource.Preset,
    icon: 'unknown-legacy-avatar-format' })).toBe(false);
});

test('explicit ownership survives later category changes or selecting a former default', () => {
  expect(usesManagedPresetAvatar({ id: 'data-advisor', source: AgentSource.Preset,
    icon: DefaultAgentAvatarIcon, iconCustomized: true })).toBe(false);
  expect(usesManagedPresetAvatar({ id: 'data-advisor', source: AgentSource.Preset,
    icon: 'https://ydhardwarecommon.nosdn.127.net/category-v2.webp', iconCustomized: false })).toBe(true);
});

test('main and user-created agents are never managed, even with colliding preset IDs or flags', () => {
  expect(usesManagedPresetAvatar({ id: AgentId.Main, source: AgentSource.Preset, iconCustomized: false })).toBe(false);
  expect(usesManagedPresetAvatar({ id: 'data-advisor', source: AgentSource.Custom, iconCustomized: false })).toBe(false);
  expect(usesManagedPresetAvatar(undefined)).toBe(false);
});
