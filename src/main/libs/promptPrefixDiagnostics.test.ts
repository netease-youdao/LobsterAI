import { describe, expect, test } from 'vitest';

import {
  comparePromptFingerprints,
  extractPromptUsage,
  fingerprintPromptRequest,
  formatPromptPrefixObservation,
  mergePromptUsage,
  PromptPrefixBoundary,
  PromptPrefixChange,
  PromptPrefixTracker,
  resolvePromptAnchorKey,
  resolvePromptCacheSuspect,
} from './promptPrefixDiagnostics';

type Body = Record<string, unknown> & { messages: Array<Record<string, unknown>> };

const SYSTEM_PROMPT = [
  '# Project Context',
  'Stable workspace rules.',
  '## Runtime',
  'Runtime: agent=main channel=webchat',
].join('\n');

function tool(name: string, description = `${name} tool`) {
  return { type: 'function', function: { name, description, parameters: { type: 'object' } } };
}

function openAiBody(overrides: Partial<Body> = {}): Body {
  return {
    model: 'deepseek-flash',
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer', reasoning_content: 'thinking' },
    ],
    tools: [tool('exec'), tool('read')],
    ...overrides,
  };
}

function fingerprint(body: unknown) {
  const result = fingerprintPromptRequest(body, JSON.stringify(body).length);
  if (!result) throw new Error('expected a fingerprint');
  return result;
}

describe('fingerprintPromptRequest', () => {
  test('ignores bodies that are not chat requests', () => {
    expect(fingerprintPromptRequest({ model: 'x' }, 10)).toBeNull();
    expect(fingerprintPromptRequest('nope', 4)).toBeNull();
  });

  test('splits leading OpenAI system messages from the conversation', () => {
    const result = fingerprint(openAiBody());
    expect(result.systemText).toBe(SYSTEM_PROMPT);
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(result.toolNames).toEqual(['exec', 'read']);
    expect(Object.keys(result.params)).toEqual(['model', 'stream']);
  });

  test('reads the Anthropic top-level system prompt', () => {
    const result = fingerprint({
      model: 'claude',
      system: [{ type: 'text', text: 'Be brief.' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.systemText).toBe('Be brief.');
    expect(result.messages).toHaveLength(1);
  });
});

describe('comparePromptFingerprints', () => {
  test('treats appended messages as cache friendly', () => {
    const previous = openAiBody();
    const current = openAiBody({
      messages: [...previous.messages, { role: 'user', content: 'next question' }],
    });
    const result = comparePromptFingerprints(fingerprint(previous), fingerprint(current));
    expect(result.change).toBe(PromptPrefixChange.Append);
    expect(result.alsoChanged).toEqual([]);
    expect(result.previousMessages).toBe(2);
    expect(result.currentMessages).toBe(3);
    expect(result.stableBytes).toBeGreaterThan(0);
  });

  test('locates a system prompt change by offset, distance from the end and heading', () => {
    const changed = SYSTEM_PROMPT.replace('channel=webchat', 'channel=feishu');
    const previous = openAiBody();
    const current = openAiBody({
      messages: [{ role: 'system', content: changed }, ...previous.messages.slice(1)],
    });
    const result = comparePromptFingerprints(fingerprint(previous), fingerprint(current));
    expect(result.change).toBe(PromptPrefixChange.System);
    const offset = SYSTEM_PROMPT.indexOf('webchat');
    expect(result.detail).toContain(`offset=${offset}`);
    expect(result.detail).toContain(`fromEnd=${changed.length - offset}`);
    expect(result.detail).toContain('heading=##_Runtime');
    expect(result.stableBytes).toBe(0);
  });

  test('reports a reordered tool list that a sorted digest would miss', () => {
    const result = comparePromptFingerprints(
      fingerprint(openAiBody()),
      fingerprint(openAiBody({ tools: [tool('read'), tool('exec')] })),
    );
    expect(result.change).toBe(PromptPrefixChange.ToolsOrder);
    expect(result.detail).toContain('firstIndex=0 prev=exec cur=read');
  });

  test('names tools that were added, removed or changed', () => {
    const result = comparePromptFingerprints(
      fingerprint(openAiBody()),
      fingerprint(openAiBody({ tools: [tool('exec', 'new text'), tool('write')] })),
    );
    expect(result.change).toBe(PromptPrefixChange.Tools);
    expect(result.detail).toContain('added=write');
    expect(result.detail).toContain('removed=read');
    expect(result.detail).toContain('changed=exec');
  });

  test('names the message fields that changed in history', () => {
    const previous = openAiBody();
    const current = openAiBody({
      messages: [
        previous.messages[0],
        previous.messages[1],
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'next question' },
      ],
    });
    const result = comparePromptFingerprints(fingerprint(previous), fingerprint(current));
    expect(result.change).toBe(PromptPrefixChange.Message);
    expect(result.detail).toContain('index=1 fromPrevEnd=1 role=assistant fields=reasoning_content');
  });

  test('reports dropped history separately from rewritten history', () => {
    const previous = openAiBody();
    const current = openAiBody({ messages: previous.messages.slice(0, 2) });
    const result = comparePromptFingerprints(fingerprint(previous), fingerprint(current));
    expect(result.change).toBe(PromptPrefixChange.Truncated);
    expect(result.detail).toBe('kept=1 dropped=1');
  });

  test('puts request parameter changes ahead of prompt changes', () => {
    const result = comparePromptFingerprints(
      fingerprint(openAiBody()),
      fingerprint(openAiBody({ reasoning_effort: 'high', tools: [tool('read'), tool('exec')] })),
    );
    expect(result.change).toBe(PromptPrefixChange.Params);
    expect(result.detail).toBe('keys=reasoning_effort');
    expect(result.alsoChanged).toEqual([PromptPrefixChange.ToolsOrder]);
    expect(result.stableBytes).toBe(0);
  });
});

describe('PromptPrefixTracker', () => {
  test('marks the first request and labels step and turn boundaries', () => {
    const tracker = new PromptPrefixTracker();
    const body = openAiBody();
    expect(tracker.observe('s1', 'trace-a', fingerprint(body), 1_000).change).toBe(PromptPrefixChange.First);

    const step = tracker.observe('s1', 'trace-a', fingerprint(body), 1_500);
    expect(step.boundary).toBe(PromptPrefixBoundary.Step);
    expect(step.sincePreviousMs).toBe(500);

    const turn = tracker.observe('s1', 'trace-b', fingerprint(body), 2_000);
    expect(turn.boundary).toBe(PromptPrefixBoundary.Turn);
    expect(turn.change).toBe(PromptPrefixChange.Append);
  });

  test('forgets the least recently used conversation beyond its capacity', () => {
    const tracker = new PromptPrefixTracker(2);
    const body = fingerprint(openAiBody());
    tracker.observe('a', 't', body);
    tracker.observe('b', 't', body);
    tracker.observe('a', 't', body);
    tracker.observe('c', 't', body);
    expect(tracker.observe('b', 't', body).change).toBe(PromptPrefixChange.First);
    expect(tracker.observe('a', 't', body).change).toBe(PromptPrefixChange.First);
  });

  test('keeps a session heartbeat from replacing the conversation it interleaves with', () => {
    const tracker = new PromptPrefixTracker();
    const conversation = openAiBody();
    tracker.observe('s1', 'turn-1', fingerprint(conversation), 1_000);

    const heartbeat = tracker.observe('s1', 'turn-1', fingerprint({
      model: 'deepseek-flash',
      messages: [{ role: 'system', content: 'heartbeat rules' }, { role: 'user', content: 'heartbeat poll' }],
    }), 2_000);
    expect(heartbeat.change).toBe(PromptPrefixChange.First);
    expect(heartbeat.detail).toBe('newLineage tracked=1');

    const followUp = tracker.observe('s1', 'turn-2', fingerprint(openAiBody({
      messages: [...conversation.messages, { role: 'user', content: 'next question' }],
    })), 1_416_000);
    expect(followUp.change).toBe(PromptPrefixChange.Append);
    expect(followUp.boundary).toBe(PromptPrefixBoundary.Turn);
    expect(followUp.sincePreviousMs).toBe(1_415_000);
    expect(followUp.matchedMessages).toBe(2);
  });

  test('still reports a changed system prompt against the conversation it belongs to', () => {
    const tracker = new PromptPrefixTracker();
    const conversation = openAiBody();
    tracker.observe('s1', 'turn-1', fingerprint(conversation));
    const changed = tracker.observe('s1', 'turn-2', fingerprint(openAiBody({
      messages: [{ role: 'system', content: `${SYSTEM_PROMPT} extra` }, ...conversation.messages.slice(1)],
    })));
    expect(changed.change).toBe(PromptPrefixChange.System);
    expect(changed.matchedMessages).toBe(2);
  });

  test('anchors requests without a conversation id on model and first message', () => {
    const base = fingerprint(openAiBody());
    const longer = fingerprint(openAiBody({ messages: [...openAiBody().messages, { role: 'user', content: 'x' }] }));
    expect(resolvePromptAnchorKey(base)).toBe(resolvePromptAnchorKey(longer));
    expect(resolvePromptAnchorKey(base)).not.toBe(resolvePromptAnchorKey(fingerprint(openAiBody({ model: 'other' }))));
  });
});

describe('usage', () => {
  test('reads DeepSeek, OpenAI and Anthropic usage shapes', () => {
    expect(extractPromptUsage({
      usage: { prompt_tokens: 664341, prompt_cache_hit_tokens: 43136, prompt_cache_miss_tokens: 621205 },
    })).toEqual({ promptTokens: 664341, cachedTokens: 43136 });
    expect(extractPromptUsage({
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } },
    })).toEqual({ promptTokens: 100, cachedTokens: 64 });
    expect(extractPromptUsage({
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 } },
    })).toEqual({ promptTokens: 95, cachedTokens: 80 });
    expect(extractPromptUsage({ choices: [] })).toBeNull();
  });

  test('keeps earlier counts when a later packet omits them', () => {
    expect(mergePromptUsage({ promptTokens: 95, cachedTokens: 80 }, { promptTokens: 96 }))
      .toEqual({ promptTokens: 96, cachedTokens: 80 });
  });

  test('suspects the upstream when an unchanged prefix still missed', () => {
    const tracker = new PromptPrefixTracker();
    const body = fingerprint(openAiBody());
    tracker.observe('s', 'a', body);
    const observation = tracker.observe('s', 'b', body);
    expect(resolvePromptCacheSuspect(observation, { promptTokens: 600_000, cachedTokens: 43_136 })).toBe('upstream');
    expect(resolvePromptCacheSuspect(observation, { promptTokens: 600_000, cachedTokens: 599_000 })).toBeNull();
    expect(resolvePromptCacheSuspect(observation, undefined)).toBeNull();
  });

  test('suspects the prompt when a changed prefix missed', () => {
    const tracker = new PromptPrefixTracker();
    tracker.observe('s', 'a', fingerprint(openAiBody()));
    const observation = tracker.observe('s', 'b', fingerprint(openAiBody({ tools: [tool('read'), tool('exec')] })));
    expect(resolvePromptCacheSuspect(observation, { promptTokens: 600_000, cachedTokens: 43_136 })).toBe('prompt');
  });

  test('formats one log line without message text', () => {
    const tracker = new PromptPrefixTracker();
    tracker.observe('s', 'a', fingerprint(openAiBody()), 0);
    const observation = tracker.observe('s', 'b', fingerprint(openAiBody({
      messages: [...openAiBody().messages, { role: 'user', content: 'private words' }],
    })), 32_000);
    const line = formatPromptPrefixObservation(observation, { promptTokens: 664341, cachedTokens: 43136 });
    expect(line).toContain('boundary=turn change=append');
    expect(line).toContain('sincePrevMs=32000');
    expect(line).toContain('promptTokens=664341 cachedTokens=43136(6%)');
    expect(line).toContain('suspect=upstream');
    expect(line).not.toContain('private words');
  });
});
