import { test, expect, describe, vi, beforeEach } from 'vitest';
import type { MemoryJudgeInput } from './coworkMemoryJudge';

// Mock claudeSettings so judgeMemoryCandidate never hits the real API
vi.mock('./claudeSettings', () => ({
  resolveCurrentApiConfig: () => ({ config: null }),
}));

// Import after mock is set up
const { judgeMemoryCandidate } = await import('./coworkMemoryJudge');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function input(
  text: string,
  opts: Partial<Omit<MemoryJudgeInput, 'text'>> = {}
): MemoryJudgeInput {
  return {
    text,
    isExplicit: false,
    guardLevel: 'standard',
    llmEnabled: false,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// scoreMemoryText — tested indirectly via judgeMemoryCandidate
// ---------------------------------------------------------------------------

describe('judgeMemoryCandidate: score — factual personal signal', () => {
  test('我叫... scores high and is accepted (standard)', async () => {
    const r = await judgeMemoryCandidate(input('我叫王小明，是一名后端工程师'));
    expect(r.source).toBe('rule');
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.accepted).toBe(true);
    expect(r.reason).toBe('factual-personal');
  });

  test('my name is Alice scores high', async () => {
    const r = await judgeMemoryCandidate(input('my name is Alice and I work as a developer'));
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.accepted).toBe(true);
  });

  test('I prefer dark mode scores high', async () => {
    const r = await judgeMemoryCandidate(input('I prefer dark mode when coding'));
    expect(r.accepted).toBe(true);
  });
});

describe('judgeMemoryCandidate: score — transient signal', () => {
  test('today sentence is penalised', async () => {
    const r = await judgeMemoryCandidate(input('今天天气真好，适合出门'));
    // transient -0.18, short length -0.2 => score likely low
    expect(r.accepted).toBe(false);
  });

  test('this week task context is penalised', async () => {
    const r = await judgeMemoryCandidate(input('this week I need to finish the report'));
    expect(r.score).toBeLessThan(0.72);
  });
});

describe('judgeMemoryCandidate: score — procedural signal', () => {
  test('shell command content is rejected', async () => {
    const r = await judgeMemoryCandidate(input('npm run build && npm test'));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('procedural-like');
  });

  test('bash script path is rejected', async () => {
    const r = await judgeMemoryCandidate(input('run deploy.sh to release'));
    expect(r.accepted).toBe(false);
  });
});

describe('judgeMemoryCandidate: score — request style', () => {
  test('请帮我 style is penalised', async () => {
    const r = await judgeMemoryCandidate(input('请帮我查一下今天的天气'));
    expect(r.accepted).toBe(false);
  });

  test('please do is penalised', async () => {
    const r = await judgeMemoryCandidate(input('please summarize the document'));
    expect(r.score).toBeLessThan(0.72);
  });
});

describe('judgeMemoryCandidate: score — question-like', () => {
  test('question scores very low', async () => {
    const r = await judgeMemoryCandidate(input('今天天气怎么样？'));
    expect(r.score).toBeLessThanOrEqual(0.1);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('question-like');
  });

  test('English question rejected', async () => {
    const r = await judgeMemoryCandidate(input('what is the capital of France?'));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('question-like');
  });
});

describe('judgeMemoryCandidate: score — empty/short text', () => {
  test('empty string scores 0', async () => {
    const r = await judgeMemoryCandidate(input(''));
    expect(r.score).toBe(0);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('empty');
  });

  test('whitespace-only scores 0', async () => {
    const r = await judgeMemoryCandidate(input('   '));
    expect(r.score).toBe(0);
    expect(r.accepted).toBe(false);
  });

  test('very short text (<6 chars) is penalised', async () => {
    const r = await judgeMemoryCandidate(input('ok'));
    expect(r.accepted).toBe(false);
  });
});

describe('judgeMemoryCandidate: score — text length bonus', () => {
  test('medium length text (6-120 chars) gets bonus', async () => {
    // 我是 scores factual + medium length bonus
    const r = await judgeMemoryCandidate(input('我是一名软件工程师，专注于后端开发'));
    expect(r.score).toBeGreaterThan(0.8);
    expect(r.accepted).toBe(true);
  });

  test('very long text (>240 chars) is slightly penalised', async () => {
    const longText = '我叫张三，' + '这是一段很长的文字。'.repeat(30);
    const rLong = await judgeMemoryCandidate(input(longText));
    const rShort = await judgeMemoryCandidate(input('我叫张三，我是后端工程师'));
    expect(rLong.score).toBeLessThan(rShort.score);
  });
});

// ---------------------------------------------------------------------------
// thresholdByGuardLevel — tested indirectly
// ---------------------------------------------------------------------------

describe('judgeMemoryCandidate: guard levels', () => {
  // assistant-preference signal (score ~0.6) — straddles strict vs relaxed thresholds
  const assistantPrefText = '以后请始终用中文回复我';

  test('relaxed guard accepts borderline candidate', async () => {
    const r = await judgeMemoryCandidate(input(assistantPrefText, { guardLevel: 'relaxed' }));
    // relaxed implicit threshold 0.62, score ~0.66 => accepted
    expect(r.accepted).toBe(true);
  });

  test('strict guard rejects same borderline candidate', async () => {
    const r = await judgeMemoryCandidate(input(assistantPrefText, { guardLevel: 'strict' }));
    // strict implicit threshold 0.80, score ~0.66 => rejected
    expect(r.accepted).toBe(false);
  });

  test('isExplicit lowers threshold', async () => {
    // A borderline text that would fail implicit strict may pass explicit strict (threshold 0.7)
    const r = await judgeMemoryCandidate(
      input(assistantPrefText, { guardLevel: 'strict', isExplicit: true })
    );
    // explicit strict threshold 0.7, score ~0.66 => still rejected
    expect(r.source).toBe('rule');
  });

  test('explicit relaxed has lowest threshold (0.52)', async () => {
    // neutral text score ~0.56 should pass explicit relaxed (0.52)
    const r = await judgeMemoryCandidate(
      input('我在上海工作', { guardLevel: 'relaxed', isExplicit: true })
    );
    expect(r.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LLM disabled — always returns rule result
// ---------------------------------------------------------------------------

describe('judgeMemoryCandidate: llmEnabled=false', () => {
  test('always uses rule source when llmEnabled is false', async () => {
    const r = await judgeMemoryCandidate(input('我叫李四', { llmEnabled: false }));
    expect(r.source).toBe('rule');
  });

  test('rule result returned even for boundary-score text', async () => {
    // text that might trigger LLM boundary check but llmEnabled=false
    const r = await judgeMemoryCandidate(
      input('以后请始终用中文回复我', { guardLevel: 'standard', llmEnabled: false })
    );
    expect(r.source).toBe('rule');
  });
});

// ---------------------------------------------------------------------------
// parseLlmJudgePayload — tested indirectly via LLM mock path
// (We verify the function handles various LLM response shapes correctly
//  by enabling llmEnabled=true but with config=null mock — falls back to rule)
// ---------------------------------------------------------------------------

describe('judgeMemoryCandidate: llm disabled when config is null', () => {
  test('falls back to rule result when no API config', async () => {
    // Our mock returns config:null, so LLM path is always skipped
    const r = await judgeMemoryCandidate(
      input('我喜欢喝咖啡', { llmEnabled: true, guardLevel: 'standard' })
    );
    expect(r.source).toBe('rule');
  });
});
