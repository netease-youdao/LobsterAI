import { describe, expect, test, vi } from 'vitest';

import { SpeechStatus } from '../../../shared/desktopCompanion/languageTools';
import { type SpeechAudio, type SpeechPlayback,SpeechQueue } from './speechQueue';

function fixture() {
  const audio: SpeechAudio = { src: '', playbackRate: 1, onended: null, onerror: null,
    play: vi.fn(async () => undefined), pause: vi.fn() };
  const states: SpeechPlayback[] = [];
  const revokeUrl = vi.fn();
  const queue = new SpeechQueue(audio, state => states.push(state), {
    createUrl: value => `blob:${value}`, revokeUrl,
  });
  return { audio, states, revokeUrl, queue, status: () => states[states.length - 1]?.status };
}

describe('read-aloud playback queue', () => {
  test('plays arriving segments in order and replays cached audio without another request', async () => {
    const { queue, audio, status } = fixture();
    queue.begin();
    queue.append(0, 'one', 'audio/mpeg');
    queue.append(1, 'two', 'audio/mpeg');
    queue.finish();
    await Promise.resolve();
    expect(audio.src).toBe('blob:one');
    expect(status()).toBe(SpeechStatus.Playing);
    audio.onended?.(new Event('ended'));
    await Promise.resolve();
    expect(audio.src).toBe('blob:two');
    audio.onended?.(new Event('ended'));
    expect(status()).toBe(SpeechStatus.Ended);
    queue.resume();
    await Promise.resolve();
    expect(audio.src).toBe('blob:one');
    expect(status()).toBe(SpeechStatus.Playing);
  });

  test('pausing before synthesis finishes prevents arriving audio from starting', async () => {
    const { queue, audio, status } = fixture();
    queue.begin();
    queue.pause();
    queue.append(0, 'one', 'audio/mpeg');
    queue.finish();
    expect(audio.play).not.toHaveBeenCalled();
    expect(status()).toBe(SpeechStatus.Paused);
    queue.setRate(1.5);
    queue.resume();
    await Promise.resolve();
    expect(audio.playbackRate).toBe(1.5);
    expect(status()).toBe(SpeechStatus.Playing);
  });

  test('stop revokes all audio and ignores an outstanding play promise', async () => {
    const { queue, audio, revokeUrl, status } = fixture();
    let finishPlay!: () => void;
    audio.play = () => new Promise<void>(resolve => { finishPlay = resolve; });
    queue.begin();
    queue.append(0, 'one', 'audio/mpeg');
    queue.append(1, 'two', 'audio/mpeg');
    queue.stop();
    finishPlay();
    await Promise.resolve();
    audio.onended?.(new Event('ended'));
    expect(status()).toBe(SpeechStatus.Idle);
    expect(audio.src).toBe('');
    expect(revokeUrl.mock.calls).toEqual([['blob:one'], ['blob:two']]);
  });

  test('waits between segments, ignores duplicates, and rejects missing segments', async () => {
    const { queue, audio, status } = fixture();
    queue.begin();
    queue.append(0, 'one', 'audio/mpeg');
    await Promise.resolve();
    audio.onended?.(new Event('ended'));
    expect(status()).toBe(SpeechStatus.Loading);
    queue.append(0, 'duplicate', 'audio/mpeg');
    expect(() => queue.append(2, 'three', 'audio/mpeg')).toThrow();
    queue.append(1, 'two', 'audio/mpeg');
    await Promise.resolve();
    expect(audio.src).toBe('blob:two');
    expect(status()).toBe(SpeechStatus.Playing);
  });
});
