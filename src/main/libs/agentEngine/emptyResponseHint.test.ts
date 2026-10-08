import { describe, expect, test } from 'vitest';

import { CoworkSystemMessageKind } from '../../../common/coworkSystemMessages';
import type { CoworkMessage, CoworkMessageMetadata } from '../../coworkStore';
import {
  buildEmptyResponseHintMetadata,
  EmptyResponseHintMessageType as MessageType,
  EmptyResponseHintProtocol,
  findRecoveredEmptyResponseHintIds,
} from './emptyResponseHint';

const message = (
  id: string,
  type: CoworkMessage['type'],
  content = '',
  metadata?: CoworkMessageMetadata,
): CoworkMessage => ({ id, type, content, timestamp: 1, metadata });

const spawn = (callId: string, childRunId: string): CoworkMessage[] => [
  message(`use-${callId}`, MessageType.ToolUse, '', {
    toolUseId: callId,
    toolName: EmptyResponseHintProtocol.SpawnToolName,
  }),
  message(`result-${callId}`, MessageType.ToolResult, JSON.stringify({
    status: EmptyResponseHintProtocol.AcceptedStatus,
    runId: childRunId,
  }), { toolUseId: callId }),
];

const hint = (id: string, messages: readonly CoworkMessage[], runId: string): CoworkMessage => (
  message(id, MessageType.System, 'No visible reply', buildEmptyResponseHintMetadata(messages, runId))
);

describe('empty response hint ownership', () => {
  test('captures only accepted child runs paired to a spawn in the current user segment', () => {
    const messages = [
      message('user-old', MessageType.User),
      ...spawn('old', 'old-child'),
      message('user-current', MessageType.User),
      ...spawn('first', 'child-one'),
      ...spawn('second', 'child-two'),
      ...spawn('duplicate', 'child-one'),
      message('orphan', MessageType.ToolResult, JSON.stringify({
        status: EmptyResponseHintProtocol.AcceptedStatus,
        runId: 'orphan-child',
      }), { toolUseId: 'unknown' }),
    ];
    expect(buildEmptyResponseHintMetadata(messages, 'parent')).toEqual({
      kind: CoworkSystemMessageKind.EmptyResponse,
      runId: 'parent',
      userMessageId: 'user-current',
      childRunIds: ['child-one', 'child-two'],
    });
  });

  test('rejects failed, malformed, mismatched and non-spawn tool results', () => {
    const accepted = JSON.stringify({ status: EmptyResponseHintProtocol.AcceptedStatus, runId: 'child' });
    const candidates: Array<{ content: string; metadata?: CoworkMessageMetadata; toolName?: string }> = [
      { content: 'not JSON' },
      { content: '{}' },
      { content: JSON.stringify({ status: 'failed', runId: 'child' }) },
      { content: JSON.stringify({ status: EmptyResponseHintProtocol.AcceptedStatus, runId: '' }) },
      { content: JSON.stringify({ status: EmptyResponseHintProtocol.AcceptedStatus, runId: 'child:other' }) },
      { content: JSON.stringify({ status: EmptyResponseHintProtocol.AcceptedStatus, runId: 'child,other' }) },
      { content: JSON.stringify({ status: EmptyResponseHintProtocol.AcceptedStatus, runId: 'child other' }) },
      { content: JSON.stringify({ status: EmptyResponseHintProtocol.AcceptedStatus, runId: 'child', error: 'failed' }) },
      { content: accepted, metadata: { isError: true } },
      { content: accepted, metadata: { error: 'failed' } },
      { content: accepted, metadata: { toolName: 'exec' } },
      { content: accepted, toolName: 'exec' },
    ];
    for (const candidate of candidates) {
      const messages = [
        message('user', MessageType.User),
        message('use', MessageType.ToolUse, '', {
          toolUseId: 'call',
          toolName: candidate.toolName ?? EmptyResponseHintProtocol.SpawnToolName,
        }),
        message('result', MessageType.ToolResult, candidate.content, { toolUseId: 'call', ...candidate.metadata }),
      ];
      expect(buildEmptyResponseHintMetadata(messages, 'parent').childRunIds).toEqual([]);
    }
  });

  test('does not match a result against a tool use before the current user boundary', () => {
    const [use, result] = spawn('old-call', 'old-child');
    expect(buildEmptyResponseHintMetadata([
      message('old-user', MessageType.User), use,
      message('new-user', MessageType.User), result,
    ], 'new-parent').childRunIds).toEqual([]);
  });

  test('recovers the same run or an announce with an exact registered child token', () => {
    const messages = [message('user', MessageType.User), ...spawn('call', 'child-run')];
    messages.push(hint('hint', messages, 'parent'));
    expect(findRecoveredEmptyResponseHintIds(messages, 'parent')).toEqual(['hint']);
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:requester-settle:child-run:yield-1')).toEqual(['hint']);
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:v1:child-run')).toEqual(['hint']);
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:v1:prefix-child-run')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:v1:child-run-suffix')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'ordinary:child-run')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'child-run')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:v1:other-child')).toEqual([]);
  });

  test('an old A announce cannot remove the genuine empty-response hint of user B', () => {
    const messages = [message('user-A', MessageType.User), ...spawn('call-A', 'child-A')];
    messages.push(hint('hint-A', messages, 'parent-A'));
    messages.push(message('user-B', MessageType.User), ...spawn('call-B', 'child-B'));
    messages.push(hint('hint-B', messages, 'parent-B'));
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:requester-settle:child-A:yield-1')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'parent-A')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:requester-settle:child-B:yield-1')).toEqual(['hint-B']);
    expect(findRecoveredEmptyResponseHintIds(messages, 'parent-B')).toEqual(['hint-B']);
  });

  test('matches complete child run tokens inside comma-separated requester-settle batches', () => {
    const messages = [
      message('user', MessageType.User),
      ...spawn('first', 'child-one'),
      ...spawn('second', 'child-two'),
    ];
    messages.push(hint('hint', messages, 'parent'));
    const announce = (batch: string): string => `announce:requester-settle:agent:session:${batch}:yield-1`;
    expect(findRecoveredEmptyResponseHintIds(messages, announce('child-one,child-two'))).toEqual(['hint']);
    expect(findRecoveredEmptyResponseHintIds(messages, announce('other-child,child-two'))).toEqual(['hint']);
    expect(findRecoveredEmptyResponseHintIds(messages, announce('child-one,other-child'))).toEqual(['hint']);
    expect(findRecoveredEmptyResponseHintIds(messages, announce('prefix-child-one,child-two-suffix'))).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, announce('child-one-suffix,prefix-child-two'))).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'ordinary:child-one,child-two')).toEqual([]);
  });

  test('leaves legacy messages, missing ownership and other system messages untouched', () => {
    const messages = [
      message('user', MessageType.User),
      message('legacy', MessageType.System, 'No visible reply'),
      message('no-anchor', MessageType.System, '', { kind: CoworkSystemMessageKind.EmptyResponse, runId: 'parent' }),
      message('no-run', MessageType.System, '', {
        kind: CoworkSystemMessageKind.EmptyResponse, userMessageId: 'user', childRunIds: ['child'],
      }),
      message('other', MessageType.System, '', { kind: CoworkSystemMessageKind.ContextCompaction, runId: 'parent', userMessageId: 'user' }),
    ];
    expect(findRecoveredEmptyResponseHintIds(messages, 'parent')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, 'announce:v1:child')).toEqual([]);
    expect(findRecoveredEmptyResponseHintIds(messages, '')).toEqual([]);
    expect(buildEmptyResponseHintMetadata([], 'parent')).toEqual({
      kind: CoworkSystemMessageKind.EmptyResponse, runId: 'parent', childRunIds: [],
    });
    expect(findRecoveredEmptyResponseHintIds([hint('hint', [], 'parent')], 'parent')).toEqual([]);
  });
});
