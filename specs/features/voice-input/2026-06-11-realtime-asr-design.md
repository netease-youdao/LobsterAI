# Realtime ASR Voice Input Design

## 1. Overview

### 1.1 Background

Voice input originally supported a short ASR flow: the renderer recorded a complete WAV file, sent it to the main process through IPC, and the main process uploaded it to `POST /api/asr/recognize`.

The product now standardizes on realtime ASR only. The client creates a realtime ticket through `POST /api/asr/realtime/sessions`, connects to the returned WebSocket endpoint, streams PCM audio frames, and updates the Cowork prompt while the user speaks.

### 1.2 Goals

- Keep only realtime ASR for Cowork voice input.
- Remove the short ASR recording/upload flow.
- Remove the Settings page mode switch.
- Reuse the existing login, quota, rate-limit, microphone, and service-error messaging for realtime ASR failures.
- Let the server-provided `maxSessionSeconds` control the per-session recording limit.

## 2. User Scenarios

### Scenario 1: Start Realtime Voice Input

**Given** the user is signed in.
**When** the user clicks the Cowork microphone button.
**Then** the app creates a realtime ASR session, starts recording, streams audio to the WebSocket, and updates the prompt text while speech is recognized.

### Scenario 2: Stop Realtime Voice Input

**Given** the user is recording with realtime ASR.
**When** the user clicks the microphone button again.
**Then** the app sends the end marker, waits briefly for the final result, and leaves the final recognized text in the prompt.

### Scenario 3: Settings Page

**Given** the user opens Settings.
**When** the general settings are displayed.
**Then** no voice input recognition mode selector is shown, because realtime ASR is the only supported mode.

## 3. Functional Requirements

### FR-1: Realtime Session Creation

The main process exposes only the realtime ASR IPC channel. It calls `POST /api/asr/realtime/sessions` through `fetchWithAuth()` so access-token injection and 401 refresh behavior remain centralized.

### FR-2: Realtime Audio Stream

The renderer records mono microphone audio, resamples it to 16 kHz, and converts it to PCM 16-bit. The first WebSocket binary message includes a generated WAV header plus the first PCM slice. Later frames send PCM data only.

Each binary message must respect the server-suggested frame size: `16000 * 2 * chunkIntervalMillis / 1000` bytes. With the default `chunkIntervalMillis=200`, the frame limit is 6400 bytes. The first frame counts the WAV header toward that limit.

### FR-3: Rolling Recognition Merge

Realtime recognition text is corrective rather than append-only. The client keeps the latest text for each `raw.result[*].seg_id`, orders segments by id, and replaces only the current voice-input span in the prompt.

### FR-4: Error Handling

HTTP session creation failures, WebSocket error messages, abnormal connection closure, microphone permission failures, quota exhaustion, and rate limits must map to user-readable voice input errors.

### FR-5: Legacy Config Cleanup

Old persisted `app_config.voiceInput.recognitionMode` values are ignored and removed during config hydration/save. A previously selected short mode must not affect runtime behavior.

## 4. Implementation Notes

- `src/shared/asr/constants.ts` defines realtime request/result types, realtime event types, and the realtime IPC channel.
- `src/main/ipcHandlers/asr/handlers.ts` registers only `asr:realtime:createSession`.
- `src/main/preload.ts` and `src/renderer/types/electron.d.ts` expose only `window.electron.asr.createRealtimeSession()`.
- `src/renderer/services/voiceInput/realtimeAudioRecorder.ts` captures and chunks microphone audio.
- `src/renderer/services/voiceInput/realtimeAsrClient.ts` owns session creation, WebSocket lifecycle, audio frame sending, and recognition merging.
- `src/renderer/components/cowork/voiceInput/useCoworkVoiceInput.ts` always starts realtime ASR.
- `src/renderer/components/Settings.tsx` does not render a recognition mode selector.

## 5. Acceptance Criteria

- Voice input always uses realtime ASR.
- No renderer code calls the short ASR upload flow.
- The main process no longer registers `asr:recognize`.
- Settings does not show a voice input mode switch.
- Old saved `voiceInput.recognitionMode` config is stripped on config load/save.
- Realtime ASR still avoids duplicate rolling text and respects the WebSocket frame size limit.
- TypeScript build and ESLint pass for the affected files.
