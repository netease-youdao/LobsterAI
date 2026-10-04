// @vitest-environment jsdom
import { LobsterAIRequestCapability, ModelThinkingLevel } from '@shared/providers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '../services/i18n';
import type { Model } from '../store/slices/modelSlice';
import ModelSelector from './ModelSelector';

const fixture = vi.hoisted(() => ({ models: [] as Model[], dispatch: vi.fn() }));
vi.mock('react-redux', () => ({
  useDispatch: () => fixture.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      model: { defaultSelectedModel: fixture.models[0], availableModels: fixture.models },
      agent: { currentAgentId: 'test' },
      auth: { isLoggedIn: true },
    }),
}));

let root: Root;
let host: HTMLDivElement;
const change = vi.fn();
const route = (id: string, name = 'DeepSeek Flash', extra: Partial<Model> = {}): Model => ({
  id,
  name,
  isServerModel: true,
  providerKey: 'lobsteraiServer',
  ...extra,
});
const click = (button: Element) =>
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
function search(value: string) {
  const input = host.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function mount(models: Model[], value: Model | null = models[0]) {
  fixture.models = models;
  act(() =>
    root.render(
      React.createElement(ModelSelector, {
        value,
        onChange: change,
        thinkingLevel: ModelThinkingLevel.High,
      }),
    ),
  );
  click(host.querySelector('button')!);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  i18nService.setLanguage('en', { persist: false });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  change.mockClear();
  fixture.dispatch.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('opens the selected family and route, and sends the exact selected route', () => {
  const first = route('flash-a');
  const second = route('flash-b');
  mount([first, second, route('pro', 'DeepSeek Pro'), route('qwen', 'Qwen Flash')], second);
  const selected = host.querySelector('[aria-label="DeepSeek Flash · Route 2 · flash-b"]')!;
  expect(selected).toBeTruthy();
  click(selected);
  expect(change).toHaveBeenCalledWith(second, { group: 'server' });
  expect(host.querySelector('input')).toBeNull();
});

test('finds folded more-model entries and clears search with Escape before closing', () => {
  const hidden = route('claude-opus', 'Claude Opus', { moreModel: true });
  mount([route('flash'), hidden]);
  expect(host.textContent).not.toContain('Claude Opus');
  search('opus');
  click(host.querySelector('button[title$=" · claude-opus"]')!);
  expect(change.mock.calls[0][0]).toBe(hidden);
  click(host.querySelector('button')!);
  search('unknown');
  expect(host.querySelector('[role="status"]')?.textContent).toBe('No matching models');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(host.querySelector('input')?.value).toBe('');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(host.querySelector('input')).toBeNull();
});

test('resolves thinking options per route', () => {
  const high = route('high', undefined, {
    requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    thinkingConfig: {
      defaultLevel: ModelThinkingLevel.High,
      options: [{ level: ModelThinkingLevel.High, openclawLevel: ModelThinkingLevel.High }],
    },
  });
  const low = route('low', undefined, {
    requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    thinkingConfig: {
      defaultLevel: ModelThinkingLevel.Low,
      options: [{ level: ModelThinkingLevel.Low, openclawLevel: ModelThinkingLevel.Low }],
    },
  });
  mount([high, low]);
  click(host.querySelector('[aria-label="DeepSeek Flash · Route 2 · low"]')!);
  expect(change).toHaveBeenCalledWith(low, {
    group: 'server',
    thinkingLevel: ModelThinkingLevel.Low,
  });
});

test('updates an open selector when the language changes', () => {
  mount([route('flash')]);
  act(() => i18nService.setLanguage('zh', { persist: false }));
  expect(host.querySelector('input')?.placeholder).toBe('搜索模型、系列或服务商');
});

test('a restricted route cannot bypass the existing access prompt', () => {
  const first = route('allowed');
  const blocked = route('locked', undefined, { accessible: false });
  mount([first, blocked]);
  click(host.querySelector('[aria-label="DeepSeek Flash · Route 2 · locked"]')!);
  expect(change).not.toHaveBeenCalled();
  expect(host.querySelector('input')).toBeNull();
});
