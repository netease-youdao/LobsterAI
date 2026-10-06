import { describe, expect, test, vi } from 'vitest';

import {
  getMediaStatusPollInterval,
  type MediaStatusPollPolicy,
  type MediaStatusResponse,
  pollMediaStatus,
} from '../../../openclaw-extensions/lobster-media-generation/statusPolling';

const policy: MediaStatusPollPolicy = {
  timeoutMs: 100,
  fastIntervalMs: 5,
  slowIntervalMs: 15,
  mediumIntervalMs: 30,
  idleIntervalMs: 60,
  fastPollCount: 1,
  slowPollCount: 1,
  mediumPollCount: 1,
};

const response = (
  status: string,
  details: Record<string, unknown> = {},
): MediaStatusResponse => ({
  content: [{ type: 'text', text: `status=${status}` }],
  details: { status, ...details },
});

describe('media generation status polling', () => {
  test('selects adaptive intervals by completed poll count', () => {
    expect(getMediaStatusPollInterval(policy, 0)).toBe(5);
    expect(getMediaStatusPollInterval(policy, 1)).toBe(15);
    expect(getMediaStatusPollInterval(policy, 2)).toBe(30);
    expect(getMediaStatusPollInterval(policy, 3)).toBe(60);
  });

  test('polls pending image status to a terminal result within one call', async () => {
    let nowMs = 0;
    const waits: number[] = [];
    const updates: Array<{ details?: Record<string, unknown> }> = [];
    const requestStatus = vi
      .fn<() => Promise<MediaStatusResponse>>()
      .mockResolvedValueOnce(response('queued', { upstreamTaskId: 'upstream-1', pollCount: 4 }))
      .mockResolvedValueOnce(response('running', { pollCount: 6 }))
      .mockResolvedValueOnce(response('succeeded', { pollCount: 9, localPath: 'C:/skin.png' }));

    const result = await pollMediaStatus({
      mediaType: 'image',
      taskId: 'task-1',
      toolCallId: 'tool-1',
      policy,
      requestStatus,
      now: () => nowMs,
      wait: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
      onUpdate: update => updates.push(update),
    });

    expect(requestStatus).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([5, 15]);
    expect(updates).toHaveLength(3);
    expect(result.details).toMatchObject({
      taskId: 'task-1',
      upstreamTaskId: 'upstream-1',
      status: 'succeeded',
      pollCount: 9,
      localPath: 'C:/skin.png',
    });
  });

  test('retries a transient status error without busy polling', async () => {
    let nowMs = 0;
    const waits: number[] = [];
    const requestStatus = vi
      .fn<() => Promise<MediaStatusResponse>>()
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValueOnce(response('succeeded'));

    const result = await pollMediaStatus({
      mediaType: 'image',
      taskId: 'task-2',
      toolCallId: 'tool-2',
      policy,
      requestStatus,
      now: () => nowMs,
      wait: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
    });

    expect(requestStatus).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([5]);
    expect(result.details).toMatchObject({ status: 'succeeded', pollCount: 2 });
  });

  test('retries a logical status error that has no explicit terminal status', async () => {
    let nowMs = 0;
    const waits: number[] = [];
    const requestStatus = vi.fn<() => Promise<MediaStatusResponse>>()
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Task not found.' }],
        isError: true,
      })
      .mockResolvedValueOnce(response('succeeded'));

    const result = await pollMediaStatus({
      mediaType: 'image',
      taskId: 'missing-task',
      toolCallId: 'tool-3',
      policy,
      requestStatus,
      now: () => nowMs,
      wait: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
    });

    expect(requestStatus).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([5]);
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ status: 'succeeded', pollCount: 2 });
  });

  test('returns a bounded timeout instead of polling forever', async () => {
    let nowMs = 0;
    const timeoutPolicy = { ...policy, timeoutMs: 10 };
    const requestStatus = vi.fn<() => Promise<MediaStatusResponse>>()
      .mockResolvedValue(response('running'));

    const result = await pollMediaStatus({
      mediaType: 'image',
      taskId: 'task-3',
      toolCallId: 'tool-4',
      policy: timeoutPolicy,
      requestStatus,
      now: () => nowMs,
      wait: async (ms) => {
        nowMs += ms;
      },
    });

    expect(requestStatus).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: 'timeout', pollCount: 2 });
  });
});
