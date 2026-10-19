import { describe, expect, test, vi } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import { submitCompanionFollowUp } from './companionFollowUp';

function client(status: string = CoworkSessionStatusValue.Completed) {
  return {
    getSession: vi.fn(async () => ({ success: true, session: { status } })),
    stopSession: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
    continueSession: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
    submitSteer: vi.fn(),
  };
}

describe('companion task follow-up', () => {
  test.each([CoworkSessionStatusValue.Completed, CoworkSessionStatusValue.Idle, CoworkSessionStatusValue.Error])(
    'submits a normal user turn to the selected %s task, preserving its session settings', async status => {
      const api = client(status);
      expect(await submitCompanionFollowUp(api, 'selected-task', '  请举个例子  ')).toEqual({ success: true });
      expect(api.continueSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'selected-task', prompt: '请举个例子' });
      expect(api.stopSession).not.toHaveBeenCalled();
      expect(api.submitSteer).not.toHaveBeenCalled();
    },
  );

  test('waits for the active turn to stop before continuing through the user-message path', async () => {
    const api = client(CoworkSessionStatusValue.Running);
    let resolveStopped!: (result: { success: boolean }) => void;
    const stopped = new Promise<{ success: boolean }>(resolve => { resolveStopped = resolve; });
    api.stopSession.mockReturnValueOnce(stopped);
    const onContinuing = vi.fn();
    const submission = submitCompanionFollowUp(api, 'running-task', '补充说明', onContinuing);
    await vi.waitFor(() => expect(api.stopSession).toHaveBeenCalledExactlyOnceWith('running-task'));
    expect(api.continueSession).not.toHaveBeenCalled();
    expect(onContinuing).not.toHaveBeenCalled();
    resolveStopped({ success: true });
    expect(await submission).toEqual({ success: true });
    expect(onContinuing).toHaveBeenCalledOnce();
    expect(api.continueSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'running-task', prompt: '补充说明' });
    expect(onContinuing.mock.invocationCallOrder[0]).toBeLessThan(api.continueSession.mock.invocationCallOrder[0]);
    expect(api.submitSteer).not.toHaveBeenCalled();
  });

  test('continues once if the old turn finishes before the stop request arrives', async () => {
    const api = client(CoworkSessionStatusValue.Running);
    api.stopSession.mockImplementationOnce(async () => {
      api.getSession.mockResolvedValue({ success: true, session: { status: CoworkSessionStatusValue.Completed } });
      return { success: true };
    });
    expect(await submitCompanionFollowUp(api, 'task', '继续')).toEqual({ success: true });
    expect(api.continueSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'task', prompt: '继续' });
  });

  test('does not submit a competing turn when stopping fails', async () => {
    const api = client(CoworkSessionStatusValue.Running);
    const onContinuing = vi.fn();
    api.stopSession.mockResolvedValue({ success: false, error: 'stop failed' });
    expect(await submitCompanionFollowUp(api, 'task', '继续', onContinuing)).toEqual({ success: false, error: 'stop failed' });
    expect(api.continueSession).not.toHaveBeenCalled();
    expect(onContinuing).not.toHaveBeenCalled();
  });

  test('returns continuation failures without resubmitting', async () => {
    const api = client();
    api.continueSession.mockResolvedValue({ success: false, error: 'unavailable' });
    expect(await submitCompanionFollowUp(api, 'task', '继续')).toEqual({ success: false, error: 'unavailable' });
    expect(api.continueSession).toHaveBeenCalledOnce();
  });

  test('does not submit empty input or continue an unavailable session', async () => {
    const api = client();
    expect(await submitCompanionFollowUp(api, 'task', '  ')).toEqual({ success: false });
    expect(api.getSession).not.toHaveBeenCalled();
    api.getSession.mockResolvedValue({ success: false, session: { status: CoworkSessionStatusValue.Completed } });
    expect((await submitCompanionFollowUp(api, 'deleted', '继续')).success).toBe(false);
    expect(api.continueSession).not.toHaveBeenCalled();
    expect(api.stopSession).not.toHaveBeenCalled();
  });
});
