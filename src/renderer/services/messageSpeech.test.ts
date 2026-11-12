import { expect, test, vi } from 'vitest';

import type { MessageSpeechBridge, MessageSpeechRequest } from '../../shared/cowork/messageSpeech';
import {
  LANGUAGE_TRANSLATION_MAX_CHARS,
  LANGUAGE_TTS_MAX_CHARS,
  LanguageToolCode,
  type LanguageToolEvent,
  LanguageToolEventType,
  type LanguageToolResult,
  SpeechStatus,
} from '../../shared/desktopCompanion/languageTools';
import { type SpeechAudio, SpeechQueue } from '../components/desktopCompanion/speechQueue';
import { MessageSpeechService } from './messageSpeech';

function fixture() {
  let onEvent: (event: LanguageToolEvent) => void = () => {};
  let onReset: (requestId: string) => void = () => {};
  const audio: SpeechAudio = { src: '', defaultPlaybackRate: 1, playbackRate: 1, onended: null, onerror: null,
    play: vi.fn(async () => undefined), pause: vi.fn() };
  const revokeUrl = vi.fn();
  const bridge: MessageSpeechBridge = {
    start: vi.fn(async (_request: MessageSpeechRequest): Promise<LanguageToolResult> => ({ success: true })),
    stop: vi.fn(async () => {}),
    onEvent: callback => { onEvent = callback; return vi.fn(); },
    onReset: callback => { onReset = callback; return vi.fn(); },
  };
  const service = new MessageSpeechService({
    getBridge: () => bridge,
    createPlayer: callback => {
      return new SpeechQueue(audio, callback, { createUrl: value => `blob:${value}`, revokeUrl });
    },
  });
  const onError = vi.fn();
  const disconnect = service.connect('session', onError);
  const request = () => vi.mocked(bridge.start).mock.lastCall![0];
  const segment = (requestId = request().requestId) => onEvent({ requestId, type: LanguageToolEventType.Audio,
    index: 0, total: 1, audioBase64: 'audio', mimeType: 'audio/mpeg' });
  return { bridge, service, audio, revokeUrl, onError, disconnect, request, segment,
    reset: (id: string) => onReset(id),
    finish: () => onEvent({ requestId: request().requestId, type: LanguageToolEventType.Done,
      quota: { tools: {}, translationMaxCharacters: LANGUAGE_TRANSLATION_MAX_CHARS, ttsMaxCharacters: LANGUAGE_TTS_MAX_CHARS } }),
  };
}

test('a second click stops pending synthesis and ignores late audio or rejection', async () => {
  const f = fixture();
  let resolve!: (result: LanguageToolResult) => void;
  vi.mocked(f.bridge.start).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.service.toggle('reply', 'read this');
  const id = f.request().requestId;
  expect(f.service.getSnapshot().status).toBe(SpeechStatus.Loading);
  f.service.toggle('reply', 'read this');
  f.segment(id);
  resolve({ success: false, code: LanguageToolCode.Unauthorized });
  await Promise.resolve();
  expect(f.bridge.stop).toHaveBeenCalledWith(id);
  expect(f.audio.play).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.service.getSnapshot()).toEqual({ messageId: null, status: SpeechStatus.Idle });
});

test('a new reply replaces the old one and ignores stale cross-window resets', async () => {
  const f = fixture();
  f.service.toggle('one', 'first');
  const oldId = f.request().requestId;
  f.segment();
  await Promise.resolve();
  f.service.toggle('two', 'second');
  const newId = f.request().requestId;
  f.segment(oldId);
  f.reset(oldId);
  expect(f.service.getSnapshot()).toEqual({ messageId: 'two', status: SpeechStatus.Loading });
  f.segment(newId);
  await Promise.resolve();
  expect(f.service.getSnapshot()).toEqual({ messageId: 'two', status: SpeechStatus.Playing });
  expect(f.bridge.stop).toHaveBeenCalledWith(oldId);
  expect(f.revokeUrl).toHaveBeenCalledWith('blob:audio');
});

test('finished audio replays from memory without another synthesis request', async () => {
  const f = fixture();
  f.service.toggle('reply', 'read this');
  f.segment();
  await Promise.resolve();
  f.finish();
  f.audio.onended?.(new Event('ended'));
  expect(f.service.getSnapshot().status).toBe(SpeechStatus.Ended);
  f.service.toggle('reply', 'read this');
  expect(f.bridge.start).toHaveBeenCalledTimes(1);
  expect(f.audio.play).toHaveBeenCalledTimes(2);
});

test('unauthorized synthesis prompts login without automatically retrying playback', async () => {
  const f = fixture();
  vi.mocked(f.bridge.start).mockResolvedValueOnce({ success: false, code: LanguageToolCode.Unauthorized });
  f.service.toggle('reply', 'read this');
  await Promise.resolve();
  expect(f.onError).toHaveBeenCalledWith(LanguageToolCode.Unauthorized);
  expect(f.service.getSnapshot().status).toBe(SpeechStatus.Idle);
  expect(f.bridge.start).toHaveBeenCalledTimes(1);
  f.service.requestLogin();
  expect(f.bridge.start).toHaveBeenCalledTimes(1);
});

test('leaving the session releases audio, aborts synthesis and discards old events', async () => {
  const f = fixture();
  f.service.toggle('reply', 'read this');
  const oldId = f.request().requestId;
  f.segment();
  await Promise.resolve();
  f.disconnect();
  f.segment(oldId);
  expect(f.bridge.stop).toHaveBeenCalledWith(oldId);
  expect(f.revokeUrl).toHaveBeenCalledWith('blob:audio');
  expect(f.service.getSnapshot()).toEqual({ messageId: null, status: SpeechStatus.Idle });
});
