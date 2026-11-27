import { describe, expect, test } from 'vitest';

import {
  estimateDecisionEvaluateTokens,
  estimateMcpServerTokensFromTools,
  estimateSkillCatalogTokens,
  estimateTextTokensCjkAware,
} from './tokenEstimator';

describe('contextCleanup tokenEstimator', () => {
  test('estimates mixed ASCII and CJK text tokens with CJK weighting', () => {
    expect(estimateTextTokensCjkAware('')).toBe(0);
    const ascii = estimateTextTokensCjkAware('a'.repeat(100));
    const cjk = estimateTextTokensCjkAware('中'.repeat(100));
    expect(ascii).toBe(25);
    expect(cjk).toBe(100);
    expect(cjk).toBeGreaterThan(ascii);
  });

  test('estimates skill catalog entry tokens and respects description clipping', () => {
    const shortTokens = estimateSkillCatalogTokens('weather', 'Get current weather.');
    const longDesc = '这是一段很长的中文技能描述'.repeat(30);
    const clipped160 = estimateSkillCatalogTokens('long-skill', longDesc, 160);
    const clipped80 = estimateSkillCatalogTokens('long-skill', longDesc, 80);

    expect(shortTokens).toBeGreaterThan(0);
    expect(clipped160).toBeGreaterThan(clipped80);
    expect(clipped80).toBeGreaterThan(shortTokens);
  });

  test('estimates decision_evaluate tokens realistically', () => {
    const jevTokens = estimateDecisionEvaluateTokens();
    expect(jevTokens).toBeGreaterThan(500);
    expect(jevTokens).toBeLessThan(1_200);
  });

  test('estimates MCP server tokens from discovered tools and flags unknown when missing', () => {
    expect(estimateMcpServerTokensFromTools(undefined)).toEqual({ tokens: 0, unknown: true });
    expect(estimateMcpServerTokensFromTools([])).toEqual({ tokens: 0, unknown: true });
    expect(estimateMcpServerTokensFromTools([
      { estimatedTokens: 120 },
      { estimatedTokens: 280 },
    ])).toEqual({ tokens: 400, unknown: false });
  });
});
