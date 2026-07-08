export interface CoworkVoiceRecordingUiStateInput {
  isLarge: boolean;
  isStreaming: boolean;
  isVoiceRecording: boolean;
}

export interface CoworkVoiceRecordingUiState {
  showLargeVoiceRecordingLayout: boolean;
  shouldHideInputPlaceholder: boolean;
  showFooterRecordingStatus: boolean;
  showLargeInputControls: boolean;
  showLargeModelSelector: boolean;
  showTaskStopButton: boolean;
}

export const getCoworkVoiceRecordingUiState = ({
  isLarge,
  isStreaming,
  isVoiceRecording,
}: CoworkVoiceRecordingUiStateInput): CoworkVoiceRecordingUiState => {
  const showLargeVoiceRecordingLayout = isVoiceRecording && isLarge;

  return {
    showLargeVoiceRecordingLayout,
    shouldHideInputPlaceholder: showLargeVoiceRecordingLayout,
    showFooterRecordingStatus: showLargeVoiceRecordingLayout,
    showLargeInputControls: !showLargeVoiceRecordingLayout,
    showLargeModelSelector: !showLargeVoiceRecordingLayout,
    showTaskStopButton: isStreaming && !showLargeVoiceRecordingLayout,
  };
};
