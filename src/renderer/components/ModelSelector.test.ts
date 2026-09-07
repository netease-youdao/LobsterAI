import { LobsterAIRequestCapability } from '@shared/providers/lobsterAIRequestOptions';
import { ModelThinkingLevel } from '@shared/providers/modelThinking';
import { expect, test } from 'vitest';

import {
  canConfigureModelThinking,
  CascadeSide,
  countVisibleModelSelectorRows,
  isModelAgenticBlocked,
  partitionModelSelectorModels,
  resolveCascadePlacement,
  resolveDropdownListMaxHeight,
  resolveHoverCardTop,
  resolveNestedCascadePlacement,
  resolvePickerThinkingLevel,
  shouldRenderSelectedModelUnavailableFallback,
  supportsConfigurableModelThinkingProtocol,
} from './ModelSelector';

test('keeps a logged-in stale server model visible only while the model list is empty', () => {
  const selectedModel = {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    isServerModel: true,
  };

  expect(shouldRenderSelectedModelUnavailableFallback(0, selectedModel, true)).toBe(true);
  expect(shouldRenderSelectedModelUnavailableFallback(1, selectedModel, true)).toBe(false);
  expect(shouldRenderSelectedModelUnavailableFallback(0, selectedModel, false)).toBe(false);
  expect(shouldRenderSelectedModelUnavailableFallback(0, {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
  }, true)).toBe(false);
  expect(shouldRenderSelectedModelUnavailableFallback(0, null, true)).toBe(false);
});

test('keeps primary and more-model order stable while moving the folded group last', () => {
  const primaryFirst = { id: 'primary-1', name: 'Primary 1' };
  const moreFirst = { id: 'more-1', name: 'More 1', moreModel: true };
  const primarySecond = { id: 'primary-2', name: 'Primary 2' };
  const moreSecond = { id: 'more-2', name: 'More 2', moreModel: true };

  expect(partitionModelSelectorModels([
    primaryFirst,
    moreFirst,
    primarySecond,
    moreSecond,
  ])).toEqual({
    primaryModels: [primaryFirst, primarySecond],
    moreModels: [moreFirst, moreSecond],
  });
});

test('counts a collapsed more-model section as one row until expanded', () => {
  const models = [
    { id: 'primary', name: 'Primary' },
    { id: 'more-1', name: 'More 1', moreModel: true },
    { id: 'more-2', name: 'More 2', moreModel: true },
  ];

  expect(countVisibleModelSelectorRows(models, false)).toBe(2);
  expect(countVisibleModelSelectorRows(models, true)).toBe(4);
});

test('keeps model hover card above the viewport bottom', () => {
  expect(resolveHoverCardTop(790, 260, 900)).toBe(632);
});

test('keeps model hover card below the viewport top margin', () => {
  expect(resolveHoverCardTop(-20, 120, 900)).toBe(8);
});

test('does not move a fully visible model hover card', () => {
  expect(resolveHoverCardTop(240, 180, 900)).toBe(240);
});

test('pins model hover card to the margin when it is taller than the viewport', () => {
  expect(resolveHoverCardTop(160, 1000, 900)).toBe(8);
});

test('places a cascaded popover flush against its anchor, without gap or overlap', () => {
  expect(resolveCascadePlacement({
    anchorLeft: 400,
    anchorRight: 700,
    width: 220,
    viewportWidth: 1200,
    preferredSide: CascadeSide.Right,
  })).toEqual({ left: 700, side: CascadeSide.Right });
});

test('flips a cascaded popover to the left when the right side does not fit', () => {
  expect(resolveCascadePlacement({
    anchorLeft: 700,
    anchorRight: 1000,
    width: 220,
    viewportWidth: 1100,
    preferredSide: CascadeSide.Right,
  })).toEqual({ left: 480, side: CascadeSide.Left });
});

test('keeps cascading towards the side the previous popover took', () => {
  expect(resolveCascadePlacement({
    anchorLeft: 300,
    anchorRight: 520,
    width: 210,
    viewportWidth: 1100,
    preferredSide: CascadeSide.Left,
  })).toEqual({ left: 90, side: CascadeSide.Left });
});

test('falls back to the opposite side when the preferred side has no room', () => {
  expect(resolveCascadePlacement({
    anchorLeft: 40,
    anchorRight: 260,
    width: 210,
    viewportWidth: 1100,
    preferredSide: CascadeSide.Left,
  })).toEqual({ left: 260, side: CascadeSide.Right });
});

test('clamps a cascaded popover inside the viewport when neither side fits', () => {
  expect(resolveCascadePlacement({
    anchorLeft: 20,
    anchorRight: 260,
    width: 210,
    viewportWidth: 280,
    preferredSide: CascadeSide.Right,
  })).toEqual({ left: 62, side: CascadeSide.Right });
});

test('overlays the hover card instead of flipping a third panel into the dropdown', () => {
  expect(resolveNestedCascadePlacement({
    anchorLeft: 572,
    anchorRight: 792,
    width: 210,
    viewportWidth: 800,
    preferredSide: CascadeSide.Right,
  })).toEqual({
    left: 572,
    side: CascadeSide.Right,
    overlaysAnchor: true,
  });
});

test('keeps a third panel cascading outward when the viewport has room', () => {
  expect(resolveNestedCascadePlacement({
    anchorLeft: 520,
    anchorRight: 740,
    width: 210,
    viewportWidth: 1200,
    preferredSide: CascadeSide.Right,
  })).toEqual({
    left: 740,
    side: CascadeSide.Right,
    overlaysAnchor: false,
  });
});

test('caps the model list at its default height when space allows', () => {
  expect(resolveDropdownListMaxHeight(600, true, true)).toBe(288);
});

test('shrinks the model list so group tabs and footer stay visible in short windows', () => {
  // 341px available minus tabs (49) + footer (33) + borders (2)
  expect(resolveDropdownListMaxHeight(341, true, true)).toBe(257);
});

test('keeps at least three model rows visible when space is extremely tight', () => {
  expect(resolveDropdownListMaxHeight(50, true, true)).toBe(116);
});

test('uses the full available space when tabs and footer are hidden', () => {
  expect(resolveDropdownListMaxHeight(200, false, false)).toBe(198);
});

const THINKING_CONFIG = {
  options: [
    { level: ModelThinkingLevel.Off, openclawLevel: 'off' as const },
    { level: ModelThinkingLevel.High, openclawLevel: 'high' as const },
    { level: ModelThinkingLevel.Max, openclawLevel: 'xhigh' as const },
  ],
  defaultLevel: ModelThinkingLevel.High,
};

test('shows the level the user is picking right now', () => {
  expect(resolvePickerThinkingLevel({
    config: THINKING_CONFIG,
    requestedLevel: ModelThinkingLevel.Max,
    selectedModelLevel: ModelThinkingLevel.Off,
    rememberedLevel: ModelThinkingLevel.High,
  })).toBe(ModelThinkingLevel.Max);
});

test('shows the persisted level for the model that is actually selected', () => {
  expect(resolvePickerThinkingLevel({
    config: THINKING_CONFIG,
    selectedModelLevel: ModelThinkingLevel.Max,
    rememberedLevel: ModelThinkingLevel.High,
  })).toBe(ModelThinkingLevel.Max);
});

test('keeps each unselected model on its own remembered level', () => {
  expect(resolvePickerThinkingLevel({
    config: THINKING_CONFIG,
    rememberedLevel: ModelThinkingLevel.Max,
  })).toBe(ModelThinkingLevel.Max);
  expect(resolvePickerThinkingLevel({
    config: THINKING_CONFIG,
    selectedModelLevel: null,
    rememberedLevel: ModelThinkingLevel.Off,
  })).toBe(ModelThinkingLevel.Off);
});

test('falls back to the model default when nothing was picked before', () => {
  expect(resolvePickerThinkingLevel({ config: THINKING_CONFIG })).toBe(ModelThinkingLevel.High);
});

test('ignores levels the model does not offer', () => {
  expect(resolvePickerThinkingLevel({
    config: THINKING_CONFIG,
    requestedLevel: ModelThinkingLevel.Minimal,
    rememberedLevel: ModelThinkingLevel.Low,
  })).toBe(ModelThinkingLevel.High);
});

test('blocks only explicitly unready server models from agent selection', () => {
  expect(isModelAgenticBlocked({
    isServerModel: true,
    runtimeProfile: 'moonshot-kimi-k3',
    agenticReady: false,
  })).toBe(true);
  expect(isModelAgenticBlocked({
    isServerModel: true,
    runtimeProfile: 'moonshot-kimi-k3',
  })).toBe(true);
  expect(isModelAgenticBlocked({
    isServerModel: true,
    runtimeProfile: 'moonshot-kimi-k3',
    agenticReady: true,
  })).toBe(false);
  expect(isModelAgenticBlocked({
    isServerModel: true,
    agenticReady: false,
  })).toBe(false);
  expect(isModelAgenticBlocked({
    isServerModel: false,
    runtimeProfile: 'moonshot-kimi-k3',
    agenticReady: false,
  })).toBe(false);
});

test('allows thinking changes only for capable, accessible, and ready models', () => {
  const thinkingConfig = {
    options: [
      { level: 'off' as const, openclawLevel: 'off' as const },
      { level: 'high' as const, openclawLevel: 'high' as const },
      { level: 'max' as const, openclawLevel: 'xhigh' as const },
    ],
    defaultLevel: 'high' as const,
  };
  expect(canConfigureModelThinking({
    accessible: true,
    isServerModel: true,
    requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    thinkingConfig: { options: thinkingConfig.options.map(option => ({ ...option })), defaultLevel: thinkingConfig.defaultLevel },
  })).toBe(true);
  expect(canConfigureModelThinking({
    accessible: true,
    isServerModel: true,
    thinkingConfig: { options: thinkingConfig.options.map(option => ({ ...option })), defaultLevel: thinkingConfig.defaultLevel },
  })).toBe(false);
  expect(canConfigureModelThinking({
    accessible: false,
    isServerModel: true,
    requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    thinkingConfig: { options: thinkingConfig.options.map(option => ({ ...option })), defaultLevel: thinkingConfig.defaultLevel },
  })).toBe(false);
  expect(canConfigureModelThinking({
    accessible: true,
    isServerModel: true,
    runtimeProfile: 'moonshot-kimi-k3',
    agenticReady: false,
    requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    thinkingConfig: { options: thinkingConfig.options.map(option => ({ ...option })), defaultLevel: thinkingConfig.defaultLevel },
  })).toBe(false);
  expect(canConfigureModelThinking({
    accessible: true,
    isServerModel: true,
    requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
  })).toBe(false);
});

test('hides the thinking protocol entry when request-options support is absent', () => {
  const thinkingConfig = {
    options: [
      { level: 'off' as const, openclawLevel: 'off' as const },
      { level: 'high' as const, openclawLevel: 'high' as const },
    ],
    defaultLevel: 'high' as const,
  };

  expect(supportsConfigurableModelThinkingProtocol({ thinkingConfig })).toBe(false);
  expect(supportsConfigurableModelThinkingProtocol({
    thinkingConfig,
    requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
  })).toBe(true);
});
