// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { OpenClawProgressCard } from '../../../shared/cowork/progressCard';
import { i18nService } from '../../services/i18n';
import type { CoworkSession } from '../../types/cowork';
import OpenClawProgressCardDock, { OpenClawProgressCardView } from './OpenClawProgressCard';
import { CoworkItemStatus } from './progressActivity';
let host: HTMLDivElement, root: Root;
const card: OpenClawProgressCard = { sessionKey: 'a', revision: 1, updatedAt: Date.now(), markdown: '**Site**', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Build', status: 'in_progress' }, { step: 'Test', status: 'pending' }] };
beforeEach(() => { i18nService.setLanguage('zh', { persist: false }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (value = card, running = true) => act(() => root.render(React.createElement(OpenClawProgressCardView, { card: value, running, failed: false, busy: false, onDismiss: vi.fn() })));
test('starts expanded, reports current position rather than completed count, and preserves toggles on update', () => {
  render();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(host.textContent).toContain('3 中的 2');
  expect(host.querySelectorAll('li')).toHaveLength(3);
  act(() => toggle.click());
  render({ ...card, revision: 2 });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.textContent).toContain('Build');
});
test('stopping removes animation without falsely completing a step', () => {
  render(); expect(host.querySelector('[data-running="true"]')).not.toBeNull();
  render(card, false); expect(host.querySelector('[data-running="true"]')).toBeNull();
  expect(host.querySelectorAll('[data-status="completed"]')).toHaveLength(1);
});
test('supports note-only cards and only exposes close for explicitly completed plans', () => {
  render({ ...card, steps: undefined });
  expect(host.querySelector('li')).toBeNull();
  expect(host.querySelector('[data-dismiss]')).toBeNull();
  render({ ...card, steps: card.steps!.map(s => ({ ...s, status: 'completed' })) });
  expect(host.querySelector('[data-dismiss]')).not.toBeNull();
});

test('a normal turn end does not claim pause or silently complete unfinished plan steps', () => {
  act(() => root.render(React.createElement(OpenClawProgressCardView, { card, running: false, failed: false, ended: true, busy: false, onDismiss: vi.fn() })));
  expect(host.textContent).toContain('本轮已结束');
  expect(host.textContent).not.toContain('已暂停');
  expect(host.querySelectorAll('[data-status="completed"]')).toHaveLength(1);
  expect(host.querySelector('[data-dismiss]')).toBeNull();
});

test('renders actual activity with failure and interrupted states, independently of task completion', () => {
  act(() => root.render(React.createElement(OpenClawProgressCardView, { card: null, running: false, failed: false, ended: true, busy: false, onDismiss: vi.fn(),
    activity: { turnId: 'u', startedAt: 1, updatedAt: 2, nativeWritten: false, steps: [
      { id: 'a', text: 'Create page', status: CoworkItemStatus.Completed },
      { id: 'b', text: 'Preview page', status: CoworkItemStatus.Failed },
      { id: 'c', text: 'Verify page', status: CoworkItemStatus.Interrupted },
    ] },
  })));
  expect(host.textContent).toContain('执行进度');
  expect(host.textContent).toContain('实际执行记录');
  expect(host.querySelectorAll('li')).toHaveLength(3);
  expect(host.querySelectorAll('[data-status="completed"]')).toHaveLength(1);
  expect(host.querySelector('[data-status="failed"]')?.textContent).toContain('Preview page');
  expect(host.querySelector('[data-running="true"]')).toBeNull();
  expect(host.querySelector('[data-dismiss]')).toBeNull();
});

test('the dock replaces a legacy placeholder, hands over to a native plan, and respects an explicit clear', async () => {
  let changed!: (event: { sessionId: string }) => void;
  let saved: OpenClawProgressCard | null = { sessionKey: 's', revision: 1, updatedAt: 11, markdown: '已开始执行多项工具操作；详细任务计划尚未提供。' };
  Object.defineProperty(window, 'electron', { configurable: true, value: { cowork: {
    getProgressCard: vi.fn(async () => ({ success: true, card: saved })),
    onProgressCardChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
  } } });
  const session = { id: 's', status: 'running', messagesOffset: 0, totalMessages: 3, messages: [
    { id: 'u', type: 'user', content: 'Create page', timestamp: 10 },
    { id: 'a', type: 'tool_use', content: '', timestamp: 20, metadata: { toolUseId: 'a', toolName: 'write', toolInput: { description: 'Write page' } } },
    { id: 'b', type: 'tool_use', content: '', timestamp: 30, metadata: { toolUseId: 'b', toolName: 'browser', toolInput: { description: 'Verify page' } } },
  ] } as CoworkSession;
  await act(async () => { root.render(React.createElement(OpenClawProgressCardDock, { session })); });
  expect(host.textContent).toContain('Write page');
  expect(host.textContent).not.toContain('详细任务计划尚未提供');
  expect(host.querySelector('[data-refresh]')).toBeNull();

  saved = { ...card, sessionKey: 's' };
  await act(async () => { changed({ sessionId: 's' }); });
  expect(host.textContent).toContain('Inspect');
  expect(host.textContent).not.toContain('Write page');
  expect(host.querySelector('[data-refresh]')).not.toBeNull();

  saved = null;
  const cleared = { ...session, totalMessages: 5, messages: [...session.messages,
    { id: 'p', type: 'tool_use' as const, content: '', timestamp: 40, metadata: { toolUseId: 'p', toolName: 'progress_card', toolInput: {} } },
    { id: 'pr', type: 'tool_result' as const, content: 'Cleared', timestamp: 41, metadata: { toolUseId: 'p', isFinal: true } },
  ] };
  await act(async () => { changed({ sessionId: 's' }); root.render(React.createElement(OpenClawProgressCardDock, { session: cleared })); });
  expect(host.querySelector('.openclaw-progress-card')).toBeNull();
});
