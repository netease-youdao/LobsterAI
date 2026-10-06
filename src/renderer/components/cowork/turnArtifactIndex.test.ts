import { expect, test } from 'vitest';

import type { Artifact } from '../../types/artifact';
import { ArtifactTypeValue, PREVIEWABLE_ARTIFACT_TYPES } from '../../types/artifact';
import type { CoworkMessage } from '../../types/cowork';
import { type ConversationTurn, getTurnMessageIds } from './messageDisplayUtils';
import { indexTurnArtifacts } from './turnArtifactIndex';

const message = (id: string): CoworkMessage => ({
  id,
  type: 'assistant',
  content: '',
  timestamp: 0,
});
function original(turns: ConversationTurn[], artifacts: Artifact[]): Artifact[][] {
  return turns.map(turn => {
    const ids = new Set<string>();
    if (turn.userMessage) ids.add(turn.userMessage.id);
    for (const item of turn.assistantItems) {
      if (item.type === 'assistant' || item.type === 'system' || item.type === 'tool_result')
        ids.add(item.message.id);
      else if (item.type === 'tool_group') {
        ids.add(item.group.toolUse.id);
        if (item.group.toolResult) ids.add(item.group.toolResult.id);
      }
    }
    return artifacts.filter(a => ids.has(a.messageId) && PREVIEWABLE_ARTIFACT_TYPES.has(a.type));
  });
}
const artifact = (
  messageId: string,
  type: Artifact['type'] = ArtifactTypeValue.Html,
): Artifact => ({
  id: 'same-id',
  messageId,
  type,
  sessionId: 'fixture',
  title: '',
  content: '',
  createdAt: 0,
});
test('all message kinds, empty IDs, repeated messages/turn IDs/artifacts retain order and exact refs', () => {
  const turn: ConversationTurn = {
    id: 'same-turn',
    userMessage: message(''),
    assistantItems: [
      { type: 'assistant', message: message('assistant') },
      { type: 'system', message: message('system') },
      { type: 'tool_result', message: message('result') },
      {
        type: 'tool_group',
        group: { type: 'tool_group', toolUse: message('use'), toolResult: message('group-result') },
      },
      { type: 'tool_group', group: { type: 'tool_group', toolUse: message('assistant') } },
    ],
  };
  const turns = [
    turn,
    { ...turn, userMessage: null },
    { id: 'empty', userMessage: null, assistantItems: [] },
  ];
  const shared = artifact('assistant');
  const artifacts = [
    artifact(''),
    shared,
    artifact('system'),
    artifact('result'),
    artifact('use'),
    artifact('group-result'),
    shared,
    artifact('absent'),
    artifact('assistant', ArtifactTypeValue.Code),
  ];
  const expected = original(turns, artifacts),
    actual = indexTurnArtifacts(turns, artifacts);
  expect(actual).toEqual(expected);
  actual.forEach((items, index) =>
    items.forEach((item, i) => expect(item).toBe(expected[index][i])),
  );
  expect(getTurnMessageIds(turn)).toEqual(
    new Set(['', 'assistant', 'system', 'result', 'use', 'group-result']),
  );
  expect(indexTurnArtifacts([], artifacts)).toEqual([]);
  expect(indexTurnArtifacts(turns, [])).toEqual([[], [], []]);
});
test('deterministic generated cases equal the original Set/filter projection including duplicate matches', () => {
  let seed = 417;
  const next = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const types = Object.values(ArtifactTypeValue);
  for (let iteration = 0; iteration < 150; iteration++) {
    const turns: ConversationTurn[] = Array.from({ length: next(15) }, () => ({
      id: 'collision',
      userMessage: next(2) ? message(String(next(8))) : null,
      assistantItems: Array.from({ length: next(10) }, () => {
        const id = String(next(8));
        switch (next(4)) {
          case 0:
            return { type: 'assistant', message: message(id) };
          case 1:
            return { type: 'system', message: message(id) };
          case 2:
            return { type: 'tool_result', message: message(id) };
          default:
            return {
              type: 'tool_group',
              group: {
                type: 'tool_group',
                toolUse: message(id),
                toolResult: next(2) ? message(String(next(8))) : null,
              },
            };
        }
      }),
    }));
    const artifacts = Array.from({ length: next(150) }, () =>
      artifact(String(next(10)), types[next(types.length)]),
    );
    if (artifacts[0]) artifacts.push(artifacts[0]);
    const expected = original(turns, artifacts),
      actual = indexTurnArtifacts(turns, artifacts);
    expect(actual).toEqual(expected);
    actual.forEach((items, i) => items.forEach((item, j) => expect(item).toBe(expected[i][j])));
  }
});

test('examines each artifact once regardless of conversation length', () => {
  const turns: ConversationTurn[] = Array.from({ length: 200 }, (_, index) => ({
    id: String(index),
    userMessage: message(String(index)),
    assistantItems: [],
  }));
  let visits = 0;
  const artifacts = Array.from({ length: 1000 }, (_, index) => ({
    messageId: String(index % 200),
    get type() {
      visits += 1;
      return ArtifactTypeValue.Html;
    },
  }));
  const indexed = indexTurnArtifacts(turns, artifacts);
  expect(visits).toBe(1000);
  expect(indexed.every(items => items.length === 5)).toBe(true);
});
