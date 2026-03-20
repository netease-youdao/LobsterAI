import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeProviderApiFormat,
  mapStopReason,
  formatSSEEvent,
  anthropicToOpenAI,
  openAIToAnthropic,
  buildOpenAIChatCompletionsURL,
} = require('../dist-electron/main/libs/coworkFormatTransform.js');

// ==================== normalizeProviderApiFormat ====================

test('normalizeProviderApiFormat: returns "openai" when format is "openai"', () => {
  assert.equal(normalizeProviderApiFormat('openai'), 'openai');
});

test('normalizeProviderApiFormat: returns "anthropic" for any other value', () => {
  assert.equal(normalizeProviderApiFormat('anthropic'), 'anthropic');
  assert.equal(normalizeProviderApiFormat('claude'), 'anthropic');
  assert.equal(normalizeProviderApiFormat('anything'), 'anthropic');
  assert.equal(normalizeProviderApiFormat(123), 'anthropic');
  assert.equal(normalizeProviderApiFormat(null), 'anthropic');
  assert.equal(normalizeProviderApiFormat(undefined), 'anthropic');
});

// ==================== mapStopReason ====================

test('mapStopReason: maps "tool_calls" to "tool_use"', () => {
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
});

test('mapStopReason: maps "stop" to "end_turn"', () => {
  assert.equal(mapStopReason('stop'), 'end_turn');
});

test('mapStopReason: maps "length" to "max_tokens"', () => {
  assert.equal(mapStopReason('length'), 'max_tokens');
});

test('mapStopReason: returns finish_reason as-is for unknown values', () => {
  assert.equal(mapStopReason('unknown_reason'), 'unknown_reason');
  assert.equal(mapStopReason('content_filtered'), 'content_filtered');
});

test('mapStopReason: returns null for null/undefined', () => {
  assert.equal(mapStopReason(null), null);
  assert.equal(mapStopReason(undefined), null);
});

// ==================== formatSSEEvent ====================

test('formatSSEEvent: formats data as SSE event', () => {
  const result = formatSSEEvent('message', { content: 'hello' });
  assert.equal(result, 'event: message\ndata: {"content":"hello"}\n\n');
});

test('formatSSEEvent: handles string data', () => {
  const result = formatSSEEvent('ping', 'hello');
  assert.equal(result, 'event: ping\ndata: "hello"\n\n');
});

test('formatSSEEvent: handles null/undefined data', () => {
  const result1 = formatSSEEvent('error', null);
  assert.equal(result1, 'event: error\ndata: null\n\n');

  const result2 = formatSSEEvent('complete', undefined);
  assert.equal(result2, 'event: complete\ndata: undefined\n\n');
});

test('formatSSEEvent: escapes special characters in JSON', () => {
  const result = formatSSEEvent('message', { text: 'line1\nline2' });
  assert.equal(result, 'event: message\ndata: {"text":"line1\\nline2"}\n\n');
});

// ==================== anthropicToOpenAI ====================

test('anthropicToOpenAI: converts basic message structure', () => {
  const anthropic = {
    model: 'claude-3-5-sonnet',
    messages: [{ role: 'user', content: 'Hello' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.equal(openai.model, 'claude-3-5-sonnet');
  assert.deepEqual(openai.messages, [{ role: 'user', content: 'Hello' }]);
});

test('anthropicToOpenAI: converts string system prompt', () => {
  const anthropic = {
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hi' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.deepEqual(openai.messages, [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hi' },
  ]);
});

test('anthropicToOpenAI: converts array system prompt', () => {
  const anthropic = {
    system: [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ],
    messages: [{ role: 'user', content: 'Hi' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.deepEqual(openai.messages, [
    { role: 'system', content: 'Part 1' },
    { role: 'system', content: 'Part 2' },
    { role: 'user', content: 'Hi' },
  ]);
});

test('anthropicToOpenAI: preserves max_tokens, temperature, top_p', () => {
  const anthropic = {
    max_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
    messages: [{ role: 'user', content: 'Hi' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.equal(openai.max_tokens, 1024);
  assert.equal(openai.temperature, 0.7);
  assert.equal(openai.top_p, 0.9);
});

test('anthropicToOpenAI: maps stop_sequences to stop', () => {
  const anthropic = {
    stop_sequences: ['\n\nHuman:', 'STOP'],
    messages: [{ role: 'user', content: 'Hi' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.deepEqual(openai.stop, ['\n\nHuman:', 'STOP']);
});

test('anthropicToOpenAI: converts tools to OpenAI format', () => {
  const anthropic = {
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
      },
    ],
    messages: [{ role: 'user', content: 'Weather in Tokyo' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.equal(openai.tools.length, 1);
  assert.equal(openai.tools[0].type, 'function');
  assert.equal(openai.tools[0].function.name, 'get_weather');
  assert.equal(openai.tools[0].function.description, 'Get current weather');
  assert.deepEqual(openai.tools[0].function.parameters, {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  });
});

test('anthropicToOpenAI: filters out BatchTool type tools', () => {
  const anthropic = {
    tools: [
      { name: 'tool1', type: 'text' },
      { name: 'batch', type: 'BatchTool' },
      { name: 'tool2', type: 'tool' },
    ],
    messages: [{ role: 'user', content: 'Hi' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.equal(openai.tools.length, 2);
  assert.equal(openai.tools[0].function.name, 'tool1');
  assert.equal(openai.tools[1].function.name, 'tool2');
});

test('anthropicToOpenAI: handles tool_choice', () => {
  const anthropic = {
    tool_choice: { type: 'tool', name: 'get_weather' },
    messages: [{ role: 'user', content: 'Weather' }],
  };
  const openai = anthropicToOpenAI(anthropic);
  assert.deepEqual(openai.tool_choice, { type: 'tool', name: 'get_weather' });
});

test('anthropicToOpenAI: handles empty/null inputs gracefully', () => {
  assert.deepEqual(anthropicToOpenAI({}), { messages: [] });
  assert.deepEqual(anthropicToOpenAI(null), { messages: [] });
  assert.deepEqual(anthropicToOpenAI(undefined), { messages: [] });
});

// ==================== openAIToAnthropic ====================

test('openAIToAnthropic: converts basic text response', () => {
  const openai = {
    id: 'chatcmpl-123',
    model: 'gpt-4',
    choices: [
      {
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      },
    ],
  };
  const anthropic = openAIToAnthropic(openai);
  assert.equal(anthropic.id, 'chatcmpl-123');
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.role, 'assistant');
  assert.equal(anthropic.content[0].type, 'text');
  assert.equal(anthropic.content[0].text, 'Hello!');
  assert.equal(anthropic.stop_reason, 'end_turn');
});

test('openAIToAnthropic: converts reasoning_content to thinking block', () => {
  const openai = {
    id: 'chatcmpl-123',
    model: 'gemini',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'Final answer',
          reasoning_content: 'Let me think about this...',
        },
        finish_reason: 'stop',
      },
    ],
  };
  const anthropic = openAIToAnthropic(openai);
  assert.equal(anthropic.content[0].type, 'thinking');
  assert.equal(anthropic.content[0].thinking, 'Let me think about this...');
  assert.equal(anthropic.content[1].type, 'text');
  assert.equal(anthropic.content[1].text, 'Final answer');
});

test('openAIToAnthropic: converts reasoning (alias) to thinking block', () => {
  const openai = {
    id: 'chatcmpl-123',
    model: 'gemini',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'Answer',
          reasoning: 'Thinking process...',
        },
        finish_reason: 'stop',
      },
    ],
  };
  const anthropic = openAIToAnthropic(openai);
  assert.equal(anthropic.content[0].type, 'thinking');
  assert.equal(anthropic.content[0].thinking, 'Thinking process...');
});

test('openAIToAnthropic: converts tool_calls to tool_use blocks', () => {
  const openai = {
    id: 'chatcmpl-123',
    model: 'gpt-4',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Tokyo"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  const anthropic = openAIToAnthropic(openai);
  assert.equal(anthropic.content[0].type, 'tool_use');
  assert.equal(anthropic.content[0].id, 'call_123');
  assert.equal(anthropic.content[0].name, 'get_weather');
  assert.deepEqual(anthropic.content[0].input, { city: 'Tokyo' });
});

test('openAIToAnthropic: handles array content parts', () => {
  const openai = {
    id: 'chatcmpl-123',
    model: 'gpt-4',
    choices: [
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
        finish_reason: 'stop',
      },
    ],
  };
  const anthropic = openAIToAnthropic(openai);
  assert.equal(anthropic.content.length, 2);
  assert.equal(anthropic.content[0].type, 'text');
  assert.equal(anthropic.content[0].text, 'Hello');
});

test('openAIToAnthropic: maps finish_reason correctly', () => {
  const cases = [
    ['stop', 'end_turn'],
    ['tool_calls', 'tool_use'],
    ['length', 'max_tokens'],
    ['content_filter', 'content_filter'],
    ['unknown', 'unknown'],
  ];
  for (const [input, expected] of cases) {
    const openai = {
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: input }],
    };
    const result = openAIToAnthropic(openai);
    assert.equal(result.stop_reason, expected, `finish_reason=${input}`);
  }
});

test('openAIToAnthropic: handles usage info', () => {
  const openai = {
    id: 'chatcmpl-123',
    model: 'gpt-4',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
  const anthropic = openAIToAnthropic(openai);
  assert.equal(anthropic.usage.input_tokens, 100);
  assert.equal(anthropic.usage.output_tokens, 50);
});

test('openAIToAnthropic: handles empty/null inputs gracefully', () => {
  assert.deepEqual(openAIToAnthropic({}), { id: '', type: 'message', role: 'assistant', content: [], model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
  assert.deepEqual(openAIToAnthropic(null), { id: '', type: 'message', role: 'assistant', content: [], model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
});

// ==================== buildOpenAIChatCompletionsURL ====================

test('buildOpenAIChatCompletionsURL: returns default path for empty input', () => {
  assert.equal(buildOpenAIChatCompletionsURL(''), '/v1/chat/completions');
});

test('buildOpenAIChatCompletionsURL: appends /v1/chat/completions to base URL', () => {
  assert.equal(buildOpenAIChatCompletionsURL('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(buildOpenAIChatCompletionsURL('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
});

test('buildOpenAIChatCompletionsURL: preserves existing /chat/completions suffix', () => {
  assert.equal(buildOpenAIChatCompletionsURL('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(buildOpenAIChatCompletionsURL('https://api.openai.com/chat/completions'), 'https://api.openai.com/chat/completions');
});

test('buildOpenAIChatCompletionsURL: handles Google Generative Language API', () => {
  assert.equal(
    buildOpenAIChatCompletionsURL('https://generativelanguage.googleapis.com/v1beta'),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  );
  assert.equal(
    buildOpenAIChatCompletionsURL('https://generativelanguage.googleapis.com/v1'),
    'https://generativelanguage.googleapis.comv1beta/openai/chat/completions'
  );
  assert.equal(
    buildOpenAIChatCompletionsURL('https://generativelanguage.googleapis.com/v1beta/openai'),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  );
});

test('buildOpenAIChatCompletionsURL: strips trailing slashes', () => {
  assert.equal(buildOpenAIChatCompletionsURL('https://api.openai.com/'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(buildOpenAIChatCompletionsURL('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
});

test('buildOpenAIChatCompletionsURL: handles versioned API paths', () => {
  assert.equal(buildOpenAIChatCompletionsURL('https://api.example.com/v4'), 'https://api.example.com/v4/chat/completions');
  assert.equal(buildOpenAIChatCompletionsURL('https://api.example.com/v5'), 'https://api.example.com/v5/chat/completions');
});

test('buildOpenAIChatCompletionsURL: does not preserve query strings in base URL', () => {
  // Query strings are NOT stripped or preserved by current implementation
  // The URL is simply appended with /v1/chat/completions
  assert.equal(buildOpenAIChatCompletionsURL('https://api.openai.com/v1?api_version=2024-01-01'), 'https://api.openai.com/v1?api_version=2024-01-01/v1/chat/completions');
});
