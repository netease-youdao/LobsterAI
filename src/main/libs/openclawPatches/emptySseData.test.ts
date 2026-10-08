import { describe, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectOpenClawSourceContains,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenClaw empty SSE data patch decisions', () => {
  test('drops the old patch because v2026.8.1 sanitizes unreadable SSE frames upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-empty-sse-data.patch');
  });

  test.skipIf(!isOpenClawSourceAvailable())('keeps the generalized upstream sanitizer and coverage', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/provider-transport-fetch.ts',
        snippets: ['function hasReadableSseData', 'SSE_SANITIZE_BUFFER_MAX_CHARS'],
      },
      {
        file: 'src/agents/provider-transport-fetch.test.ts',
        snippets: [
          'drops event-only SSE frames before the OpenAI SDK stream parser sees them',
          'drops whitespace-only SSE data frames with CRLF delimiters',
        ],
      },
    ]);
  });
});
