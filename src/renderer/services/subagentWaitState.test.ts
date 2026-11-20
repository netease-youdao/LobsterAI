import { expect, test } from 'vitest';

import { SubagentToolName, SubagentYield } from '../../shared/cowork/subagent';
import type { CoworkMessage, SubagentSessionSummary } from '../types/cowork';
import { getSubagentWaitPhase, SubagentWaitPhase } from './subagentWaitState';

const messages: CoworkMessage[] = [
  { id: 'u', type: 'user', content: 'delegate', timestamp: 1 },
  { id: 's', type: 'tool_use', content: '', timestamp: 2, metadata: { toolName: SubagentToolName.Spawn, toolUseId: 'spawn' } },
  { id: 'y', type: 'tool_use', content: '', timestamp: 3, metadata: { toolName: SubagentToolName.Yield, toolUseId: 'yield' } },
  { id: 'r', type: 'tool_result', content: JSON.stringify({ status: SubagentYield.ResultStatus }), timestamp: 4, metadata: { toolUseId: 'yield' } },
];
const child: SubagentSessionSummary = {
  id: 'spawn', parentSessionId: 'parent', agentId: 'main', task: 'read', label: null,
  sessionKey: 'agent:main:dashboard:child', status: 'running', createdAt: 2, endedAt: null,
};

test('dsh wait follows the activated native child until the parent summarizes', () => {
  const turn: CoworkMessage[] = [
    messages[0],
    { ...messages[1], metadata: { toolName: SubagentToolName.DshFork, toolUseId: 'fork' } },
    { id: 'result', type: 'tool_result', content: 'worker', timestamp: 3, metadata: { toolUseId: 'fork', subagentRunId: 'dsh:child' } },
    { ...messages[2], metadata: { toolName: SubagentToolName.DshWait, toolUseId: 'wait' } },
  ];
  const nativeChild = { ...child, id: 'dsh:child' };
  expect(getSubagentWaitPhase(turn, [nativeChild])).toBe(SubagentWaitPhase.Children);
  expect(getSubagentWaitPhase(turn, [{ ...nativeChild, status: 'done' }])).toBe(SubagentWaitPhase.Summary);
  expect(getSubagentWaitPhase([...turn, messages[0]], [nativeChild])).toBeNull();
});

test('waits for children, then summary, and clears when the parent resumes', () => {
  expect(getSubagentWaitPhase(messages, [child])).toBe(SubagentWaitPhase.Children);
  expect(getSubagentWaitPhase(messages, [{ ...child, status: 'done' }])).toBe(SubagentWaitPhase.Summary);
  expect(getSubagentWaitPhase([...messages, { id: 'answer', type: 'assistant', content: 'summary', timestamp: 5 }], [child])).toBeNull();
});

test('old children and unsuccessful handoffs cannot make a new request wait', () => {
  expect(getSubagentWaitPhase([...messages, { id: 'new', type: 'user', content: 'next', timestamp: 5 }], [child])).toBeNull();
  expect(getSubagentWaitPhase(messages.slice(0, -1), [child])).toBeNull();
  expect(getSubagentWaitPhase(messages, [{ ...child, id: 'old-spawn' }])).toBeNull();
  expect(getSubagentWaitPhase([...messages.slice(0, -1), { ...messages[3], content: '{"status":"error"}' }], [child])).toBeNull();
});
