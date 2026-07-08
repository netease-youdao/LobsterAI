import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import VoiceInputButton from './VoiceInputButton';

const renderButton = (overrides: Partial<React.ComponentProps<typeof VoiceInputButton>> = {}) => renderToStaticMarkup(
  React.createElement(VoiceInputButton, {
    buttonClassName: 'button',
    iconClassName: 'icon',
    isLoggedIn: true,
    disabled: false,
    isQuotaExhausted: false,
    isRecording: false,
    isRecognizing: false,
    onClick: () => undefined,
    ...overrides,
  }),
);

describe('VoiceInputButton', () => {
  test('uses the start voice input label in the idle state', () => {
    const html = renderButton();

    expect(html).toContain('aria-label="点击开始语音输入"');
    expect(html).toContain('title="点击开始语音输入"');
    expect(html).toContain('<svg');
  });

  test('uses the stop voice input label and stop square while recording', () => {
    const html = renderButton({ isRecording: true });

    expect(html).toContain('aria-label="点击结束语音输入"');
    expect(html).toContain('title="点击结束语音输入"');
    expect(html).toContain('rounded-[3px]');
    expect(html).not.toContain('<svg');
  });

  test('keeps the stop square while recognition is settling', () => {
    const html = renderButton({ isRecognizing: true });

    expect(html).toContain('aria-label="正在识别语音"');
    expect(html).toContain('rounded-[3px]');
    expect(html).not.toContain('<svg');
  });
});
