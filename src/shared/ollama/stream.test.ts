import { describe, expect, test } from 'vitest';

import { createOllamaStreamState, reduceOllamaStreamChunk, splitThinkMarkup } from './stream';

describe('ollama stream reducer', () => {
  test('accumulates streaming content and final metrics', () => {
    let state = createOllamaStreamState();

    state = reduceOllamaStreamChunk(state, {
      message: { role: 'assistant', content: 'hello ' },
    });
    state = reduceOllamaStreamChunk(state, {
      message: { role: 'assistant', content: 'world' },
      done: true,
      eval_count: 12,
      eval_duration: 3_000_000_000,
    });

    expect(state.content).toBe('hello world');
    expect(state.phase).toBe('done');
    expect(state.done).toBe(true);
    expect(state.finalChunk?.eval_count).toBe(12);
  });

  test('separates official thinking from final content', () => {
    let state = createOllamaStreamState();

    state = reduceOllamaStreamChunk(state, {
      message: { role: 'assistant', content: '', thinking: 'thinking...' },
    });
    state = reduceOllamaStreamChunk(state, {
      message: { role: 'assistant', content: 'answer' },
    });

    expect(state.thinking).toBe('thinking...');
    expect(state.content).toBe('answer');
    expect(state.phase).toBe('responding');
  });

  test('splits legacy think markup out of content', () => {
    expect(splitThinkMarkup('<think>hidden</think>visible')).toEqual({
      thinking: 'hidden',
      content: 'visible',
    });
  });

  test('surfaces stream error chunks', () => {
    const state = reduceOllamaStreamChunk(createOllamaStreamState(), {
      error: 'model not found',
      done: true,
    });

    expect(state.phase).toBe('error');
    expect(state.error).toBe('model not found');
    expect(state.done).toBe(true);
  });
});
