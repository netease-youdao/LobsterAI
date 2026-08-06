import { expect, test } from 'vitest';

import {
  buildCoworkImageAttachmentPreview,
  COWORK_IMAGE_ATTACHMENT_MAX_BYTES,
  COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES,
  estimateBase64DecodedBytes,
  formatCoworkImageAttachmentLimit,
  shouldShowCoworkImageVisionHint,
  validateCoworkImageAttachmentSize,
} from './imageAttachments';

test('estimateBase64DecodedBytes handles padding and data URL prefixes', () => {
  expect(estimateBase64DecodedBytes('TWFu')).toBe(3);
  expect(estimateBase64DecodedBytes('TWE=')).toBe(2);
  expect(estimateBase64DecodedBytes('TQ==')).toBe(1);
  expect(estimateBase64DecodedBytes('data:image/png;base64,TWFu')).toBe(3);
});

test('formatCoworkImageAttachmentLimit uses a locale-neutral MB label', () => {
  expect(formatCoworkImageAttachmentLimit()).toBe('30MB');
});

test('shouldShowCoworkImageVisionHint follows the current model capability', () => {
  const attachments = [{ path: '/tmp/image.png' }];

  expect(shouldShowCoworkImageVisionHint(attachments, false)).toBe(true);
  expect(shouldShowCoworkImageVisionHint(attachments, true)).toBe(false);
  expect(shouldShowCoworkImageVisionHint([{ path: '/tmp/notes.txt' }], false)).toBe(false);
});

test('validateCoworkImageAttachmentSize accepts exactly the 30MB limit', () => {
  const validation = validateCoworkImageAttachmentSize({
    base64Data: '',
    sizeBytes: COWORK_IMAGE_ATTACHMENT_MAX_BYTES,
  });

  expect(validation.ok).toBe(true);
  expect(validation.sizeBytes).toBe(COWORK_IMAGE_ATTACHMENT_MAX_BYTES);
});

test('validateCoworkImageAttachmentSize rejects payloads over the 30MB limit', () => {
  const validation = validateCoworkImageAttachmentSize({
    base64Data: '',
    sizeBytes: COWORK_IMAGE_ATTACHMENT_MAX_BYTES + 1,
  });

  expect(validation.ok).toBe(false);
  expect(validation.maxBytes).toBe(COWORK_IMAGE_ATTACHMENT_MAX_BYTES);
});

test('validateCoworkImageAttachmentSize does not trust a smaller declared size', () => {
  const validation = validateCoworkImageAttachmentSize({
    base64Data: 'A'.repeat(Math.ceil((COWORK_IMAGE_ATTACHMENT_MAX_BYTES + 1) / 3) * 4),
    sizeBytes: 1,
  });

  expect(validation.ok).toBe(false);
  expect(validation.sizeBytes).toBeGreaterThan(COWORK_IMAGE_ATTACHMENT_MAX_BYTES);
});

test('buildCoworkImageAttachmentPreview stores preview data instead of large original data', () => {
  const preview = buildCoworkImageAttachmentPreview({
    name: 'large.png',
    mimeType: 'image/png',
    base64Data: 'A'.repeat(COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES * 2),
    sizeBytes: COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES + 1,
    localPath: '/tmp/large.png',
    previewMimeType: 'image/jpeg',
    previewBase64Data: 'cHJldmlldw==',
  });

  expect(preview).toEqual({
    name: 'large.png',
    mimeType: 'image/jpeg',
    base64Data: 'cHJldmlldw==',
    originalMimeType: 'image/png',
    originalSizeBytes: 786432,
    localPath: '/tmp/large.png',
    isPreview: true,
  });
});

test('buildCoworkImageAttachmentPreview refuses large originals without preview data', () => {
  expect(buildCoworkImageAttachmentPreview({
    name: 'large.png',
    mimeType: 'image/png',
    base64Data: 'A'.repeat(COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES * 2),
    sizeBytes: COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES + 1,
  })).toBeUndefined();
});
