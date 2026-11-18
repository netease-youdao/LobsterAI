import { describe, expect, test, vi } from 'vitest';

import { type ImageEditMessageSnapshot, ImageEditOperation } from '../../../../shared/imageEditing/types';
import { MediaDeliveryStatus, MediaProtocol, MediaTaskPhase, MediaTaskStatus } from '../../../../shared/media/constants';
import type { CoworkMessage, CoworkMessageMetadata } from '../../../types/cowork';
import { ImageEditJobPhase, imageEditJobStatus } from './imageEditJobStatus';

vi.mock('../../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const REQUEST = 'request-1';
let nextId = 0;
const message = (type: CoworkMessage['type'], metadata: CoworkMessageMetadata = {}, content = ''): CoworkMessage =>
  ({ id: `m${nextId++}`, type, content, timestamp: nextId, metadata });
const edit = (requestId = REQUEST) => message('user', { imageEdits: [{ requestId, operation: ImageEditOperation.Comment } as ImageEditMessageSnapshot] });
const mediaCall = (details: Record<string, unknown> = {}) => message('tool_use', { toolName: 'lobsterai_image_generate', toolUseId: 'call-1', mediaStatusDetails: details });
const mediaResult = (details: Record<string, unknown>, isError = false, content = '') =>
  message('tool_result', { toolUseId: 'call-1', toolResultDetails: details, isError }, content);
const status = (messages: CoworkMessage[], running = true, queued = false) => imageEditJobStatus({ requestId: REQUEST, messages, queued, running });
const task = (extra: Record<string, unknown>) => ({ protocolVersion: MediaProtocol.Durable, taskId: 'task-1', ...extra });

describe('image edit job status', () => {
  test('a queued follow-up waits for the current reply', () => {
    expect(status([], true, true)).toMatchObject({ phase: ImageEditJobPhase.Queued, labelKey: 'imageEditQueued' });
  });

  test('is preparing until its message arrives and while the reply has not called the media tool', () => {
    expect(status([message('assistant')], false).phase).toBe(ImageEditJobPhase.Preparing);
    expect(status([edit()], false).phase).toBe(ImageEditJobPhase.Preparing);
    expect(status([edit(), message('assistant')]).phase).toBe(ImageEditJobPhase.Preparing);
  });

  test('follows the media task of its own turn', () => {
    expect(status([edit(), mediaCall()])).toMatchObject({ phase: ImageEditJobPhase.Generating, labelKey: 'mediaTaskProcessing' });
    expect(status([edit(), mediaCall(task({ status: MediaTaskStatus.Processing, phase: MediaTaskPhase.Queued }))], false))
      .toMatchObject({ phase: ImageEditJobPhase.Generating, labelKey: 'mediaTaskQueued' });
  });

  test('a saved result keeps waiting for the new version instead of failing', () => {
    expect(status([edit(), mediaCall(), mediaResult(task({ status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Saved }))], false))
      .toMatchObject({ phase: ImageEditJobPhase.Generating, labelKey: 'mediaTaskFetching' });
  });

  test('a late running update does not revive a failed task', () => {
    const messages = [edit(), mediaCall(), mediaResult(task({ status: MediaTaskStatus.Failed })), mediaCall(task({ status: MediaTaskStatus.Processing }))];
    expect(status(messages, false)).toMatchObject({ phase: ImageEditJobPhase.Failed, labelKey: 'mediaTaskFailed' });
  });

  test('a rejected media call fails with its own explanation', () => {
    expect(status([edit(), mediaCall(), mediaResult({}, true, 'This image model does not support the edit.')]))
      .toMatchObject({ phase: ImageEditJobPhase.Failed, reason: 'This image model does not support the edit.' });
  });

  test('a finished reply without a media call fails, quoting the turn error', () => {
    expect(status([edit(), message('assistant', {}, 'I cannot edit this image.')], false))
      .toMatchObject({ phase: ImageEditJobPhase.Failed, labelKey: 'imageEditNoResult', reason: undefined });
    expect(status([edit(), message('assistant', { error: 'Model quota exceeded' })], false).reason).toBe('Model quota exceeded');
  });

  test('ignores other edits and later turns', () => {
    const otherTask = [edit('other'), mediaCall(task({ status: MediaTaskStatus.Failed }))];
    expect(status([edit(), message('assistant'), ...otherTask]).phase).toBe(ImageEditJobPhase.Preparing);
    expect(status([...otherTask, edit(), mediaCall()]).phase).toBe(ImageEditJobPhase.Generating);
  });
});
