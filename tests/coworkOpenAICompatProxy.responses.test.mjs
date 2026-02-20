import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxyModule = require('../dist-electron/libs/coworkOpenAICompatProxy.js');
const testUtils = proxyModule.__openAICompatProxyTestUtils;

if (!testUtils) {
  throw new Error('__openAICompatProxyTestUtils is not available');
}

function createMockResponse() {
  let output = '';
  return {
    write(chunk) {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      return true;
    },
    getOutput() {
      return output;
    },
  };
}

function parseSSEEvents(raw) {
  const packets = raw.split('\n\n').filter(Boolean);
  const events = [];

  for (const packet of packets) {
    const lines = packet.split(/\r?\n/);
    let eventName = '';
    const dataLines = [];

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

    let dataParsed = dataRaw;
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

function collectInputJsonDeltas(events) {
  return events
    .filter((event) => event.event === 'content_block_delta')
    .map((event) => event.data)
    .filter((data) => data?.delta?.type === 'input_json_delta')
    .map((data) => String(data.delta.partial_json ?? ''));
}

function collectToolUseStarts(events) {
  return events
    .filter((event) => event.event === 'content_block_start')
    .map((event) => event.data)
    .filter((data) => data?.content_block?.type === 'tool_use')
    .map((data) => ({
      id: String(data.content_block.id ?? ''),
      name: String(data.content_block.name ?? ''),
    }));
}

function runResponsesSequence(sequence) {
  const response = createMockResponse();
  const state = testUtils.createStreamState();
  const context = testUtils.createResponsesStreamContext();

  for (const step of sequence) {
    testUtils.processResponsesStreamEvent(
      response,
      state,
      context,
      step.event,
      step.payload
    );
  }

  const events = parseSSEEvents(response.getOutput());
  return {
    events,
    inputJsonDeltas: collectInputJsonDeltas(events),
    toolUseStarts: collectToolUseStarts(events),
  };
}

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

  assert.equal(result.inputJsonDeltas.length, 1);
  assert.equal(result.inputJsonDeltas[0], finalArguments);
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

  assert.equal(result.inputJsonDeltas.length, 1);
  assert.equal(result.inputJsonDeltas[0], finalArguments);
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

  assert.equal(result.inputJsonDeltas.length, 1);
  assert.equal(result.inputJsonDeltas[0], finalArguments);
  assert.ok(result.toolUseStarts.some((item) => item.name === 'Skill'));
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

  assert.equal(result.inputJsonDeltas.length, 1);
  assert.equal(result.inputJsonDeltas[0], finalArguments);
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

  assert.equal(result.inputJsonDeltas.length, 1);
  assert.equal(result.inputJsonDeltas[0], finalArguments);
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

  assert.equal(result.inputJsonDeltas.length, 2);
  assert.equal(result.inputJsonDeltas.filter((item) => item === args1).length, 1);
  assert.equal(result.inputJsonDeltas.filter((item) => item === args2).length, 1);
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
  const autoInjected = input.find((item) => (
    item?.type === 'function_call_output'
    && item?.call_id === 'call_missing_output'
  ));

  assert.ok(autoInjected, 'expected proxy to auto-inject function_call_output');
  assert.equal(typeof autoInjected.output, 'string');
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

  assert.equal(openAIRequest.tools.length, 1);
  assert.equal(openAIRequest.tools[0].function.name, 'Bash');
  assert.equal(openAIRequest.tool_choice, 'auto');
});
