import { describe, expect, test } from 'vitest';

import { applyLocalTurnUsageToEntries } from './openclawConversationReconciliation';

const trace = (id: string) => ({ traceId: id.repeat(32), startedAt: 1 });

describe('applyLocalTurnUsageToEntries', () => {
  test('keeps local turn usage on replacing user entries, matched in order by text', () => {
    const local = [
      { role: 'user' as const, text: 'hi', metadata: { llmTrace: trace('a'), turnUsage: { status: 'settled' }, other: 1 } },
      { role: 'assistant' as const, text: 'hello', metadata: { llmTrace: trace('x') } },
      { role: 'user' as const, text: 'hi', metadata: { llmTrace: trace('b'), turnMediaTaskIds: ['7'] } },
      { role: 'user' as const, text: 'bye', metadata: { modelPresetId: 'balanced', resolvedModelId: 'deepseek-flash' } },
    ];

    const entries = applyLocalTurnUsageToEntries([
      { role: 'user', text: 'hi', metadata: { localMediaAttachments: [] } },
      { role: 'assistant', text: 'hello' },
      { role: 'user', text: 'hi' },
      { role: 'user', text: 'bye' },
      { role: 'user', text: 'new' },
    ], local);

    expect(entries).toEqual([
      {
        role: 'user',
        text: 'hi',
        metadata: { localMediaAttachments: [], llmTrace: trace('a'), turnUsage: { status: 'settled' } },
      },
      { role: 'assistant', text: 'hello' },
      { role: 'user', text: 'hi', metadata: { llmTrace: trace('b'), turnMediaTaskIds: ['7'] } },
      { role: 'user', text: 'bye', metadata: { modelPresetId: 'balanced', resolvedModelId: 'deepseek-flash' } },
      { role: 'user', text: 'new' },
    ]);
  });

  test('does not replace usage that the entry already carries', () => {
    const [entry] = applyLocalTurnUsageToEntries(
      [{ role: 'user', text: 'hi', metadata: { llmTrace: trace('c') } }],
      [{ role: 'user', text: 'hi', metadata: { llmTrace: trace('a'), turnUsage: { status: 'settled' } } }],
    );

    expect(entry.metadata).toEqual({ llmTrace: trace('c') });
  });
});
