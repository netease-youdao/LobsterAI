import { describe, expect, test, vi } from 'vitest';

import {
  type CoworkPendingSteer,
  CoworkSteerStatus,
} from '../../shared/cowork/steer';
import type { AppDispatch, RootState } from '../store';
import coworkReducer, { addPendingSteer, setCurrentSession } from '../store/slices/coworkSlice';
import {
  type CoworkContinueOptions,
  type CoworkSession,
  type CoworkSessionStatus,
  CoworkSessionStatusValue,
} from '../types/cowork';
import type { prepareCoworkPromptPayload } from './coworkPromptPayload';
import { CoworkQueuedFollowUpCoordinator } from './coworkQueuedFollowUpCoordinator';

const makeSteer = (id: string, sessionId = 'session-a'): CoworkPendingSteer => ({
  id,
  sessionId,
  ownerAccountKey: 'personal:6',
  accountGeneration: 1,
  text: `message-${id}`,
  status: CoworkSteerStatus.Pending,
  createdAt: 1,
  updatedAt: 1,
});

const makeSession = (
  id: string,
  status: CoworkSessionStatus = CoworkSessionStatusValue.Completed,
): CoworkSession => ({
  id,
  title: id,
  claudeSessionId: null,
  scheduledTaskId: null,
  status,
  pinned: false,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'main',
  messages: [],
  messagesOffset: 0,
  totalMessages: 0,
  createdAt: 1,
  updatedAt: 1,
});

const createHarness = (
  continueResult = true,
  preparePromptPayload?: typeof prepareCoworkPromptPayload,
) => {
  let coworkState = coworkReducer(undefined, { type: 'test/init' });
  let authState = {
    isLoggedIn: true,
    isLoading: false,
    user: null,
    quota: null,
    profileSummary: null,
    ownerAccountKey: 'personal:6' as string | null,
    accountGeneration: 1,
  };
  const continueSession = vi.fn(async (_options: CoworkContinueOptions) => continueResult);
  const stopSession = vi.fn(async () => true);
  const dispatch = vi.fn((action: Parameters<AppDispatch>[0]) => {
    coworkState = coworkReducer(coworkState, action);
    return action;
  }) as unknown as AppDispatch;
  const getState = () => ({ cowork: coworkState, auth: authState }) as RootState;
  const coordinator = new CoworkQueuedFollowUpCoordinator({
    getState,
    dispatch,
    continueSession,
    stopSession,
    log: vi.fn(),
    preparePromptPayload,
  });

  return {
    coordinator,
    continueSession,
    stopSession,
    getCoworkState: () => coworkState,
    setAuthScope: (ownerAccountKey: string | null, accountGeneration: number) => {
      authState = {
        ...authState,
        isLoggedIn: ownerAccountKey !== null,
        ownerAccountKey,
        accountGeneration,
      };
    },
    enqueue: (steer: CoworkPendingSteer) => dispatch(addPendingSteer(steer)),
    openSession: (
      sessionId: string,
      status?: CoworkSessionStatus,
    ) => dispatch(setCurrentSession(makeSession(sessionId, status))),
  };
};

describe('CoworkQueuedFollowUpCoordinator', () => {
  test('submits a non-current session queue when that session completes', async () => {
    const harness = createHarness();
    harness.openSession('session-b');
    harness.enqueue(makeSteer('steer-1'));

    harness.coordinator.handleSessionCompleted('session-a');

    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(1));
    expect(harness.continueSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      prompt: 'message-steer-1',
    }));
    expect(harness.getCoworkState().pendingSteers['session-a']).toBeUndefined();
  });

  test('processes queued follow-ups one at a time in FIFO order', async () => {
    const harness = createHarness();
    harness.enqueue(makeSteer('steer-1'));
    harness.enqueue(makeSteer('steer-2'));

    harness.coordinator.handleSessionCompleted('session-a');
    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(1));
    expect(harness.continueSession.mock.calls[0][0].prompt).toBe('message-steer-1');

    harness.coordinator.handleSessionRunning('session-a');
    harness.coordinator.handleSessionCompleted('session-a');
    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(2));
    expect(harness.continueSession.mock.calls[1][0].prompt).toBe('message-steer-2');
  });

  test('deduplicates repeated completion events while submission is in flight', async () => {
    let resolveContinue: ((value: boolean) => void) | undefined;
    const harness = createHarness();
    harness.continueSession.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveContinue = resolve;
    }));
    harness.enqueue(makeSteer('steer-1'));
    harness.enqueue(makeSteer('steer-2'));

    harness.coordinator.handleSessionCompleted('session-a');
    harness.coordinator.handleSessionCompleted('session-a');

    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(1));
    resolveContinue?.(true);
    await vi.waitFor(() => {
      expect(harness.getCoworkState().pendingSteers['session-a']).toHaveLength(1);
    });
  });

  test('interrupts the active turn and submits only the selected item', async () => {
    const harness = createHarness();
    harness.enqueue(makeSteer('steer-1'));
    harness.enqueue(makeSteer('steer-2'));
    harness.enqueue(makeSteer('steer-3'));

    const submitted = await harness.coordinator.interruptAndSubmit('session-a', 'steer-2');

    expect(submitted).toBe(true);
    expect(harness.stopSession).toHaveBeenCalledWith('session-a');
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
    expect(harness.continueSession.mock.calls[0][0].prompt).toBe('message-steer-2');
    expect(harness.getCoworkState().pendingSteers['session-a']?.map(item => item.id)).toEqual([
      'steer-1',
      'steer-3',
    ]);
  });

  test('uses the latest running status when an idle-click event is stale', async () => {
    const harness = createHarness();
    harness.openSession('session-a', CoworkSessionStatusValue.Running);
    harness.enqueue(makeSteer('steer-1'));

    const submitted = await harness.coordinator.submitSelected('session-a', 'steer-1');

    expect(submitted).toBe(true);
    expect(harness.stopSession).toHaveBeenCalledWith('session-a');
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
  });

  test('skips interruption when the session completed before the click is handled', async () => {
    const harness = createHarness();
    harness.openSession('session-a', CoworkSessionStatusValue.Completed);
    harness.enqueue(makeSteer('steer-1'));

    const submitted = await harness.coordinator.interruptAndSubmit('session-a', 'steer-1');

    expect(submitted).toBe(true);
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
  });

  test('moves a rejected submission out of the pending queue without retrying', async () => {
    const harness = createHarness(false);
    harness.enqueue(makeSteer('steer-1'));

    harness.coordinator.handleSessionCompleted('session-a');

    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(harness.getCoworkState().pendingSteers['session-a']).toBeUndefined();
      expect(harness.getCoworkState().rejectedSteers['session-a']).toHaveLength(1);
    });
    harness.coordinator.handleSessionCompleted('session-a');
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
  });

  test('keeps the selected item queued when interrupting the active turn fails', async () => {
    const harness = createHarness();
    harness.stopSession.mockResolvedValue(false);
    harness.enqueue(makeSteer('steer-1'));

    const submitted = await harness.coordinator.interruptAndSubmit('session-a', 'steer-1');

    expect(submitted).toBe(false);
    expect(harness.continueSession).not.toHaveBeenCalled();
    expect(harness.getCoworkState().pendingSteers['session-a']).toHaveLength(1);
  });

  test('keeps different session queues independent', async () => {
    const harness = createHarness();
    harness.enqueue(makeSteer('steer-a', 'session-a'));
    harness.enqueue(makeSteer('steer-b', 'session-b'));

    harness.coordinator.handleSessionCompleted('session-a');
    harness.coordinator.handleSessionCompleted('session-b');

    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(2));
    expect(harness.continueSession.mock.calls.map(call => call[0].sessionId).sort()).toEqual([
      'session-a',
      'session-b',
    ]);
  });

  test('uses the capability and media snapshot captured with the queued item', async () => {
    const harness = createHarness();
    harness.enqueue({
      ...makeSteer('steer-1'),
      skillPrompt: 'selected skill routing',
      activeSkillIds: ['skill-a'],
      runtimeSkillIds: ['skill-a', 'skill-from-kit'],
      kitIds: ['kit-a'],
      mediaSelection: { mode: 'image', modelId: 'image-model' },
    });

    harness.coordinator.handleSessionCompleted('session-a');

    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(1));
    expect(harness.continueSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      systemPrompt: expect.stringContaining('selected skill routing'),
      activeSkillIds: ['skill-a'],
      runtimeSkillIds: ['skill-a', 'skill-from-kit'],
      kitIds: ['kit-a'],
      mediaSelection: { mode: 'image', modelId: 'image-model' },
    }));
  });

  test('does not submit queued work on an error event', () => {
    const harness = createHarness();
    harness.enqueue(makeSteer('steer-1'));

    harness.coordinator.handleSessionError('session-a');

    expect(harness.continueSession).not.toHaveBeenCalled();
    expect(harness.getCoworkState().pendingSteers['session-a']).toHaveLength(1);
  });

  test('cancels payload preparation when the session is cleared', async () => {
    type PreparationResult = Awaited<ReturnType<typeof prepareCoworkPromptPayload>>;
    let resolvePreparation: ((result: PreparationResult) => void) | undefined;
    const preparePromptPayload = vi.fn(() => new Promise<PreparationResult>(
      resolve => {
        resolvePreparation = resolve;
      },
    ));
    const harness = createHarness(true, preparePromptPayload);
    harness.enqueue(makeSteer('steer-1'));

    const submission = harness.coordinator.submitSelected('session-a', 'steer-1');
    await vi.waitFor(() => expect(preparePromptPayload).toHaveBeenCalledTimes(1));
    harness.coordinator.clearSession('session-a');
    resolvePreparation?.({
      success: true,
      payload: { finalPrompt: 'message-steer-1' },
    });

    await expect(submission).resolves.toBe(false);
    expect(harness.continueSession).not.toHaveBeenCalled();
  });

  test('discards an entire queued turn when the account changes during preparation', async () => {
    type PreparationResult = Awaited<ReturnType<typeof prepareCoworkPromptPayload>>;
    let resolvePreparation: ((result: PreparationResult) => void) | undefined;
    const preparePromptPayload = vi.fn(() => new Promise<PreparationResult>(
      resolve => {
        resolvePreparation = resolve;
      },
    ));
    const harness = createHarness(true, preparePromptPayload);
    harness.enqueue({
      ...makeSteer('steer-1'),
      text: 'generate an image for account A',
      mediaSelection: { mode: 'image', modelId: 'image-a' },
    });

    const submission = harness.coordinator.submitSelected('session-a', 'steer-1');
    await vi.waitFor(() => expect(preparePromptPayload).toHaveBeenCalledTimes(1));
    harness.setAuthScope('enterprise:6:1002', 2);
    resolvePreparation?.({
      success: true,
      payload: { finalPrompt: 'generate an image for account A' },
    });

    await expect(submission).resolves.toBe(false);
    expect(harness.continueSession).not.toHaveBeenCalled();
    expect(harness.getCoworkState().pendingSteers['session-a']).toBeUndefined();
  });
});
