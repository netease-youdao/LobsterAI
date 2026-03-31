import { test, expect, describe } from 'vitest';
import {
  normalizeProviderApiFormat,
  mapStopReason,
  formatSSEEvent,
  anthropicToOpenAI,
  openAIToAnthropic,
  buildOpenAIChatCompletionsURL,
} from './coworkFormatTransform';

// ---------------------------------------------------------------------------
// normalizeProviderApiFormat
// ---------------------------------------------------------------------------

describe('normalizeProviderApiFormat', () => {
  test('returns openai for "openai"', () => {
    expect(normalizeProviderApiFormat('openai')).toBe('openai');
  });

  test('returns anthropic for "anthropic"', () => {
    expect(normalizeProviderApiFormat('anthropic')).toBe('anthropic');
  });

  test('returns anthropic for unknown values', () => {
    expect(normalizeProviderApiFormat('unknown')).toBe('anthropic');
    expect(normalizeProviderApiFormat(null)).toBe('anthropic');
    expect(normalizeProviderApiFormat(undefined)).toBe('anthropic');
    expect(normalizeProviderApiFormat(123)).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// mapStopReason
// ---------------------------------------------------------------------------

describe('mapStopReason', () => {
  test('maps tool_calls -> tool_use', () => {
    expect(mapStopReason('tool_calls')).toBe('tool_use');
  });

  test('maps stop -> end_turn', () => {
    expect(mapStopReason('stop')).toBe('end_turn');
  });

  test('maps length -> max_tokens', () => {
    expect(mapStopReason('length')).toBe('max_tokens');
  });

  test('passes through unknown reasons', () => {
    expect(mapStopReason('content_filter')).toBe('content_filter');
  });

  test('returns null for null/undefined/empty', () => {
    expect(mapStopReason(null)).toBeNull();
    expect(mapStopReason(undefined)).toBeNull();
    expect(mapStopReason('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatSSEEvent
// ---------------------------------------------------------------------------

describe('formatSSEEvent', () => {
  test('formats event and data correctly', () => {
    const result = formatSSEEvent('message_start', { type: 'message_start' });
    expect(result).toBe('event: message_start\ndata: {"type":"message_start"}\n\n');
  });

  test('serializes nested objects', () => {
    const result = formatSSEEvent('delta', { type: 'text', text: 'hello' });
    expect(result).toContain('"text":"hello"');
    expect(result.startsWith('event: delta\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIChatCompletionsURL
// ---------------------------------------------------------------------------

describe('buildOpenAIChatCompletionsURL', () => {
  test('returns default path for empty string', () => {
    expect(buildOpenAIChatCompletionsURL('')).toBe('/v1/chat/completions');
  });

  test('returns default path for whitespace-only string', () => {
    expect(buildOpenAIChatCompletionsURL('   ')).toBe('/v1/chat/completions');
  });

  test('returns URL as-is if already ends with /chat/completions', () => {
    expect(buildOpenAIChatCompletionsURL('https://api.openai.com/v1/chat/completions'))
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  test('appends /chat/completions to versioned path /v1', () => {
    expect(buildOpenAIChatCompletionsURL('https://api.openai.com/v1'))
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  test('appends /chat/completions to versioned path /v4', () => {
    expect(buildOpenAIChatCompletionsURL('https://some.api.com/v4'))
      .toBe('https://some.api.com/v4/chat/completions');
  });

  test('strips trailing slashes', () => {
    expect(buildOpenAIChatCompletionsURL('https://api.openai.com/v1/'))
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  test('appends /v1/chat/completions to bare host', () => {
    expect(buildOpenAIChatCompletionsURL('https://my.custom.llm'))
      .toBe('https://my.custom.llm/v1/chat/completions');
  });

  // Google Gemini special cases
  test('Google: appends /chat/completions to .../v1beta/openai', () => {
    expect(buildOpenAIChatCompletionsURL(
      'https://generativelanguage.googleapis.com/v1beta/openai'
    )).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  test('Google: appends /chat/completions to .../v1/openai', () => {
    expect(buildOpenAIChatCompletionsURL(
      'https://generativelanguage.googleapis.com/v1/openai'
    )).toBe('https://generativelanguage.googleapis.com/v1/openai/chat/completions');
  });

  test('Google: converts /v1beta path to .../v1beta/openai/chat/completions', () => {
    expect(buildOpenAIChatCompletionsURL(
      'https://generativelanguage.googleapis.com/v1beta'
    )).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  test('Google: converts /v1 path to v1beta/openai/chat/completions', () => {
    expect(buildOpenAIChatCompletionsURL(
      'https://generativelanguage.googleapis.com/v1'
    )).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  test('Google: bare host gets full v1beta path', () => {
    expect(buildOpenAIChatCompletionsURL(
      'https://generativelanguage.googleapis.com'
    )).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// anthropicToOpenAI
// ---------------------------------------------------------------------------

describe('anthropicToOpenAI', () => {
  test('converts simple text message', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });
    expect(result.model).toBe('claude-3-5-sonnet-20241022');
    expect(result.max_tokens).toBe(1024);
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  test('converts string system prompt to system message', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  test('converts array system prompt (each block becomes a system message)', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      system: [
        { type: 'text', text: 'Be concise.' },
        { type: 'text', text: 'Use English.' },
      ],
      messages: [],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(msgs[1]).toEqual({ role: 'system', content: 'Use English.' });
  });

  test('converts text content block', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'What is 2+2?' }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0].content).toBe('What is 2+2?');
  });

  test('converts image content block to image_url', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { media_type: 'image/jpeg', data: 'base64data==' },
        }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    const parts = msgs[0].content as Array<Record<string, unknown>>;
    expect(parts[0].type).toBe('image_url');
    expect((parts[0].image_url as Record<string, unknown>).url)
      .toBe('data:image/jpeg;base64,base64data==');
  });

  test('converts tool_use block to tool_calls', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_abc',
          name: 'read_file',
          input: { path: '/tmp/test.txt' },
        }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    const toolCalls = msgs[0].tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('tool_abc');
    expect(toolCalls[0].type).toBe('function');
    const fn = toolCalls[0].function as Record<string, unknown>;
    expect(fn.name).toBe('read_file');
    expect(JSON.parse(fn.arguments as string)).toEqual({ path: '/tmp/test.txt' });
  });

  test('preserves extra_content on tool_use block', () => {
    const extra = { foo: 'bar' };
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_1',
          name: 'search',
          input: {},
          extra_content: extra,
        }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    const toolCalls = msgs[0].tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].extra_content).toEqual(extra);
  });

  test('converts thought_signature on tool_use block to google extra_content', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_1',
          name: 'search',
          input: {},
          thought_signature: 'sig_abc',
        }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    const toolCalls = msgs[0].tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].extra_content).toEqual({ google: { thought_signature: 'sig_abc' } });
  });

  test('converts tool_result block to tool role message', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_abc',
          content: 'file contents here',
        }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe('tool');
    expect(msgs[0].tool_call_id).toBe('tool_abc');
    expect(msgs[0].content).toBe('file contents here');
  });

  test('converts thinking block and adds reasoning_content', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Answer: 42' },
        ],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0].reasoning_content).toBe('Let me think...');
    expect(msgs[0].content).toBe('Answer: 42');
  });

  test('excludes BatchTool from tools array', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [],
      tools: [
        { type: 'BatchTool', name: 'batch', input_schema: { type: 'object' } },
        { type: 'custom', name: 'read_file', input_schema: { type: 'object' } },
      ],
    });
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect((tools[0].function as Record<string, unknown>).name).toBe('read_file');
  });

  test('cleans format:uri from tool input_schema', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [],
      tools: [{
        type: 'custom',
        name: 'fetch',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
          },
        },
      }],
    });
    const tools = result.tools as Array<Record<string, unknown>>;
    const params = (tools[0].function as Record<string, unknown>).parameters as Record<string, unknown>;
    const urlProp = (params.properties as Record<string, unknown>).url as Record<string, unknown>;
    expect(urlProp.format).toBeUndefined();
    expect(urlProp.type).toBe('string');
  });

  test('passes through stop_sequences as stop', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [],
      stop_sequences: ['\n\nHuman:'],
    });
    expect(result.stop).toEqual(['\n\nHuman:']);
  });

  test('passes through temperature and top_p', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [],
      temperature: 0.7,
      top_p: 0.9,
    });
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
  });

  test('does not add tools key when tools array is empty', () => {
    const result = anthropicToOpenAI({
      model: 'claude-3',
      messages: [],
      tools: [],
    });
    expect(result.tools).toBeUndefined();
  });

  test('handles non-object body gracefully', () => {
    const result = anthropicToOpenAI(null);
    expect(result.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// openAIToAnthropic
// ---------------------------------------------------------------------------

describe('openAIToAnthropic', () => {
  test('converts basic text response', () => {
    const result = openAIToAnthropic({
      id: 'msg_01',
      model: 'gpt-4o',
      choices: [{
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.id).toBe('msg_01');
    expect(result.type).toBe('message');
    expect(result.role).toBe('assistant');
    expect(result.model).toBe('gpt-4o');
    expect(result.stop_reason).toBe('end_turn');
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'Hello!' });
    expect((result.usage as Record<string, unknown>).input_tokens).toBe(10);
    expect((result.usage as Record<string, unknown>).output_tokens).toBe(5);
  });

  test('converts tool_calls to tool_use blocks', () => {
    const result = openAIToAnthropic({
      id: 'msg_02',
      model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    expect(result.stop_reason).toBe('tool_use');
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_use');
    expect(content[0].id).toBe('call_abc');
    expect(content[0].name).toBe('read_file');
    expect(content[0].input).toEqual({ path: '/tmp/x' });
  });

  test('converts reasoning_content to thinking block', () => {
    const result = openAIToAnthropic({
      id: 'msg_03',
      model: 'deepseek-r1',
      choices: [{
        message: {
          role: 'assistant',
          content: 'Final answer',
          reasoning_content: 'Step by step...',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'Step by step...' });
    expect(content[1]).toEqual({ type: 'text', text: 'Final answer' });
  });

  test('falls back to reasoning field when reasoning_content is absent', () => {
    const result = openAIToAnthropic({
      id: 'msg_04',
      model: 'qwq',
      choices: [{
        message: {
          role: 'assistant',
          content: 'Done',
          reasoning: 'My chain of thought',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'My chain of thought' });
  });

  test('preserves extra_content from tool_call', () => {
    const extra = { google: { thought_signature: 'sig_xyz' } };
    const result = openAIToAnthropic({
      id: 'msg_05',
      model: 'gemini',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{}' },
            extra_content: extra,
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].extra_content).toEqual(extra);
  });

  test('handles invalid tool_call arguments gracefully', () => {
    const result = openAIToAnthropic({
      id: 'msg_06',
      model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_bad',
            type: 'function',
            function: { name: 'bad_tool', arguments: 'INVALID JSON{{{' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].input).toEqual({});
  });

  test('maps finish_reason length -> max_tokens', () => {
    const result = openAIToAnthropic({
      id: 'msg_07',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'truncated' }, finish_reason: 'length' }],
      usage: {},
    });
    expect(result.stop_reason).toBe('max_tokens');
  });

  test('returns zero tokens when usage is missing', () => {
    const result = openAIToAnthropic({
      id: 'msg_08',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    expect((result.usage as Record<string, unknown>).input_tokens).toBe(0);
    expect((result.usage as Record<string, unknown>).output_tokens).toBe(0);
  });

  test('handles empty choices array gracefully', () => {
    const result = openAIToAnthropic({
      id: 'msg_09',
      model: 'gpt-4o',
      choices: [],
      usage: {},
    });
    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBeNull();
  });

  test('handles non-object body gracefully', () => {
    const result = openAIToAnthropic(null);
    expect(result.type).toBe('message');
    expect(result.content).toEqual([]);
  });
});
