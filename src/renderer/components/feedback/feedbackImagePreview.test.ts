import { describe, expect, test } from 'vitest';

import { getFeedbackImagePreviewUrl } from './feedbackImagePreview';

describe('feedback image preview URLs', () => {
  test.each([
    'blob:http://127.0.0.1:5175/1596e011-e9ac-47bf-89ec-2f14714b8f95',
    'blob:null/1596e011-e9ac-47bf-89ec-2f14714b8f95',
    'blob:file:///1596e011-e9ac-47bf-89ec-2f14714b8f95',
  ])('preserves local object URLs: %s', url => {
    expect(getFeedbackImagePreviewUrl(url)).toBe(url);
  });

  test.each([
    'https://example.com/image.png',
    '//example.com/image.png',
    'file:///tmp/image.png',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:null/image" onerror="alert(1)',
    'blob:null/<svg>',
    'blob:null/image&#34;',
    'blob:null/image\n<script>',
    'blob:null/image\u0000',
  ])('rejects remote, executable, or malformed addresses: %s', url => {
    expect(getFeedbackImagePreviewUrl(url)).toBeUndefined();
  });
});
