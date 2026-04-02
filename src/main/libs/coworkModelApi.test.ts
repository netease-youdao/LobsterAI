import { describe, expect, test } from 'vitest';
import {
  buildAnthropicMessagesUrl,
  buildGeminiGenerateContentUrl,
  extractApiErrorSnippet,
  extractTextFromAnthropicResponse,
  extractTextFromGeminiResponse,
  normalizeGeminiBaseUrl,
} from './coworkModelApi';

describe('coworkModelApi', () => {
  test('builds anthropic messages url from base url', () => {
    expect(buildAnthropicMessagesUrl('https://example.com/v1')).toBe('https://example.com/v1/messages');
    expect(buildAnthropicMessagesUrl('https://example.com')).toBe('https://example.com/v1/messages');
    expect(buildAnthropicMessagesUrl('https://example.com/v1/messages')).toBe('https://example.com/v1/messages');
  });

  test('normalizes gemini base url variants', () => {
    expect(normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta'
    );
    expect(normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com/v1')).toBe(
      'https://generativelanguage.googleapis.com/v1beta'
    );
  });

  test('builds gemini generate content url', () => {
    expect(
      buildGeminiGenerateContentUrl(
        'https://generativelanguage.googleapis.com/v1beta/openai',
        'gemini-3-pro-preview'
      )
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent');
  });

  test('extracts api error snippet from json payload', () => {
    expect(
      extractApiErrorSnippet(JSON.stringify({ error: { message: 'Invalid API key' } }))
    ).toBe('Invalid API key');
  });

  test('extracts anthropic text content', () => {
    expect(
      extractTextFromAnthropicResponse({
        content: [{ type: 'text', text: 'Generated title' }],
      })
    ).toBe('Generated title');
  });

  test('extracts gemini text from nested candidates and parts', () => {
    expect(
      extractTextFromGeminiResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Gemini title' },
                { inline_data: { mime_type: 'image/png', data: '...' } },
                { text: 'Second line' },
              ],
            },
          },
        ],
      })
    ).toBe('Gemini title\nSecond line');
  });
});
