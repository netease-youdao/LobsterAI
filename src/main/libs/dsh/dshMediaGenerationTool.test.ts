import { describe, expect, test, vi } from 'vitest';

import { MediaDeliveryStatus, MediaTaskStatus } from '../../../shared/media/constants';
import { MediaPreferenceMode, MediaSelectionMode } from '../../../shared/media/defaultPolicy';
import { MediaGenerationAction, MediaGenerationTool } from '../../mediaGenerationPolicy';
import { buildDshMediaTurnInstruction, createDshMediaGenerationProvider } from './dshMediaGenerationTool';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

const name = MediaGenerationTool.Image;
const context = { agentId: 'artist', coworkSessionId: 'conversation', callId: 'call-1' };

describe('LobsterAI media generation in dsh', () => {
  test('uses the bound conversation and native call ID, preserving the desktop response', async () => {
    const response = { content: [{ type: 'text', text: 'Task 1' }], details: { taskId: '1', status: 'pending' } };
    const submit = vi.fn().mockResolvedValue(response);
    const provider = createDshMediaGenerationProvider(submit);
    const args = { action: MediaGenerationAction.Generate, prompt: 'teapot', sessionKey: 'forged', toolCallId: 'other' };
    expect(provider.listDescriptors().map(tool => tool.name)).toEqual([name, MediaGenerationTool.Video]);
    expect(await provider.execute(name, args, context)).toEqual(response);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].context).toEqual({ sessionKey: 'agent:artist:lobsterai:conversation', toolCallId: 'call-1' });
  });

  test('rejects unbound and aborted submissions before invoking the account service', async () => {
    const submit = vi.fn();
    const provider = createDshMediaGenerationProvider(submit);
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
    const result = await createDshMediaGenerationProvider(submit).execute(name, args, context);
    expect(result).toMatchObject({ details: { status: 'succeeded' } });
    expect(submit.mock.calls.map(([request]) => request.args)).toEqual([args, args]);
  });

  test('scopes paid model instructions to the current turn', () => {
    expect(buildDshMediaTurnInstruction()).toBe('');
    expect(buildDshMediaTurnInstruction({ mode: MediaSelectionMode.Auto, imageModelId: 'chosen' })).toContain('"chosen"');
    expect(buildDshMediaTurnInstruction({ mode: MediaSelectionMode.None, imageModelId: 'stale' })).not.toContain('stale');
  });

  test('exposes video actions and preserves the selected parameters for desktop confirmation', async () => {
    const submit = vi.fn().mockResolvedValue({ content: [], details: { taskId: '2', status: 'pending' } });
    const provider = createDshMediaGenerationProvider(submit);
    const args = { action: MediaGenerationAction.Generate, model: 'chosen-video', durationSeconds: 6, audio: false,
      firstFrame: '/project/frame.png', returnLastFrame: true };
    await provider.execute(MediaGenerationTool.Video, args, context);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ tool: MediaGenerationTool.Video, args,
      context: { sessionKey: 'agent:artist:lobsterai:conversation', toolCallId: context.callId } });
    await provider.execute(MediaGenerationTool.Video, { action: MediaGenerationAction.Cancel, taskId: '2' }, context);
    expect(submit.mock.calls[1][0].args).toEqual({ action: MediaGenerationAction.Cancel, taskId: '2' });
    await expect(provider.execute(MediaGenerationTool.Image, { action: MediaGenerationAction.Cancel }, context)).rejects.toThrow();
    await expect(provider.execute(MediaGenerationTool.Video, { action: 'mistyped' }, context)).rejects.toThrow();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  test('waits for an existing video without submitting a second order', async () => {
    const link = '[clip.mp4](file:///project/clip.mp4)';
    const submit = vi.fn()
      .mockResolvedValueOnce({ content: [], details: { status: 'processing' } })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: link }],
        details: { status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Saved, taskId: '2' } });
    const args = { action: MediaGenerationAction.Status, taskId: '2', waitForResult: true };
    const result = await createDshMediaGenerationProvider(submit).execute(MediaGenerationTool.Video, args, context);
    expect(result).toMatchObject({ content: [{ type: 'text', text: link },
      { type: 'text', text: expect.stringContaining('finish by sharing the file link') }] });
    expect(submit.mock.calls.map(([request]) => request.args)).toEqual([args, args]);
  });

  test('includes the selected video model and mapped reference roles only when available', () => {
    const ref = { token: '@视频1', mediaType: 'video' as const, index: 0, fileId: 'v', fileName: 'v.mp4',
      mimeType: 'video/mp4', localPath: '/project/v.mp4', role: 'reference_video' as const };
    const selection = { mode: MediaSelectionMode.Video, modelId: 'chosen-video' };
    const instruction = buildDshMediaTurnInstruction(selection, [ref]);
    expect(instruction).toContain(MediaGenerationTool.Video);
    expect(instruction).toContain('chosen-video');
    expect(instruction).toContain('reference_video');
    expect(instruction).toContain('/project/v.mp4');
    const off = buildDshMediaTurnInstruction({ ...selection, videoPreference: MediaPreferenceMode.Off }, [ref]);
    expect(off).not.toContain('chosen-video');
    expect(off).not.toContain('/project/v.mp4');
  });
});
