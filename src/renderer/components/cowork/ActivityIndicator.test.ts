import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { ActivityIndicator } from './AssistantTurnBlock';

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
