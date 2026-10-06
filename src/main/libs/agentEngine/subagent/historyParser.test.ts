import { describe, expect, test } from 'vitest';

import { parseSubagentGatewayHistoryMessages } from './historyParser';

const deterministicIds = (): (() => string) => {
  let index = 0;
  return () => `msg-${++index}`;
};

describe('subagent history parser', () => {
  test('reads assistant top-level toolCalls', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      {
        role: 'assistant',
        content: 'prepare workspace',
        toolCalls: [{
          id: 'call-mkdir',
          name: 'exec',
          arguments: { command: 'mkdir -p D:\\cus_sk' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-mkdir',
        name: 'exec',
        content: 'ok',
      },
    ], { createId: deterministicIds(), startTimestamp: 1000 });

    expect(messages).toEqual([
      { id: 'msg-1', type: 'assistant', content: 'prepare workspace', timestamp: 1000 },
      {
        id: 'msg-2',
        type: 'tool_use',
        content: '',
        timestamp: 1001,
        metadata: {
          toolName: 'exec',
          toolInput: { command: 'mkdir -p D:\\cus_sk' },
          toolUseId: 'call-mkdir',
        },
      },
      {
        id: 'msg-3',
        type: 'tool_result',
        content: 'ok',
        timestamp: 1002,
        metadata: { toolName: 'exec', toolResult: 'ok', toolUseId: 'call-mkdir' },
      },
    ]);
  });

  test('synthesizes missing exec tool use from PowerShell error output', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      {
        role: 'toolResult',
        toolCallId: 'call-mkdir',
        name: 'exec',
        content: [
          'mkdir : 具有指定名称 D:\\cus_sk 的项已存在。',
          '所在位置 行:1 字符: 1',
          '+ mkdir -p D:\\cus_sk',
          '+ ~~~~~~~~~~~~~~~~~~',
          '(Command exited with code 1)',
        ].join('\r\n'),
      },
    ], { createId: deterministicIds(), startTimestamp: 1000 });

    expect(messages).toEqual([
      {
        id: 'msg-2',
        type: 'tool_use',
        content: '',
        timestamp: 1000,
        metadata: {
          toolName: 'exec',
          toolInput: { command: 'mkdir -p D:\\cus_sk' },
          toolUseId: 'call-mkdir',
          inferredFromResult: true,
        },
      },
      {
        id: 'msg-1',
        type: 'tool_result',
        content: [
          'mkdir : 具有指定名称 D:\\cus_sk 的项已存在。',
          '所在位置 行:1 字符: 1',
          '+ mkdir -p D:\\cus_sk',
          '+ ~~~~~~~~~~~~~~~~~~',
          '(Command exited with code 1)',
        ].join('\r\n'),
        timestamp: 1000,
        metadata: {
          toolName: 'exec',
          toolResult: [
            'mkdir : 具有指定名称 D:\\cus_sk 的项已存在。',
            '所在位置 行:1 字符: 1',
            '+ mkdir -p D:\\cus_sk',
            '+ ~~~~~~~~~~~~~~~~~~',
            '(Command exited with code 1)',
          ].join('\r\n'),
          toolUseId: 'call-mkdir',
        },
      },
    ]);
  });
});
