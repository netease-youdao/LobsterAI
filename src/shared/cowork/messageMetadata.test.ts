import { describe, expect, it } from 'vitest';

import { mergeCoworkMessageMetadata } from './messageMetadata';

describe('persisted and rendered message metadata', () => {
  it('keeps display details during a streaming-only update and supports explicit clearing', () => {
    const previous = { toolUseId: 'call', toolName: 'Read', isThinking: true, isStreaming: true, error: 'old' };
    const next = mergeCoworkMessageMetadata(previous, { isStreaming: false, isFinal: true, error: null });
    expect(next).toEqual({ ...previous, isStreaming: false, isFinal: true, error: null });
    expect(previous.isStreaming).toBe(true);
  });
  it('retains media assets and the greatest poll count while accepting the latest status', () => {
    const previous = { toolResultDetails: { assets: ['image'], pollCount: 5, status: 'running' } };
    expect(mergeCoworkMessageMetadata(previous, { toolResultDetails: { pollCount: 2, status: 'succeeded' } }))
      .toEqual({ toolResultDetails: { assets: ['image'], pollCount: 5, status: 'succeeded' } });
    expect(mergeCoworkMessageMetadata(previous, { toolResultDetails: null }).toolResultDetails).toBeNull();
  });
});
