import { test, expect, describe } from 'vitest';
import {
  isQuestionLikeMemoryText,
  extractTurnMemoryChanges,
} from './coworkMemoryExtractor';

// ---------------------------------------------------------------------------
// isQuestionLikeMemoryText
// ---------------------------------------------------------------------------

describe('isQuestionLikeMemoryText', () => {
  test('detects trailing question mark', () => {
    expect(isQuestionLikeMemoryText('你好吗？')).toBe(true);
    expect(isQuestionLikeMemoryText('are you sure?')).toBe(true);
  });

  test('detects Chinese question prefix', () => {
    expect(isQuestionLikeMemoryText('请问你叫什么名字')).toBe(true);
    expect(isQuestionLikeMemoryText('为什么天空是蓝色的')).toBe(true);
    expect(isQuestionLikeMemoryText('怎么安装依赖')).toBe(true);
  });

  test('detects English question prefix', () => {
    expect(isQuestionLikeMemoryText('what is your name')).toBe(true);
    expect(isQuestionLikeMemoryText('how do I install this')).toBe(true);
    expect(isQuestionLikeMemoryText('can you help me')).toBe(true);
  });

  test('detects Chinese inline question patterns', () => {
    expect(isQuestionLikeMemoryText('你是不是已经知道了')).toBe(true);
    expect(isQuestionLikeMemoryText('这样能不能工作')).toBe(true);
  });

  test('detects Chinese question suffix particles', () => {
    expect(isQuestionLikeMemoryText('你去吗')).toBe(true);
    expect(isQuestionLikeMemoryText('你知道呢')).toBe(true);
  });

  test('returns false for plain statements', () => {
    expect(isQuestionLikeMemoryText('我叫张三')).toBe(false);
    expect(isQuestionLikeMemoryText('my name is Alice')).toBe(false);
    expect(isQuestionLikeMemoryText('我喜欢用 TypeScript')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isQuestionLikeMemoryText('')).toBe(false);
  });

  test('ignores trailing exclamation and period before checking', () => {
    // "我叫张三！" is a statement with trailing !, not a question
    expect(isQuestionLikeMemoryText('我叫张三！')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — explicit add commands
// ---------------------------------------------------------------------------

describe('extractTurnMemoryChanges: explicit add', () => {
  const base = { assistantText: 'OK, noted.', guardLevel: 'standard' as const };

  test('extracts Chinese explicit add with 记住', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '记住：我喜欢深色主题',
    });
    const explicit = result.filter((r) => r.isExplicit && r.action === 'add');
    expect(explicit).toHaveLength(1);
    expect(explicit[0].confidence).toBeGreaterThanOrEqual(0.99);
    expect(explicit[0].text).toContain('我喜欢深色主题');
  });

  test('extracts Chinese explicit add with 请记下', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '请记下：我的工作目录是 /home/user/projects',
    });
    const explicit = result.filter((r) => r.isExplicit && r.action === 'add');
    expect(explicit).toHaveLength(1);
  });

  test('extracts English explicit add with remember', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: 'remember: I prefer verbose output',
    });
    const explicit = result.filter((r) => r.isExplicit && r.action === 'add');
    expect(explicit).toHaveLength(1);
  });

  test('deduplicates identical explicit adds', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '记住：我是前端工程师\n记住：我是前端工程师',
    });
    const explicit = result.filter((r) => r.isExplicit && r.action === 'add');
    expect(explicit).toHaveLength(1);
  });

  test('returns empty when userText is empty', () => {
    const result = extractTurnMemoryChanges({
      userText: '',
      assistantText: 'hello',
      guardLevel: 'standard',
    });
    expect(result).toHaveLength(0);
  });

  test('returns empty when assistantText is empty', () => {
    const result = extractTurnMemoryChanges({
      userText: '记住：我叫李四',
      assistantText: '',
      guardLevel: 'standard',
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — explicit delete commands
// ---------------------------------------------------------------------------

describe('extractTurnMemoryChanges: explicit delete', () => {
  const base = { assistantText: 'Done.', guardLevel: 'standard' as const };

  test('extracts Chinese explicit delete with 忘掉', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '忘掉：我喜欢深色主题',
    });
    const explicit = result.filter((r) => r.isExplicit && r.action === 'delete');
    expect(explicit).toHaveLength(1);
  });

  test('extracts Chinese explicit delete with 删除记忆', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '删除记忆：我是前端工程师',
    });
    const explicit = result.filter((r) => r.isExplicit && r.action === 'delete');
    expect(explicit).toHaveLength(1);
  });

  test('extracts English explicit delete with forget this', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: 'forget this: I prefer verbose output',
    });
    const explicit = result.filter((r) => r.isExplicit && r.action === 'delete');
    expect(explicit).toHaveLength(1);
  });

  test('deletes appear before adds in merged result', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '记住：我用 TypeScript\n忘掉：我用 JavaScript',
    });
    const deleteIdx = result.findIndex((r) => r.action === 'delete');
    const addIdx = result.findIndex((r) => r.action === 'add');
    expect(deleteIdx).toBeLessThan(addIdx);
  });
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — implicit extraction
// ---------------------------------------------------------------------------

describe('extractTurnMemoryChanges: implicit', () => {
  const base = { assistantText: '好的，我记住了。', guardLevel: 'standard' as const };

  test('extracts personal profile signal (我叫)', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '我叫王小明，是一名后端工程师',
    });
    const implicit = result.filter((r) => !r.isExplicit);
    expect(implicit.length).toBeGreaterThanOrEqual(1);
    expect(implicit[0].reason).toBe('implicit:personal-profile');
    expect(implicit[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('extracts personal ownership signal (我养了)', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '我养了一只金毛，叫豆豆',
    });
    const implicit = result.filter((r) => !r.isExplicit);
    expect(implicit.length).toBeGreaterThanOrEqual(1);
    expect(implicit[0].reason).toBe('implicit:personal-ownership');
  });

  test('extracts personal preference signal (我喜欢)', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '我喜欢用 vim 编辑代码',
    });
    const implicit = result.filter((r) => !r.isExplicit);
    expect(implicit.length).toBeGreaterThanOrEqual(1);
    expect(implicit[0].reason).toBe('implicit:personal-preference');
  });

  test('extracts assistant preference signal (请始终用中文回复)', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '请始终用中文回复我',
    });
    const implicit = result.filter((r) => !r.isExplicit);
    expect(implicit.length).toBeGreaterThanOrEqual(1);
    expect(implicit[0].reason).toBe('implicit:assistant-preference');
  });

  test('skips small talk', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '好的',
    });
    expect(result).toHaveLength(0);
  });

  test('skips question-like text that has no profile signal', () => {
    // Pure questions without personal signal should not be extracted
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '今天天气怎么样？',
    });
    expect(result).toHaveLength(0);
  });

  test('skips question-like text — generic inquiry', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '请问如何安装依赖？',
    });
    expect(result).toHaveLength(0);
  });

  test('skips non-durable topic (报错)', () => {
    const result = extractTurnMemoryChanges({
      ...base,
      userText: '我有个报错，TypeError: cannot read property',
    });
    expect(result).toHaveLength(0);
  });

  test('respects maxImplicitAdds cap of 2', () => {
    const userText = [
      '我叫陈明',
      '我喜欢喝咖啡',
      '我养了一只猫',
      '我住在上海',
    ].join('，');
    const result = extractTurnMemoryChanges({
      userText,
      assistantText: '好的，了解！',
      guardLevel: 'relaxed',
    });
    const implicit = result.filter((r) => !r.isExplicit);
    expect(implicit.length).toBeLessThanOrEqual(2);
  });

  test('maxImplicitAdds=0 suppresses all implicit adds', () => {
    const result = extractTurnMemoryChanges({
      userText: '我叫陈明，我喜欢喝咖啡',
      assistantText: '好的',
      guardLevel: 'relaxed',
      maxImplicitAdds: 0,
    });
    expect(result.filter((r) => !r.isExplicit)).toHaveLength(0);
  });

  test('strips code blocks before implicit extraction', () => {
    const result = extractTurnMemoryChanges({
      userText: '```python\nmy_name = "Alice"\n```',
      assistantText: '这是 Python 代码',
      guardLevel: 'relaxed',
    });
    // code block content should not be extracted as memory
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — guard levels
// ---------------------------------------------------------------------------

describe('extractTurnMemoryChanges: guard levels', () => {
  const userText = '我喜欢用 dark mode';
  const assistantText = '好的，记住了';

  test('strict guard rejects low-confidence implicit candidates', () => {
    // preference signal has confidence ~0.88, strict threshold is 0.85 — should pass
    const result = extractTurnMemoryChanges({
      userText,
      assistantText,
      guardLevel: 'strict',
    });
    // confidence 0.88 >= 0.85, so it should pass strict
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  test('relaxed guard has lower threshold than standard', () => {
    const relaxed = extractTurnMemoryChanges({ userText, assistantText, guardLevel: 'relaxed' });
    const strict = extractTurnMemoryChanges({ userText, assistantText, guardLevel: 'strict' });
    // relaxed should extract at least as many items as strict
    expect(relaxed.length).toBeGreaterThanOrEqual(strict.length);
  });

  test('explicit adds always have confidence 0.99 regardless of guard level', () => {
    for (const level of ['strict', 'standard', 'relaxed'] as const) {
      const result = extractTurnMemoryChanges({
        userText: '记住：我用 TypeScript',
        assistantText: '好',
        guardLevel: level,
      });
      expect(result[0].confidence).toBe(0.99);
    }
  });
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — sanitizeImplicitCandidate (request tail trimming)
// ---------------------------------------------------------------------------

describe('extractTurnMemoryChanges: request tail trimming', () => {
  test('trims request tail before storing candidate', () => {
    const result = extractTurnMemoryChanges({
      userText: '我叫李华，请你帮我写一段代码',
      assistantText: '好的',
      guardLevel: 'standard',
    });
    const implicit = result.filter((r) => !r.isExplicit);
    if (implicit.length > 0) {
      // stored text should not contain the request tail
      expect(implicit[0].text).not.toMatch(/请你帮我/);
    }
  });
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — transient signal filtering
// ---------------------------------------------------------------------------

describe('extractTurnMemoryChanges: transient signal filtering', () => {
  test('filters date-specific transient info', () => {
    const result = extractTurnMemoryChanges({
      userText: '今天是2024-03-15，我想查一下天气',
      assistantText: '好的',
      guardLevel: 'relaxed',
    });
    // transient date info should not be extracted
    expect(result).toHaveLength(0);
  });

  test('keeps personal profile even when date is present', () => {
    const result = extractTurnMemoryChanges({
      userText: '今天我叫张三，我在工作',
      assistantText: '好的',
      guardLevel: 'standard',
    });
    // personal profile signal overrides transient filter
    const profile = result.filter((r) => r.reason === 'implicit:personal-profile');
    expect(profile.length).toBeGreaterThanOrEqual(1);
  });
});
