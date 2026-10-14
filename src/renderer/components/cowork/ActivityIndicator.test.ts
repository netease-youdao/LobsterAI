import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';

import { ActivityIndicator } from './AssistantTurnBlock';

const NOW = Date.UTC(2026, 9, 10, 6, 27, 39);

afterEach(() => {
  vi.useRealTimers();
});

const renderAt = (props: React.ComponentProps<typeof ActivityIndicator>): string => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return renderToStaticMarkup(React.createElement(ActivityIndicator, props));
};

test('a silent model shows the first thinking phase and no step cue', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:0', startTimestamp: null,
  }));
  expect(html).toContain('正在思考');
  expect(html).not.toContain('data-cowork-activity-steps');
});

test('a running step names itself without a finished-step counter', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:3', startTimestamp: null, liveStatusText: '正在运行命令',
  }));
  expect(html).toContain('正在运行命令');
  expect(html).not.toContain('正在思考');
  expect(html).not.toContain('data-cowork-activity-steps');
  expect(html).not.toContain('步');
});

test('a silent gap after the turn has shown something reads as working, not thinking', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:5', startTimestamp: null, hasContent: true,
  }));
  expect(html).toContain('正在处理');
  expect(html).not.toContain('正在思考');
});

test('a live step still names itself once the turn has content', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:6', startTimestamp: null, hasContent: true, liveStatusText: '正在写入文件',
  }));
  expect(html).toContain('正在写入文件');
  expect(html).not.toContain('正在处理');
});

test('an explicit status override wins over the phase rotation', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:1', startTimestamp: null, statusTextOverride: '等待你的回答',
  }));
  expect(html).toContain('等待你的回答');
  expect(html).not.toContain('正在思考');
});

test('a start request returning normally never flashes the engine wait', () => {
  const html = renderAt({
    fingerprint: 'turn:0', startTimestamp: NOW - 1_500, awaitingRunStart: true,
  });
  expect(html).toContain('正在思考');
  expect(html).not.toContain('正在等待 AI 引擎就绪');
});

test('a start still pending after the grace period waits for the engine, not the model', () => {
  const html = renderAt({
    fingerprint: 'turn:0', startTimestamp: NOW - 4 * 60_000, awaitingRunStart: true,
  });
  expect(html).toContain('正在等待 AI 引擎就绪');
  expect(html).not.toContain('正在思考');
  // The counter keeps running from the click while the engine is awaited.
  expect(html).toContain('4m 0s');
});

test('a started turn goes back to the model phases with the same start time', () => {
  const html = renderAt({
    fingerprint: 'turn:0', startTimestamp: NOW - 4 * 60_000,
  });
  expect(html).toContain('正在思考');
  expect(html).not.toContain('正在等待 AI 引擎就绪');
});
