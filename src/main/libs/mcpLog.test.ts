import { expect, test } from 'vitest';

import { getToolTextPreview, looksLikeTransportErrorText, serializeForLog, serializeToolContentForLog } from './mcpLog';

test('serializeForLog redacts sensitive fields', () => {
  const preview = serializeForLog({
    query: 'latest AI news',
    apiKey: 'secret-api-key',
    nested: {
      refreshToken: 'secret-refresh-token',
    },
  });

  expect(preview).toContain('[redacted]');
  expect(preview).not.toContain('secret-api-key');
  expect(preview).not.toContain('secret-refresh-token');
});

test('serializeToolContentForLog keeps a readable preview', () => {
  const preview = serializeToolContentForLog([
    { type: 'text', text: 'fetch failed' },
  ]);

  expect(preview).toContain('fetch failed');
  expect(preview).toContain('"type":"text"');
});

test('getToolTextPreview joins text blocks', () => {
  const preview = getToolTextPreview([
    { type: 'text', text: 'first line' },
    { type: 'text', text: 'second line' },
    { type: 'image', url: 'https://example.com/image.png' },
  ]);

  expect(preview).toBe('first line second line');
});

test('looksLikeTransportErrorText detects network-style failures', () => {
  expect(looksLikeTransportErrorText('fetch failed')).toBe(true);
  expect(looksLikeTransportErrorText('socket hang up while calling upstream')).toBe(true);
  expect(looksLikeTransportErrorText('Detailed Results: example.com')).toBe(false);
});
