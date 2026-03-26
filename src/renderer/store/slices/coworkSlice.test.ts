import { describe, it, expect } from 'vitest';
import {
  computeStreamingSuffixPrefixOverlap,
  mergeStreamingMessageContent,
} from './coworkSlice';

describe('computeStreamingSuffixPrefixOverlap', () => {
  it('returns 0 for empty strings', () => {
    expect(computeStreamingSuffixPrefixOverlap('', '')).toBe(0);
    expect(computeStreamingSuffixPrefixOverlap('abc', '')).toBe(0);
    expect(computeStreamingSuffixPrefixOverlap('', 'abc')).toBe(0);
  });

  it('returns 0 when no overlap exists', () => {
    expect(computeStreamingSuffixPrefixOverlap('abc', 'xyz')).toBe(0);
  });

  it('detects exact suffix-prefix overlap', () => {
    expect(computeStreamingSuffixPrefixOverlap('hello world', 'world peace')).toBe(5);
    expect(computeStreamingSuffixPrefixOverlap('abcdef', 'defghi')).toBe(3);
  });

  it('detects single-character overlap', () => {
    expect(computeStreamingSuffixPrefixOverlap('abc', 'cde')).toBe(1);
  });

  it('detects full overlap when right is a suffix of left', () => {
    expect(computeStreamingSuffixPrefixOverlap('abcdef', 'def')).toBe(3);
  });

  it('detects full overlap when left ends with entire right', () => {
    expect(computeStreamingSuffixPrefixOverlap('xxxabc', 'abc')).toBe(3);
  });

  it('handles identical strings', () => {
    expect(computeStreamingSuffixPrefixOverlap('abc', 'abc')).toBe(3);
  });

  it('handles repeated patterns correctly', () => {
    expect(computeStreamingSuffixPrefixOverlap('ababab', 'ababc')).toBe(4);
    expect(computeStreamingSuffixPrefixOverlap('aaaaaa', 'aaab')).toBe(3);
  });

  it('handles long strings within probe window', () => {
    const left = 'x'.repeat(400) + 'overlap_here';
    const right = 'overlap_here' + 'y'.repeat(400);
    expect(computeStreamingSuffixPrefixOverlap(left, right)).toBe(12);
  });
});

describe('mergeStreamingMessageContent', () => {
  it('returns incoming when previous is empty', () => {
    expect(mergeStreamingMessageContent('', 'hello')).toBe('hello');
  });

  it('returns previous when incoming is empty', () => {
    expect(mergeStreamingMessageContent('hello', '')).toBe('hello');
  });

  it('returns same content when identical', () => {
    expect(mergeStreamingMessageContent('hello', 'hello')).toBe('hello');
  });

  it('handles snapshot mode (incoming extends previous)', () => {
    expect(mergeStreamingMessageContent('hello', 'hello world')).toBe('hello world');
  });

  it('keeps previous when incoming is a prefix (partial rollback)', () => {
    expect(mergeStreamingMessageContent('hello world', 'hello')).toBe('hello world');
  });

  it('merges delta with overlap', () => {
    expect(mergeStreamingMessageContent('hello world', 'world peace')).toBe('hello world peace');
  });

  it('appends delta with no overlap', () => {
    expect(mergeStreamingMessageContent('hello', ' world')).toBe('hello world');
  });
});
