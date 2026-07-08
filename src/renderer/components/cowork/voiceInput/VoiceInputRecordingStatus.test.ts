import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import VoiceInputRecordingStatus from './VoiceInputRecordingStatus';

describe('VoiceInputRecordingStatus', () => {
  test('shows the listening hint when requested', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceInputRecordingStatus, {
        elapsedSeconds: 1,
        showHint: true,
      }),
    );

    expect(html).toContain('支持中英混合，正在识别中...');
    expect(html).toContain('0:01');
  });

  test('positions the hint above the shared wave and timer anchor', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceInputRecordingStatus, {
        elapsedSeconds: 1,
        showHint: true,
      }),
    );

    expect(html).toContain('absolute bottom-full');
    expect(html).toContain('mb-4');
  });

  test('hides the listening hint once prompt text exists', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceInputRecordingStatus, {
        elapsedSeconds: 3723,
        showHint: false,
      }),
    );

    expect(html).not.toContain('支持中英混合，正在识别中...');
    expect(html).toContain('62:03');
  });

  test('renders five animated wave bars', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceInputRecordingStatus, {
        elapsedSeconds: 0,
        showHint: false,
      }),
    );

    const waveBarCount = (html.match(/voice-input-wave-bar/g) ?? []).length;
    expect(waveBarCount).toBe(5);
  });
});
