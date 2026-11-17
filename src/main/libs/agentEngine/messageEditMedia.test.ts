import { describe, expect, test } from 'vitest';

import {
  filterMediaReferencesByPrompt,
  restoreMediaReferences,
  sniffImageMimeType,
  toPersistedMediaReferences,
} from './messageEditMedia';
import type { CoworkMediaAttachmentRef } from './types';

const reference = (overrides: Partial<CoworkMediaAttachmentRef> = {}): CoworkMediaAttachmentRef => ({
  token: '@图片1', mediaType: 'image', index: 1, fileId: 'inline:pasted.png', fileName: 'pasted.png',
  mimeType: 'image/png', ...overrides,
});

describe('media references stored on a message', () => {
  test('never carry image bytes, and remember which attachment backs a path-less reference', () => {
    const attachments = [
      { name: 'other.png', mimeType: 'image/png', base64Data: 'b3RoZXI=' },
      { name: 'pasted.png', mimeType: 'image/png', base64Data: 'cGFzdGVk' },
    ];
    const stored = toPersistedMediaReferences([
      reference({ dataUrl: 'data:image/png;base64,cGFzdGVk' }),
      reference({ token: '@图片2', localPath: '/images/file.png', dataUrl: 'data:image/png;base64,ZmlsZQ==' }),
    ], attachments);
    expect(JSON.stringify(stored)).not.toContain('base64');
    expect(stored).toEqual([
      { ...reference(), attachmentIndex: 1 },
      reference({ token: '@图片2', localPath: '/images/file.png' }),
    ]);
    expect(toPersistedMediaReferences(undefined, attachments)).toBeUndefined();
  });

  test('match a re-encoded attachment by its name only when that is unambiguous', () => {
    const fitted = { name: 'pasted.png', mimeType: 'image/jpeg', base64Data: 'Zml0dGVk' };
    const draft = reference({ dataUrl: 'data:image/png;base64,b3JpZ2luYWw=' });
    expect(toPersistedMediaReferences([draft], [fitted])).toEqual([{ ...reference(), attachmentIndex: 0 }]);
    expect(toPersistedMediaReferences([draft], [fitted, fitted])).toEqual([reference()]);
  });

  test('are restored from the resent attachments, or refused when the payload is gone', () => {
    const attachment = { name: 'pasted.png', mimeType: 'image/jpeg', base64Data: 'Zml0dGVk' };
    expect(restoreMediaReferences([{ ...reference(), attachmentIndex: 0 }], new Map([[0, attachment]])))
      .toEqual([reference({ dataUrl: 'data:image/jpeg;base64,Zml0dGVk' })]);
    expect(restoreMediaReferences([{ ...reference(), attachmentIndex: 0 }], new Map())).toBeNull();
    expect(restoreMediaReferences([reference({ localPath: '/images/file.png' })], new Map()))
      .toEqual([reference({ localPath: '/images/file.png' })]);
  });

  test('apply only while their exact @ token is still in the prompt', () => {
    const refs = [reference(), reference({ token: '@视频1', mediaType: 'video' })];
    expect(filterMediaReferencesByPrompt(refs, '参考 @图片1 和 @视频1')).toEqual(refs);
    expect(filterMediaReferencesByPrompt(refs, '参考 @图片10')).toBeUndefined();
    expect(filterMediaReferencesByPrompt(refs, '只用 @视频1')).toEqual([refs[1]]);
  });
});

describe('image format detection', () => {
  test('reads the signature instead of trusting a stored label', () => {
    expect(sniffImageMimeType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(sniffImageMimeType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMimeType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMimeType(Buffer.from('plain text'))).toBeUndefined();
  });
});
