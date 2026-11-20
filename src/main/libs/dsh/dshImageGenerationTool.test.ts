import { describe, expect, test, vi } from 'vitest';

import { MediaSelectionMode } from '../../../shared/media/defaultPolicy';
import { MediaGenerationAction, MediaGenerationTool } from '../../mediaGenerationPolicy';
import { buildDshImageTurnInstruction, createDshImageGenerationProvider } from './dshImageGenerationTool';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

const name = MediaGenerationTool.Image;
const context = { agentId: 'artist', coworkSessionId: 'conversation', callId: 'call-1' };

describe('LobsterAI image generation in dsh', () => {
  test('uses the bound conversation and native call ID, preserving the desktop response', async () => {
    const response = { content: [{ type: 'text', text: 'Task 1' }], details: { taskId: '1', status: 'pending' } };
    const submit = vi.fn().mockResolvedValue(response);
    const provider = createDshImageGenerationProvider(submit);
    const args = { action: MediaGenerationAction.Generate, prompt: 'teapot', sessionKey: 'forged', toolCallId: 'other' };
    expect(provider.listDescriptors().map(tool => tool.name)).toEqual([name]);
    expect(await provider.execute(name, args, context)).toEqual(response);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].context).toEqual({ sessionKey: 'agent:artist:lobsterai:conversation', toolCallId: 'call-1' });
  });

  test('rejects unbound and aborted submissions before invoking the account service', async () => {
    const submit = vi.fn();
    const provider = createDshImageGenerationProvider(submit);
    await expect(provider.execute(name, {}, { ...context, coworkSessionId: undefined })).rejects.toThrow('bound');
    await expect(provider.execute(name, {}, { ...context, callId: '' })).rejects.toThrow('bound');
    await expect(provider.execute(name, {}, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  test('waiting for a saved result only polls the existing order', async () => {
    const submit = vi.fn()
      .mockResolvedValueOnce({ content: [], details: { status: 'processing' } })
      .mockResolvedValueOnce({ content: [], details: { status: 'succeeded', taskId: '1' } });
    const args = { action: MediaGenerationAction.Status, taskId: '1', waitForResult: true };
    const result = await createDshImageGenerationProvider(submit).execute(name, args, context);
    expect(result).toMatchObject({ details: { status: 'succeeded' } });
    expect(submit.mock.calls.map(([request]) => request.args)).toEqual([args, args]);
  });

  test('scopes paid model instructions to the current turn', () => {
    expect(buildDshImageTurnInstruction()).toBe('');
    expect(buildDshImageTurnInstruction({ mode: MediaSelectionMode.Auto, imageModelId: 'chosen' })).toContain('"chosen"');
    expect(buildDshImageTurnInstruction({ mode: MediaSelectionMode.None, imageModelId: 'stale' })).not.toContain('stale');
  });
});
