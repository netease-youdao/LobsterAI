import { describe, expect, test } from 'vitest';
import { extractOpenClawAssistantStreamText } from './openclawAssistantText';

describe('extractOpenClawAssistantStreamText', () => {
  test('extracts direct text field', () => {
    expect(extractOpenClawAssistantStreamText({ text: 'hello' })).toBe('hello');
  });

  test('extracts nested content parts', () => {
    expect(
      extractOpenClawAssistantStreamText({
        content: {
          parts: [
            { text: 'first' },
            { text: 'second' },
          ],
        },
      })
    ).toBe('first\nsecond');
  });

  test('extracts output_text and candidate text', () => {
    expect(
      extractOpenClawAssistantStreamText({
        candidates: [
          {
            content: [{ type: 'output_text', text: 'candidate output' }],
          },
        ],
      })
    ).toBe('candidate output');
  });
});
