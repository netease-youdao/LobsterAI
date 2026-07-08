import { describe, expect, test } from 'vitest';

import { getCoworkVoiceRecordingUiState } from './voiceInputUiState';

describe('getCoworkVoiceRecordingUiState', () => {
  test('keeps the normal controls visible outside recording mode', () => {
    expect(getCoworkVoiceRecordingUiState({
      isLarge: true,
      isStreaming: false,
      isVoiceRecording: false,
    })).toEqual({
      showLargeVoiceRecordingLayout: false,
      shouldHideInputPlaceholder: false,
      showFooterRecordingStatus: false,
      showLargeInputControls: true,
      showLargeModelSelector: true,
      showTaskStopButton: false,
    });
  });

  test('shows the task stop button only when not in the voice recording layout', () => {
    expect(getCoworkVoiceRecordingUiState({
      isLarge: true,
      isStreaming: true,
      isVoiceRecording: false,
    }).showTaskStopButton).toBe(true);

    expect(getCoworkVoiceRecordingUiState({
      isLarge: true,
      isStreaming: true,
      isVoiceRecording: true,
    }).showTaskStopButton).toBe(false);
  });

  test('shows the footer recording status and hides controls in large recording mode', () => {
    const state = getCoworkVoiceRecordingUiState({
      isLarge: true,
      isStreaming: false,
      isVoiceRecording: true,
    });

    expect(state.shouldHideInputPlaceholder).toBe(true);
    expect(state.showFooterRecordingStatus).toBe(true);
    expect(state.showLargeInputControls).toBe(false);
    expect(state.showLargeModelSelector).toBe(false);
  });

  test('does not apply the large recording layout to compact inline inputs', () => {
    const state = getCoworkVoiceRecordingUiState({
      isLarge: false,
      isStreaming: true,
      isVoiceRecording: true,
    });

    expect(state.showLargeVoiceRecordingLayout).toBe(false);
    expect(state.shouldHideInputPlaceholder).toBe(false);
    expect(state.showLargeInputControls).toBe(true);
    expect(state.showLargeModelSelector).toBe(true);
    expect(state.showTaskStopButton).toBe(true);
  });
});
