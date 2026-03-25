/**
 * Unit tests for coworkFormatTransform.ts
 *
 * Covers:
 *   - normalizeProviderApiFormat: format normalization
 *   - mapStopReason: OpenAI finish_reason → Anthropic stop_reason
 *   - formatSSEEvent: SSE event string construction
 *   - buildOpenAIChatCompletionsURL: URL normalization for various providers
 *   - anthropicToOpenAI: full request body conversion
 *   - openAIToAnthropic: full response body conversion
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeProviderApiFormat,
  mapStopReason,
  formatSSEEvent,
  buildOpenAIChatCompletionsURL,
  anthropicToOpenAI,
  openAIToAnthropic,
} = require('../dist-electron/main/libs/coworkFormatTransform.js');

// ---------------------------------------------------------------------------
// normalizeProviderApiFormat
// ---------------------------------------------------------------------------

test('normalizeProviderApiFormat: openai returns openai', () => {
  assert.equal(normalizeProviderApiFormat('openai'), 'openai');
});

test('normalizeProviderApiFormat: anthropic returns anthropic', () => {
  assert.equal(normalizeProviderApiFormat('anthropic'), 'anthropic');
});

test('normalizeProviderApiFormat: unknown string defaults to anthropic', () => {
  assert.equal(normalizeProviderApiFormat('gemini'), 'anthropic');
});

test('normalizeProviderApiFormat: null defaults to anthropic', () => {
  assert.equal(normalizeProviderApiFormat(null), 'anthropic');
});

test('normalizeProviderApiFormat: undefined defaults to anthropic', () => {
  assert.equal(normalizeProviderApiFormat(undefined), 'anthropic');
});

// ---------------------------------------------------------------------------
// mapStopReason
// ---------------------------------------------------------------------------

test('mapStopReason: null returns null', () => {
  assert.equal(mapStopReason(null), null);
});

test('mapStopReason: undefined returns null', () => {
  assert.equal(mapStopReason(undefined), null);
});

test('mapStopReason: empty string returns null', () => {
  assert.equal(mapStopReason(''), null);
});

test('mapStopReason: tool_calls → tool_use', () => {
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
});

test('mapStopReason: stop → end_turn', () => {
  assert.equal(mapStopReason('stop'), 'end_turn');
});

test('mapStopReason: length → max_tokens', () => {
  assert.equal(mapStopReason('length'), 'max_tokens');
});

test('mapStopReason: unknown reason is passed through', () => {
  assert.equal(mapStopReason('content_filter'), 'content_filter');
});

// ---------------------------------------------------------------------------
// formatSSEEvent
// ---------------------------------------------------------------------------

test('formatSSEEvent: formats event and data correctly', () => {
  const result = formatSSEEvent('message_start', { type: 'message_start' });
  assert.equal(result, 'event: message_start\ndata: {"type":"message_start"}\n\n');
});

test('formatSSEEvent: handles object data', () => {
  const result = formatSSEEvent('delta', { text: 'hello', index: 0 });
  assert.ok(result.includes('event: delta'));
  assert.ok(result.includes('"text":"hello"'));
  assert.ok(result.includes('"index":0'));
  assert.ok(result.endsWith('\n\n'));
});

// ---------------------------------------------------------------------------
// buildOpenAIChatCompletionsURL
// ---------------------------------------------------------------------------

test('buildOpenAIChatCompletionsURL: plain base URL gets /v1/chat/completions', () => {
  assert.equal(
    buildOpenAIChatCompletionsURL('https://api.example.com'),
    'https://api.example.com/v1/chat/completions',
  );
});

test('buildOpenAIChatCompletionsURL: /v1 versioned path appends /chat/completions', () => {
  assert.equal(
    buildOpenAIChatCompletionsURL('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions',
  );
});

test('buildOpenAIChatCompletionsURL: already ends with /chat/completions is returned as-is', () => {
  const url = 'https://api.example.com/v1/chat/completions';
  assert.equal(buildOpenAIChatCompletionsURL(url), url);
});

test('buildOpenAIChatCompletionsURL: empty string returns /v1/chat/completions', () => {
  assert.equal(buildOpenAIChatCompletionsURL(''), '/v1/chat/completions');
});

test('buildOpenAIChatCompletionsURL: trailing slashes are stripped', () => {
  assert.equal(
    buildOpenAIChatCompletionsURL('https://api.example.com/v1/'),
    'https://api.example.com/v1/chat/completions',
  );
});

test('buildOpenAIChatCompletionsURL: Google Generative Language with /v1beta/openai appends /chat/completions', () => {
  assert.equal(
    buildOpenAIChatCompletionsURL('https://generativelanguage.googleapis.com/v1beta/openai'),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  );
});

test('buildOpenAIChatCompletionsURL: Google Generative Language bare /v1beta', () => {
  const result = buildOpenAIChatCompletionsURL(
    'https://generativelanguage.googleapis.com/v1beta',
  );
  assert.ok(result.includes('generativelanguage.googleapis.com'));
  assert.ok(result.includes('chat/completions'));
});

// ---------------------------------------------------------------------------
// anthropicToOpenAI — simple text message
// ---------------------------------------------------------------------------

test('anthropicToOpenAI: converts string system prompt to system message', () => {
  const result = anthropicToOpenAI({
    model: 'claude-3-5-sonnet',
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
  });
  assert.deepEqual(result.messages[0], { role: 'system', content: 'You are a helpful assistant.' });
  assert.deepEqual(result.messages[1], { role: 'user', content: 'Hello' });
  assert.equal(result.model, 'claude-3-5-sonnet');
  assert.equal(result.max_tokens, 1024);
});

test('anthropicToOpenAI: converts array system prompt to multiple system messages', () => {
  const result = anthropicToOpenAI({
    system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
    messages: [],
  });
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], { role: 'system', content: 'Part 1' });
  assert.deepEqual(result.messages[1], { role: 'system', content: 'Part 2' });
});

test('anthropicToOpenAI: converts user text content', () => {
  const result = anthropicToOpenAI({
    messages: [{ role: 'user', content: 'What is 2+2?' }],
  });
  assert.deepEqual(result.messages[0], { role: 'user', content: 'What is 2+2?' });
});

test('anthropicToOpenAI: converts assistant tool_use block', () => {
  const result = anthropicToOpenAI({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search for that.' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'web_search',
            input: { query: 'latest news' },
          },
        ],
      },
    ],
  });
  const msg = result.messages[0];
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'Let me search for that.');
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].id, 'tool-1');
  assert.equal(msg.tool_calls[0].function.name, 'web_search');
  assert.equal(msg.tool_calls[0].function.arguments, '{"query":"latest news"}');
});

test('anthropicToOpenAI: converts tool_result block to tool role message', () => {
  const result = anthropicToOpenAI({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'Search results here.',
          },
        ],
      },
    ],
  });
  assert.deepEqual(result.messages[0], {
    role: 'tool',
    tool_call_id: 'tool-1',
    content: 'Search results here.',
  });
});

test('anthropicToOpenAI: converts image block to image_url', () => {
  const result = anthropicToOpenAI({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { media_type: 'image/png', data: 'base64data' },
          },
        ],
      },
    ],
  });
  const msg = result.messages[0];
  assert.equal(msg.content[0].type, 'image_url');
  assert.equal(msg.content[0].image_url.url, 'data:image/png;base64,base64data');
});

test('anthropicToOpenAI: passes through max_tokens, temperature, top_p, stop_sequences, stream', () => {
  const result = anthropicToOpenAI({
    messages: [],
    max_tokens: 512,
    temperature: 0.7,
    top_p: 0.95,
    stop_sequences: ['\n\n'],
    stream: true,
  });
  assert.equal(result.max_tokens, 512);
  assert.equal(result.temperature, 0.7);
  assert.equal(result.top_p, 0.95);
  assert.deepEqual(result.stop, ['\n\n']);
  assert.equal(result.stream, true);
});

test('anthropicToOpenAI: converts tools array, stripping BatchTool', () => {
  const result = anthropicToOpenAI({
    messages: [],
    tools: [
      {
        name: 'web_search',
        type: 'custom',
        description: 'Search the web',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        name: 'BatchTool',
        type: 'BatchTool',
        description: 'Batch execution',
        input_schema: {},
      },
    ],
  });
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].function.name, 'web_search');
});

test('anthropicToOpenAI: cleanSchema removes format:uri from schema properties', () => {
  const result = anthropicToOpenAI({
    messages: [],
    tools: [
      {
        name: 'fetch',
        type: 'custom',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
          },
        },
      },
    ],
  });
  const params = result.tools[0].function.parameters;
  assert.equal(params.properties.url.format, undefined);
});

test('anthropicToOpenAI: thinking block produces reasoning_content on assistant message', () => {
  const result = anthropicToOpenAI({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think about this...' },
          { type: 'text', text: 'The answer is 42.' },
        ],
      },
    ],
  });
  const msg = result.messages[0];
  assert.equal(msg.reasoning_content, 'Let me think about this...');
  assert.equal(msg.content, 'The answer is 42.');
});

// ---------------------------------------------------------------------------
// openAIToAnthropic — response conversion
// ---------------------------------------------------------------------------

test('openAIToAnthropic: converts simple text response', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-1',
    model: 'gpt-4o',
    choices: [
      {
        message: { role: 'assistant', content: 'Hello, how can I help?' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 8 },
  });

  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.id, 'chatcmpl-1');
  assert.equal(result.model, 'gpt-4o');
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.stop_sequence, null);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'Hello, how can I help?');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 8);
});

test('openAIToAnthropic: finish_reason tool_calls → stop_reason tool_use', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-2',
    model: 'gpt-4o',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 15, completion_tokens: 20 },
  });

  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].id, 'call-1');
  assert.equal(result.content[0].name, 'get_weather');
  assert.deepEqual(result.content[0].input, { city: 'Shanghai' });
});

test('openAIToAnthropic: finish_reason length → stop_reason max_tokens', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-3',
    model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content: 'truncated...' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 100, completion_tokens: 4096 },
  });
  assert.equal(result.stop_reason, 'max_tokens');
});

test('openAIToAnthropic: reasoning_content produces thinking block', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-4',
    model: 'deepseek-r1',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'Final answer.',
          reasoning_content: 'Step by step thinking...',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 30 },
  });

  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'Step by step thinking...');
  assert.equal(result.content[1].type, 'text');
  assert.equal(result.content[1].text, 'Final answer.');
});

test('openAIToAnthropic: malformed tool arguments fall back to empty object', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-5',
    model: 'gpt-4o',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-bad',
              type: 'function',
              function: { name: 'search', arguments: 'NOT_VALID_JSON' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  });

  assert.equal(result.content[0].type, 'tool_use');
  assert.deepEqual(result.content[0].input, {});
});

test('openAIToAnthropic: missing usage fields produce 0 token counts', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-6',
    model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  });
  assert.equal(result.usage.input_tokens, 0);
  assert.equal(result.usage.output_tokens, 0);
});

test('openAIToAnthropic: no choices produces empty content', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-7',
    model: 'gpt-4o',
    choices: [],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  });
  assert.deepEqual(result.content, []);
  assert.equal(result.stop_reason, null);
});
