import { AgentId, AgentSource } from '@shared/agent';
import { AgentAvatarSvg, DefaultAgentAvatarIcon, encodeAgentAvatarIcon } from '@shared/agent/avatar';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { usesManagedPresetAvatar } from '../../utils/agentDisplay';
import AgentAvatarIcon from './AgentAvatarIcon';

const render = (id: string, source: AgentSource, icon: string, iconCustomized?: boolean) => renderToStaticMarkup(
  React.createElement(AgentAvatarIcon, { value: icon, expertFallback: usesManagedPresetAvatar({ id, source, icon, iconCustomized }) }),
);

test('preset experts use the bot for both empty and legacy normalized default avatars', () => {
  for (const icon of ['', DefaultAgentAvatarIcon]) {
    expect(render('office-expert', AgentSource.Preset, icon)).toContain('expert-default.webp');
  }
});

test('main and custom agents retain their existing default icons regardless of names or IDs', () => {
  for (const icon of ['', DefaultAgentAvatarIcon, 'agent-avatar-svg:code']) {
    expect(render(AgentId.Main, AgentSource.Preset, icon)).not.toContain('expert-default.webp');
    expect(render('office-expert', AgentSource.Custom, icon)).not.toContain('expert-default.webp');
  }
  expect(usesManagedPresetAvatar({ id: 'unknown-source' })).toBe(false);
});

test('explicit preset images and non-default SVGs take priority over the fallback', () => {
  const url = 'https://ydhardwarecommon.nosdn.127.net/expert.webp';
  expect(render('expert', AgentSource.Preset, url)).toContain(`src="${url}"`);
  expect(render('expert', AgentSource.Preset, url)).not.toContain('expert-default.webp');
  expect(render('expert', AgentSource.Preset, 'agent-avatar-svg:code'))
    .toBe(render('expert', AgentSource.Custom, 'agent-avatar-svg:code'));
  expect(render('expert', AgentSource.Preset, 'agent-avatar-svg:code')).not.toContain('expert-default.webp');
});

test('old template SVGs use the bot unless the user explicitly customized the avatar', () => {
  const icon = encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Creation });
  expect(render('content-writer', AgentSource.Preset, icon)).toContain('expert-default.webp');
  expect(render('content-writer', AgentSource.Preset, icon, true))
    .toBe(render('content-writer', AgentSource.Custom, icon));
  expect(render('content-writer', AgentSource.Preset, DefaultAgentAvatarIcon, true))
    .not.toContain('expert-default.webp');
});
