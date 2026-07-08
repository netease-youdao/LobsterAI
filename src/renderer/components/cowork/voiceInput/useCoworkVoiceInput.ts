import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';

import { AsrApiCode } from '../../../../shared/asr/constants';
import {
  AsrClientError,
  getAsrErrorMessage,
  type RealtimeVoiceInputSession,
  startRealtimeVoiceInput,
  VOICE_INPUT_MAX_RECORDING_MS,
} from '../../../services/voiceInput';
import {
  getLocalAsrQuotaDayKey,
  markAsrQuotaExhausted,
  updateAsrQuotaFromSession,
} from '../../../store/slices/asrQuotaSlice';
import { setDraftPrompt } from '../../../store/slices/coworkSlice';

const VoiceInputState = {
  Idle: 'idle',
  Recording: 'recording',
  Recognizing: 'recognizing',
} as const;

type VoiceInputState = typeof VoiceInputState[keyof typeof VoiceInputState];

const VOICE_INPUT_TIMER_INTERVAL_MS = 250;
const VOICE_INPUT_MODE_LABEL = 'realtime';

interface UseCoworkVoiceInputOptions {
  draftKey: string;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  minHeight: number;
  maxHeight: number;
  isLoggedIn: boolean;
  disabled: boolean;
  onQuotaExhausted?: () => void;
}

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const logVoiceInputDiagnostic = (level: 'debug' | 'info' | 'warn', message: string): void => {
  if (level === 'warn') {
    console.warn(`[VoiceInput] ${message}`);
  } else {
    console.debug(`[VoiceInput] ${message}`);
  }
  window.electron?.log?.fromRenderer?.(level, 'VoiceInput', message);
};

export const useCoworkVoiceInput = ({
  draftKey,
  value,
  setValue,
  textareaRef,
  minHeight,
  maxHeight,
  isLoggedIn,
  disabled,
  onQuotaExhausted,
}: UseCoworkVoiceInputOptions) => {
  const dispatch = useDispatch();
  const [voiceInputState, setVoiceInputState] = useState<VoiceInputState>(VoiceInputState.Idle);
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
  const voiceRecordingRef = useRef<RealtimeVoiceInputSession | null>(null);
  const voiceAutoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceRecordingStartedAtRef = useRef<number | null>(null);
  const voiceRecordingMaxMsRef = useRef(VOICE_INPUT_MAX_RECORDING_MS);
  const voiceInputStartingRef = useRef(false);
  const realtimeVoiceBaseValueRef = useRef<string | null>(null);
  const activeVoiceDraftKeyRef = useRef<string | null>(null);
  const voiceInputGenerationRef = useRef(0);
  const latestDraftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  latestDraftKeyRef.current = draftKey;

  const setPromptValue = useCallback((targetDraftKey: string, nextValue: string) => {
    dispatch(setDraftPrompt({ sessionId: targetDraftKey, draft: nextValue }));
    if (targetDraftKey !== latestDraftKeyRef.current) {
      return;
    }

    setValue(nextValue);
    valueRef.current = nextValue;
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
      textarea.selectionStart = nextValue.length;
      textarea.selectionEnd = nextValue.length;
    });
  }, [dispatch, maxHeight, minHeight, setValue, textareaRef]);

  const markQuotaExhaustedIfNeeded = useCallback((error: unknown) => {
    if (!(error instanceof AsrClientError)) return false;
    if (error.code !== AsrApiCode.DailyLimitExceeded) return false;
    dispatch(markAsrQuotaExhausted({
      dayKey: getLocalAsrQuotaDayKey(),
      errorCode: error.code,
    }));
    onQuotaExhausted?.();
    return true;
  }, [dispatch, onQuotaExhausted]);

  const replaceRealtimeRecognizedVoiceText = useCallback((targetDraftKey: string, recognizedText: string): string | null => {
    const text = recognizedText.trim();
    if (!text) return null;
    const baseValue = realtimeVoiceBaseValueRef.current ?? valueRef.current;
    const separator = baseValue.trim() ? (baseValue.endsWith('\n') ? '' : '\n') : '';
    const nextValue = `${baseValue}${separator}${text}`;
    setPromptValue(targetDraftKey, nextValue);
    return nextValue;
  }, [setPromptValue]);

  const clearVoiceAutoStopTimer = useCallback(() => {
    if (voiceAutoStopTimerRef.current) {
      clearTimeout(voiceAutoStopTimerRef.current);
      voiceAutoStopTimerRef.current = null;
    }
  }, []);

  const cancelActiveVoiceInput = useCallback((reason: string, resetUiState = true) => {
    const hadActiveVoiceInput = voiceInputStartingRef.current || voiceRecordingRef.current || activeVoiceDraftKeyRef.current;
    voiceInputGenerationRef.current += 1;
    voiceInputStartingRef.current = false;
    clearVoiceAutoStopTimer();
    voiceRecordingRef.current?.cancel();
    voiceRecordingRef.current = null;
    voiceRecordingStartedAtRef.current = null;
    voiceRecordingMaxMsRef.current = VOICE_INPUT_MAX_RECORDING_MS;
    realtimeVoiceBaseValueRef.current = null;
    activeVoiceDraftKeyRef.current = null;
    if (resetUiState) {
      setVoiceInputState(VoiceInputState.Idle);
      setRecordingElapsedSeconds(0);
    }
    if (hadActiveVoiceInput) {
      logVoiceInputDiagnostic('info', `voice input was cancelled because ${reason}.`);
    }
  }, [clearVoiceAutoStopTimer]);

  const stopVoiceRecordingAndRecognize = useCallback(async (): Promise<string | null> => {
    const activeRecording = voiceRecordingRef.current;
    if (!activeRecording) return valueRef.current;
    const targetDraftKey = activeVoiceDraftKeyRef.current;
    if (!targetDraftKey || targetDraftKey !== latestDraftKeyRef.current) {
      cancelActiveVoiceInput('the active draft changed before stop');
      return null;
    }
    const generation = voiceInputGenerationRef.current;
    logVoiceInputDiagnostic('info', `voice input stop requested for draft ${targetDraftKey} in ${VOICE_INPUT_MODE_LABEL} mode.`);
    voiceInputStartingRef.current = false;
    voiceRecordingRef.current = null;
    voiceRecordingStartedAtRef.current = null;
    voiceRecordingMaxMsRef.current = VOICE_INPUT_MAX_RECORDING_MS;
    activeVoiceDraftKeyRef.current = null;
    clearVoiceAutoStopTimer();
    setVoiceInputState(VoiceInputState.Recognizing);
    setRecordingElapsedSeconds(0);
    try {
      const text = await activeRecording.stop();
      if (generation !== voiceInputGenerationRef.current) return null;
      const nextValue = replaceRealtimeRecognizedVoiceText(targetDraftKey, text);
      logVoiceInputDiagnostic('debug', `realtime voice input was finalized for draft ${targetDraftKey}.`);
      realtimeVoiceBaseValueRef.current = null;
      return nextValue ?? valueRef.current;
    } catch (error) {
      if (generation !== voiceInputGenerationRef.current) return null;
      console.warn('[VoiceInput] voice input recognition failed:', error);
      window.electron?.log?.fromRenderer?.('warn', 'VoiceInput', `voice input recognition failed for draft ${targetDraftKey}.`);
      const quotaExhausted = markQuotaExhaustedIfNeeded(error);
      if (!quotaExhausted) {
        showToast(getAsrErrorMessage(error));
      }
      return null;
    } finally {
      if (generation === voiceInputGenerationRef.current) {
        realtimeVoiceBaseValueRef.current = null;
        setVoiceInputState(VoiceInputState.Idle);
      }
    }
  }, [
    cancelActiveVoiceInput,
    clearVoiceAutoStopTimer,
    markQuotaExhaustedIfNeeded,
    replaceRealtimeRecognizedVoiceText,
  ]);

  const handleVoiceInput = useCallback(async () => {
    if (voiceInputStartingRef.current) return;
    if (voiceInputState === VoiceInputState.Recording) {
      await stopVoiceRecordingAndRecognize();
      return;
    }
    if (!isLoggedIn || disabled) return;
    if (voiceInputState === VoiceInputState.Recognizing) return;

    const generation = voiceInputGenerationRef.current + 1;
    voiceInputGenerationRef.current = generation;
    activeVoiceDraftKeyRef.current = draftKey;

    try {
      voiceInputStartingRef.current = true;
      setVoiceInputState(VoiceInputState.Recognizing);
      textareaRef.current?.focus();
      realtimeVoiceBaseValueRef.current = valueRef.current;
      logVoiceInputDiagnostic('info', `voice input start requested for draft ${draftKey} in ${VOICE_INPUT_MODE_LABEL} mode.`);
      const realtimeSession = await startRealtimeVoiceInput({
        onText: (text) => {
          if (generation !== voiceInputGenerationRef.current) return;
          if (activeVoiceDraftKeyRef.current !== latestDraftKeyRef.current) return;
          replaceRealtimeRecognizedVoiceText(draftKey, text);
        },
        onError: (error) => {
          if (generation !== voiceInputGenerationRef.current) return;
          if (!voiceRecordingRef.current) return;
          console.warn('[VoiceInput] realtime voice input session reported an error:', error);
          window.electron?.log?.fromRenderer?.('warn', 'VoiceInput', `realtime voice input session reported an error for draft ${draftKey}.`);
          const quotaExhausted = markQuotaExhaustedIfNeeded(error);
          voiceInputStartingRef.current = false;
          clearVoiceAutoStopTimer();
          voiceRecordingRef.current = null;
          voiceRecordingStartedAtRef.current = null;
          voiceRecordingMaxMsRef.current = VOICE_INPUT_MAX_RECORDING_MS;
          realtimeVoiceBaseValueRef.current = null;
          activeVoiceDraftKeyRef.current = null;
          setVoiceInputState(VoiceInputState.Idle);
          setRecordingElapsedSeconds(0);
          if (!quotaExhausted) {
            showToast(getAsrErrorMessage(error));
          }
        },
      });
      if (generation !== voiceInputGenerationRef.current || activeVoiceDraftKeyRef.current !== latestDraftKeyRef.current) {
        realtimeSession.cancel();
        return;
      }
      dispatch(updateAsrQuotaFromSession({
        dayKey: getLocalAsrQuotaDayKey(),
        data: realtimeSession.quota,
      }));
      voiceRecordingRef.current = realtimeSession;
      voiceRecordingMaxMsRef.current = Math.max(1, realtimeSession.maxSessionSeconds) * 1000;
      voiceRecordingStartedAtRef.current = Date.now();
      voiceInputStartingRef.current = false;
      setRecordingElapsedSeconds(0);
      setVoiceInputState(VoiceInputState.Recording);
      logVoiceInputDiagnostic('info', `voice input started for draft ${draftKey} in ${VOICE_INPUT_MODE_LABEL} mode.`);
      voiceAutoStopTimerRef.current = setTimeout(() => {
        void stopVoiceRecordingAndRecognize();
      }, voiceRecordingMaxMsRef.current);
    } catch (error) {
      if (generation !== voiceInputGenerationRef.current) return;
      console.warn('[VoiceInput] failed to start voice input:', error);
      window.electron?.log?.fromRenderer?.('warn', 'VoiceInput', `failed to start voice input for draft ${draftKey}.`);
      const quotaExhausted = markQuotaExhaustedIfNeeded(error);
      voiceInputStartingRef.current = false;
      voiceRecordingRef.current?.cancel();
      voiceRecordingRef.current = null;
      voiceRecordingStartedAtRef.current = null;
      voiceRecordingMaxMsRef.current = VOICE_INPUT_MAX_RECORDING_MS;
      realtimeVoiceBaseValueRef.current = null;
      activeVoiceDraftKeyRef.current = null;
      clearVoiceAutoStopTimer();
      setVoiceInputState(VoiceInputState.Idle);
      setRecordingElapsedSeconds(0);
      if (!quotaExhausted) {
        showToast(getAsrErrorMessage(error));
      }
    }
  }, [
    clearVoiceAutoStopTimer,
    disabled,
    dispatch,
    draftKey,
    isLoggedIn,
    markQuotaExhaustedIfNeeded,
    stopVoiceRecordingAndRecognize,
    textareaRef,
    replaceRealtimeRecognizedVoiceText,
    voiceInputState,
  ]);

  useEffect(() => {
    if (!activeVoiceDraftKeyRef.current) return;
    if (activeVoiceDraftKeyRef.current === draftKey) return;
    cancelActiveVoiceInput('the input draft changed');
  }, [cancelActiveVoiceInput, draftKey]);

  useEffect(() => {
    return () => {
      cancelActiveVoiceInput('the input component unmounted', false);
    };
  }, [cancelActiveVoiceInput]);

  useEffect(() => {
    if (voiceInputState !== VoiceInputState.Recording) {
      return;
    }

    const updateElapsedSeconds = () => {
      const startedAt = voiceRecordingStartedAtRef.current;
      if (!startedAt) return;
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      setRecordingElapsedSeconds(Math.min(elapsedSeconds, voiceRecordingMaxMsRef.current / 1000));
    };

    updateElapsedSeconds();
    const interval = window.setInterval(updateElapsedSeconds, VOICE_INPUT_TIMER_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [voiceInputState]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return {
    handleVoiceInput,
    stopVoiceRecordingAndRecognize,
    isVoiceRecording: voiceInputState === VoiceInputState.Recording,
    isVoiceRecognizing: voiceInputState === VoiceInputState.Recognizing,
    recordingElapsedSeconds,
  };
};
