import { test, expect, describe } from 'vitest';
import { __openAICompatProxyTestUtils, isAllowedProxyHost } from './coworkOpenAICompatProxy';
import type http from 'http';

const testUtils = __openAICompatProxyTestUtils;

function createMockResponse() {
  let output = '';
  return {
    write(chunk: Buffer | string) {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      return true;
    },
    getOutput() {
      return output;
    },
  };
}

function parseSSEEvents(raw: string) {
  const packets = raw.split('\n\n').filter(Boolean);
  const events: Array<{ event: string; data: unknown }> = [];

  for (const packet of packets) {
    const lines = packet.split(/\r?\n/);
    let eventName = '';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    const dataRaw = dataLines.join('\n');
    if (!dataRaw || dataRaw === '[DONE]') {
      continue;
    }

    let dataParsed: unknown = dataRaw;
    try {
      dataParsed = JSON.parse(dataRaw);
    } catch {
      // Keep original raw string.
    }

    events.push({
      event: eventName,
      data: dataParsed,
    });
  }

  return events;
}

function collectInputJsonDeltas(events: Array<{ event: string; data: unknown }>) {
  return events
    .filter((event) => event.event === 'content_block_delta')
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => (data?.delta as Record<string, unknown>)?.type === 'input_json_delta')
    .map((data) => String((data.delta as Record<string, unknown>)?.partial_json ?? ''));
}

function collectToolUseStarts(events: Array<{ event: string; data: unknown }>) {
  return events
    .filter((event) => event.event === 'content_block_start')
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => (data?.content_block as Record<string, unknown>)?.type === 'tool_use')
    .map((data) => ({
      id: String((data.content_block as Record<string, unknown>)?.id ?? ''),
      name: String((data.content_block as Record<string, unknown>)?.name ?? ''),
    }));
}

function runResponsesSequence(sequence: Array<{ event: string; payload: unknown }>) {
  const response = createMockResponse();
  const state = testUtils.createStreamState();
  const context = testUtils.createResponsesStreamContext();

  for (const step of sequence) {
    testUtils.processResponsesStreamEvent(
      response,
      state,
      context,
      step.event,
      step.payload,
    );
  }

  const events = parseSSEEvents(response.getOutput());
  return {
    events,
    inputJsonDeltas: collectInputJsonDeltas(events),
    toolUseStarts: collectToolUseStarts(events),
  };
}

// ==================== Responses stream tests ====================

test('A: added -> delta* -> done emits exactly one final arguments payload', () => {
  const responseId = 'resp_a';
  const model = 'gpt-5.2';
  const finalArguments = '{"questions":[{"header":"安全确认","question":"继续?","options":[{"label":"允许","description":"ok"},{"label":"拒绝","description":"no"}]}],"answers":{}}';

  const result = runResponsesSequence([
    {
      event: 'response.output_item.added',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_a',
          call_id: 'call_a',
          name: 'AskUserQuestion',
        },
      },
    },
    {
      event: 'response.function_call_arguments.delta',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        call_id: 'call_a',
        delta: '{"questions":[{"header":"安全确认",',
      },
    },
    {
      event: 'response.function_call_arguments.delta',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        call_id: 'call_a',
        delta: '"question":"继续?"}]}',
      },
    },
    {
      event: 'response.function_call_arguments.done',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        call_id: 'call_a',
        arguments: finalArguments,
      },
    },
    {
      event: 'response.completed',
      payload: {
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_a',
              call_id: 'call_a',
              output_index: 0,
              name: 'AskUserQuestion',
              arguments: finalArguments,
            },
          ],
        },
      },
    },
  ]);

  expect(result.inputJsonDeltas.length).toBe(1);
  expect(result.inputJsonDeltas[0]).toBe(finalArguments);
});

test('B: output_item.done with item.arguments works without function_call_arguments events', () => {
  const responseId = 'resp_b';
  const model = 'gpt-5.2';
  const finalArguments = '{"skill":"web-search"}';

  const result = runResponsesSequence([
    {
      event: 'response.output_item.done',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_b',
          call_id: 'call_b',
          name: 'Skill',
          arguments: finalArguments,
        },
      },
    },
    {
      event: 'response.completed',
      payload: {
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_b',
              call_id: 'call_b',
              output_index: 0,
              name: 'Skill',
              arguments: finalArguments,
            },
          ],
        },
      },
    },
  ]);

  expect(result.inputJsonDeltas.length).toBe(1);
  expect(result.inputJsonDeltas[0]).toBe(finalArguments);
});

test('C: delta before added keeps correct name/id and does not lose arguments', () => {
  const responseId = 'resp_c';
  const model = 'gpt-5.2';
  const finalArguments = '{"skill":"web-search"}';

  const result = runResponsesSequence([
    {
      event: 'response.function_call_arguments.delta',
      payload: {
        response_id: responseId,
        model,
        call_id: 'call_c',
        output_index: 0,
        delta: '{"skill":"web-search"}',
      },
    },
    {
      event: 'response.output_item.added',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_c',
          call_id: 'call_c',
          name: 'Skill',
        },
      },
    },
    {
      event: 'response.function_call_arguments.done',
      payload: {
        response_id: responseId,
        model,
        call_id: 'call_c',
        output_index: 0,
        arguments: finalArguments,
      },
    },
    {
      event: 'response.completed',
      payload: {
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_c',
              call_id: 'call_c',
              output_index: 0,
              name: 'Skill',
              arguments: finalArguments,
            },
          ],
        },
      },
    },
  ]);

  expect(result.inputJsonDeltas.length).toBe(1);
  expect(result.inputJsonDeltas[0]).toBe(finalArguments);
  expect(result.toolUseStarts.some((item) => item.name === 'Skill')).toBeTruthy();
});

test('D: output_item.done + function_call_arguments.done emits arguments only once', () => {
  const responseId = 'resp_d';
  const model = 'gpt-5.2';
  const finalArguments = '{"questions":[{"question":"Q","options":[{"label":"Y"}]}]}';

  const result = runResponsesSequence([
    {
      event: 'response.output_item.done',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_d',
          call_id: 'call_d',
          name: 'AskUserQuestion',
          arguments: finalArguments,
        },
      },
    },
    {
      event: 'response.function_call_arguments.done',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        call_id: 'call_d',
        arguments: finalArguments,
      },
    },
    {
      event: 'response.completed',
      payload: {
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_d',
              call_id: 'call_d',
              output_index: 0,
              name: 'AskUserQuestion',
              arguments: finalArguments,
            },
          ],
        },
      },
    },
  ]);

  expect(result.inputJsonDeltas.length).toBe(1);
  expect(result.inputJsonDeltas[0]).toBe(finalArguments);
});

test('E: mixed item_id/call_id mapping does not duplicate or mismatch calls', () => {
  const responseId = 'resp_e';
  const model = 'gpt-5.2';
  const finalArguments = '{"command":"rm -rf build"}';

  const result = runResponsesSequence([
    {
      event: 'response.output_item.added',
      payload: {
        response_id: responseId,
        model,
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_e',
          name: 'Bash',
        },
      },
    },
    {
      event: 'response.function_call_arguments.delta',
      payload: {
        response_id: responseId,
        model,
        output_index: 2,
        item_id: 'fc_e',
        delta: '{"command":"rm -rf ',
      },
    },
    {
      event: 'response.function_call_arguments.done',
      payload: {
        response_id: responseId,
        model,
        output_index: 2,
        item_id: 'fc_e',
        call_id: 'call_e',
        arguments: finalArguments,
      },
    },
    {
      event: 'response.completed',
      payload: {
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_e',
              call_id: 'call_e',
              output_index: 2,
              name: 'Bash',
              arguments: finalArguments,
            },
          ],
        },
      },
    },
  ]);

  expect(result.inputJsonDeltas.length).toBe(1);
  expect(result.inputJsonDeltas[0]).toBe(finalArguments);
});

test('F: two interleaved function calls keep arguments isolated', () => {
  const responseId = 'resp_f';
  const model = 'gpt-5.2';
  const args1 = '{"skill":"web-search"}';
  const args2 = '{"questions":[{"question":"Q","options":[{"label":"Y"}]}]}';

  const result = runResponsesSequence([
    {
      event: 'response.output_item.added',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_f1',
          call_id: 'call_f1',
          name: 'Skill',
        },
      },
    },
    {
      event: 'response.output_item.added',
      payload: {
        response_id: responseId,
        model,
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_f2',
          call_id: 'call_f2',
          name: 'AskUserQuestion',
        },
      },
    },
    {
      event: 'response.function_call_arguments.delta',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        call_id: 'call_f1',
        delta: '{"skill":"',
      },
    },
    {
      event: 'response.function_call_arguments.delta',
      payload: {
        response_id: responseId,
        model,
        output_index: 1,
        call_id: 'call_f2',
        delta: '{"questions":[{"question":"Q","options":[{"label":"Y"}]}]}',
      },
    },
    {
      event: 'response.function_call_arguments.delta',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        call_id: 'call_f1',
        delta: 'web-search"}',
      },
    },
    {
      event: 'response.function_call_arguments.done',
      payload: {
        response_id: responseId,
        model,
        output_index: 1,
        call_id: 'call_f2',
        arguments: args2,
      },
    },
    {
      event: 'response.function_call_arguments.done',
      payload: {
        response_id: responseId,
        model,
        output_index: 0,
        call_id: 'call_f1',
        arguments: args1,
      },
    },
    {
      event: 'response.completed',
      payload: {
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_f1',
              call_id: 'call_f1',
              output_index: 0,
              name: 'Skill',
              arguments: args1,
            },
            {
              type: 'function_call',
              id: 'fc_f2',
              call_id: 'call_f2',
              output_index: 1,
              name: 'AskUserQuestion',
              arguments: args2,
            },
          ],
        },
      },
    },
  ]);

  expect(result.inputJsonDeltas.length).toBe(2);
  expect(result.inputJsonDeltas.filter((item) => item === args1).length).toBe(1);
  expect(result.inputJsonDeltas.filter((item) => item === args2).length).toBe(1);
});

test('G: convertChatCompletionsRequestToResponsesRequest auto-injects missing function_call_output', () => {
  const request = testUtils.convertChatCompletionsRequestToResponsesRequest({
    model: 'gpt-5.2',
    stream: true,
    messages: [
      { role: 'user', content: 'make ppt' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_missing_output',
            type: 'function',
            function: {
              name: 'Skill',
              arguments: '{"skill":"pptx"}',
            },
          },
        ],
      },
    ],
  });

  const input = Array.isArray(request.input) ? request.input : [];
  const autoInjected = input.find((item: Record<string, unknown>) => (
    item?.type === 'function_call_output'
    && item?.call_id === 'call_missing_output'
  ));

  expect(autoInjected).toBeTruthy();
  expect(typeof autoInjected.output).toBe('string');
});

test('H: filterOpenAIToolsForProvider removes Skill tool and normalizes tool_choice', () => {
  const openAIRequest = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'Skill',
          parameters: {
            type: 'object',
            properties: {
              skill: { type: 'string' },
            },
            required: ['skill'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'Bash',
          parameters: { type: 'object' },
        },
      },
    ],
    tool_choice: {
      type: 'function',
      function: {
        name: 'Skill',
      },
    },
  };

  testUtils.filterOpenAIToolsForProvider(openAIRequest, 'openai');

  expect(openAIRequest.tools.length).toBe(1);
  expect(openAIRequest.tools[0].function.name).toBe('Bash');
  expect(openAIRequest.tool_choice).toBe('auto');
});

// ==================== SSE boundary tests ====================

test('findSSEPacketBoundary detects LF packet separator', () => {
  const boundary = testUtils.findSSEPacketBoundary('data: 1\n\ndata: 2\n\n');
  expect(boundary).toBeTruthy();
  expect(boundary.index).toBe(7);
  expect(boundary.separatorLength).toBe(2);
});

test('findSSEPacketBoundary detects CRLF packet separator', () => {
  const boundary = testUtils.findSSEPacketBoundary('data: 1\r\n\r\ndata: 2\r\n\r\n');
  expect(boundary).toBeTruthy();
  expect(boundary.index).toBe(7);
  expect(boundary.separatorLength).toBe(4);
});

test('findSSEPacketBoundary returns earliest separator in mixed input', () => {
  const boundary = testUtils.findSSEPacketBoundary('data: 1\r\n\r\ndata: 2\n\n');
  expect(boundary).toBeTruthy();
  expect(boundary.index).toBe(7);
  expect(boundary.separatorLength).toBe(4);
});

// ==================== DNS Rebinding protection tests ====================

const fakeReq = (host?: string): http.IncomingMessage =>
  ({ headers: host !== undefined ? { host } : {} }) as http.IncomingMessage;

describe('isAllowedProxyHost', () => {
  test('accepts 127.0.0.1 with port', () => {
    expect(isAllowedProxyHost(fakeReq('127.0.0.1:54321'))).toBe(true);
  });

  test('accepts 127.0.0.1 without port', () => {
    expect(isAllowedProxyHost(fakeReq('127.0.0.1'))).toBe(true);
  });

  test('accepts localhost with port', () => {
    expect(isAllowedProxyHost(fakeReq('localhost:12345'))).toBe(true);
  });

  test('accepts localhost without port', () => {
    expect(isAllowedProxyHost(fakeReq('localhost'))).toBe(true);
  });

  test('accepts [::1] with port', () => {
    expect(isAllowedProxyHost(fakeReq('[::1]:12345'))).toBe(true);
  });

  test('accepts [::1] without port', () => {
    expect(isAllowedProxyHost(fakeReq('[::1]'))).toBe(true);
  });

  test('allows missing Host header', () => {
    expect(isAllowedProxyHost(fakeReq(undefined))).toBe(true);
  });

  test('rejects attacker rebind domain', () => {
    expect(isAllowedProxyHost(fakeReq('evil.rebind.xxx:12345'))).toBe(false);
  });

  test('rejects attacker domain without port', () => {
    expect(isAllowedProxyHost(fakeReq('attacker.com'))).toBe(false);
  });

  test('rejects 0.0.0.0', () => {
    expect(isAllowedProxyHost(fakeReq('0.0.0.0:12345'))).toBe(false);
  });

  test('allows empty Host header (non-browser client)', () => {
    expect(isAllowedProxyHost(fakeReq(''))).toBe(true);
  });
});
