import { AgentSource } from '@shared/agent';
import {
  AgentAvatarSvg,
  DefaultAgentAvatar,
  DefaultAgentAvatarIcon,
  encodeAgentAvatarIcon,
} from '@shared/agent/avatar';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import AgentHomeHero from '../cowork/AgentHomeHero';
import AgentAvatarPicker from './AgentAvatarPicker';
import {
  AgentAvatarPickerAlign,
  AgentAvatarPickerVariant,
  AVATAR_PICKER_POPOVER_WIDTH_PX,
  computeAvatarPopoverPosition,
  resolveSelectedAvatarSvg,
} from './agentAvatarPickerHelpers';

describe('resolveSelectedAvatarSvg', () => {
  test('resolves encoded SVG avatars and falls back to default for empty values', () => {
    expect(resolveSelectedAvatarSvg(encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Folder }))).toBe(AgentAvatarSvg.Folder);
    expect(resolveSelectedAvatarSvg('')).toBe(DefaultAgentAvatar.svg);
    expect(resolveSelectedAvatarSvg(null)).toBe(DefaultAgentAvatar.svg);
  });

  test('returns null for preset image URLs and managed preset fallback avatars', () => {
    const presetImage = 'https://ydhardwarecommon.nosdn.127.net/category-office.webp';
    expect(resolveSelectedAvatarSvg(presetImage)).toBeNull();
    expect(resolveSelectedAvatarSvg(DefaultAgentAvatarIcon, true)).toBeNull();
    expect(resolveSelectedAvatarSvg(encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Creation }), true)).toBeNull();
  });
});

describe('computeAvatarPopoverPosition', () => {
  test('aligns start and center below the trigger when space permits', () => {
    const anchorRect = { left: 400, top: 180, right: 456, bottom: 236, width: 56, height: 56 };

    expect(computeAvatarPopoverPosition({
      anchorRect,
      popoverWidth: AVATAR_PICKER_POPOVER_WIDTH_PX,
      popoverHeight: 300,
      viewportWidth: 1200,
      viewportHeight: 800,
      align: AgentAvatarPickerAlign.Start,
    })).toEqual({
      left: 400,
      top: 244,
    });

    expect(computeAvatarPopoverPosition({
      anchorRect,
      popoverWidth: AVATAR_PICKER_POPOVER_WIDTH_PX,
      popoverHeight: 300,
      viewportWidth: 1200,
      viewportHeight: 800,
      align: AgentAvatarPickerAlign.Center,
    })).toEqual({
      left: 266,
      top: 244,
    });
  });

  test('clamps horizontally inside viewport edges', () => {
    const nearLeft = computeAvatarPopoverPosition({
      anchorRect: { left: 20, top: 100, right: 76, bottom: 156, width: 56, height: 56 },
      popoverWidth: 324,
      popoverHeight: 300,
      viewportWidth: 800,
      viewportHeight: 800,
      align: AgentAvatarPickerAlign.Center,
    });
    expect(nearLeft.left).toBe(8);

    const nearRight = computeAvatarPopoverPosition({
      anchorRect: { left: 720, top: 100, right: 776, bottom: 156, width: 56, height: 56 },
      popoverWidth: 324,
      popoverHeight: 300,
      viewportWidth: 800,
      viewportHeight: 800,
      align: AgentAvatarPickerAlign.Center,
    });
    expect(nearRight.left).toBe(800 - 324 - 8);
  });

  test('flips above the trigger when space below is insufficient and above has more room', () => {
    const position = computeAvatarPopoverPosition({
      anchorRect: { left: 400, top: 520, right: 456, bottom: 576, width: 56, height: 56 },
      popoverWidth: 324,
      popoverHeight: 300,
      viewportWidth: 1200,
      viewportHeight: 700,
      align: AgentAvatarPickerAlign.Center,
    });
    expect(position.top).toBe(520 - 300 - 8);
  });
});

describe('AgentAvatarPicker and AgentHomeHero rendering', () => {
  test('renders hero variant button without duplicate native title when tooltip is set', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentAvatarPicker, {
        value: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Folder }),
        onChange: () => {},
        variant: AgentAvatarPickerVariant.Hero,
        tooltip: 'Change icon',
        ariaLabel: 'Change icon',
      }),
    );
    expect(html).toContain('aria-label="Change icon"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('title="Change icon"');
    expect(html).toContain('h-14 w-14');
  });

  test('AgentHomeHero renders an interactive icon trigger when onChangeIcon is provided', () => {
    const baseProps = {
      agent: {
        id: 'obsidian-agent',
        name: 'Obsidian 管理大师',
        icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Folder }),
        workingDirectory: '/vault',
        source: AgentSource.Custom,
        skillIds: [],
      },
      effectiveWorkingDirectory: '/vault',
      onOpenSettings: () => {},
      onUsePrompt: () => {},
    };

    const interactiveHtml = renderToStaticMarkup(
      React.createElement(AgentHomeHero, {
        ...baseProps,
        onChangeIcon: () => {},
      }),
    );
    expect(interactiveHtml).toContain('aria-haspopup="dialog"');

    const staticHtml = renderToStaticMarkup(
      React.createElement(AgentHomeHero, baseProps),
    );
    expect(staticHtml).not.toContain('aria-haspopup="dialog"');
  });

  test('AgentHomeHero hides quick-setup cards once systemPrompt is saved and keeps folder-scan hidden when no folder is bound', () => {
    const unboundFreshHtml = renderToStaticMarkup(
      React.createElement(AgentHomeHero, {
        agent: {
          id: 'weekly-agent',
          name: '周报助手',
          icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Folder }),
          workingDirectory: '',
          systemPrompt: '',
          identity: '',
          source: AgentSource.Custom,
          skillIds: [],
        },
        effectiveWorkingDirectory: '/Users/demo/lobsterai/project',
        onOpenSettings: () => {},
        onUsePrompt: () => {},
      }),
    );
    expect(unboundFreshHtml).toContain('聊几句，定制工作风格');
    expect(unboundFreshHtml).not.toContain('从工作目录总结规范');

    const configuredHtml = renderToStaticMarkup(
      React.createElement(AgentHomeHero, {
        agent: {
          id: 'weekly-agent',
          name: '周报助手',
          icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Folder }),
          workingDirectory: '',
          systemPrompt: '- 定位：周报整理助手',
          identity: '',
          source: AgentSource.Custom,
          skillIds: [],
        },
        effectiveWorkingDirectory: '/Users/demo/lobsterai/project',
        onOpenSettings: () => {},
        onUsePrompt: () => {},
      }),
    );
    expect(configuredHtml).not.toContain('聊几句，定制工作风格');
    expect(configuredHtml).not.toContain('从工作目录总结规范');
  });
});
