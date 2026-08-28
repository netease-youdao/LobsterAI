/**
 * Unit tests for coworkMemoryExtractor.ts
 *
 * Covers:
 *   - isQuestionLikeMemoryText: question detection across Chinese/English patterns
 *   - extractTurnMemoryChanges: explicit add/delete commands
 *   - extractTurnMemoryChanges: implicit memory extraction (profile/ownership/preference)
 *   - guard level confidence thresholds (strict / standard / relaxed)
 *   - edge cases: empty inputs, code blocks, small talk, deduplication
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isQuestionLikeMemoryText,
  extractTurnMemoryChanges,
} = require('../dist-electron/main/libs/coworkMemoryExtractor.js');

// ---------------------------------------------------------------------------
// isQuestionLikeMemoryText
// ---------------------------------------------------------------------------

test('question: ends with ?', () => {
  assert.equal(isQuestionLikeMemoryText('你好吗?'), true);
  assert.equal(isQuestionLikeMemoryText('Are you sure?'), true);
});

test('question: ends with Chinese question mark', () => {
  assert.equal(isQuestionLikeMemoryText('你吃饭了吗？'), true);
});

test('question: Chinese prefix — 请问', () => {
  assert.equal(isQuestionLikeMemoryText('请问这是什么'), true);
});

test('question: Chinese prefix — 为什么', () => {
  assert.equal(isQuestionLikeMemoryText('为什么这样写'), true);
});

test('question: Chinese suffix — 吗', () => {
  assert.equal(isQuestionLikeMemoryText('这样可以吗'), true);
});

test('question: Chinese suffix — 么', () => {
  assert.equal(isQuestionLikeMemoryText('这样行么'), true);
});

test('question: inline Chinese modal — 能不能', () => {
  assert.equal(isQuestionLikeMemoryText('你能不能帮我'), true);
});

test('question: English prefix — what', () => {
  assert.equal(isQuestionLikeMemoryText('what is the weather today'), true);
});

test('question: English prefix — how', () => {
  assert.equal(isQuestionLikeMemoryText('how do I use this'), true);
});

test('question: English prefix — can', () => {
  assert.equal(isQuestionLikeMemoryText('can you help me'), true);
});

test('question: English prefix — is (case insensitive)', () => {
  assert.equal(isQuestionLikeMemoryText('Is this correct?'), true);
});

test('not a question: plain personal fact', () => {
  assert.equal(isQuestionLikeMemoryText('我叫张三'), false);
});

test('not a question: preference statement', () => {
  assert.equal(isQuestionLikeMemoryText('我喜欢用 Python 写代码'), false);
});

test('not a question: empty string', () => {
  assert.equal(isQuestionLikeMemoryText(''), false);
});

test('not a question: ends with period stripped', () => {
  assert.equal(isQuestionLikeMemoryText('我叫李四。'), false);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — explicit add
// ---------------------------------------------------------------------------

const ASSISTANT_ACK = '好的，我已经记住了。';

test('explicit add: Chinese 记住 command extracts both explicit and implicit', () => {
  // "记住：我是一名前端工程师" triggers explicit add for the captured part,
  // AND implicit extraction since "我是" matches PERSONAL_PROFILE_SIGNAL_RE
  const result = extractTurnMemoryChanges({
    userText: '记住：我是一名前端工程师',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  // Explicit: "我是一名前端工程师", Implicit: "记住：我是一名前端工程师"
  assert.ok(result.length >= 1);
  const explicitEntry = result.find((r) => r.isExplicit);
  assert.ok(explicitEntry);
  assert.equal(explicitEntry.action, 'add');
  assert.equal(explicitEntry.text, '我是一名前端工程师');
  assert.ok(Math.abs(explicitEntry.confidence - 0.99) < 0.01);
});

test('explicit add: Chinese 记下 command triggers implicit profile', () => {
  // "记下：我住在上海" — capture "我住在上海" (5 chars, < 6, no SHORT_FACT_SIGNAL match)
  // so explicit is rejected by shouldKeepCandidate, but implicit catches
  // "记下：我住在上海" via PERSONAL_PROFILE_SIGNAL_RE (我住在)
  const result = extractTurnMemoryChanges({
    userText: '记下：我住在上海',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  assert.equal(result.length, 1);
  // The implicit entry contains the full unsplit text
  assert.ok(result[0].text.includes('我住在上海'));
});

test('explicit add: English remember command extracts both explicit and implicit', () => {
  // "remember: I prefer TypeScript over JavaScript" triggers explicit add
  // AND implicit extraction from PERSONAL_PREFERENCE_SIGNAL_RE (I prefer)
  const result = extractTurnMemoryChanges({
    userText: 'remember: I prefer TypeScript over JavaScript',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  assert.ok(result.length >= 1);
  const explicitEntry = result.find((r) => r.isExplicit);
  assert.ok(explicitEntry);
  assert.equal(explicitEntry.text, 'I prefer TypeScript over JavaScript');
});

test('explicit add: English "remember this" variant', () => {
  const result = extractTurnMemoryChanges({
    userText: 'remember this: I work at Netease',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  assert.ok(result.length >= 1);
  const explicitEntry = result.find((r) => r.isExplicit);
  assert.ok(explicitEntry);
  assert.equal(explicitEntry.text, 'I work at Netease');
});

test('explicit add: deduplicates identical explicit adds', () => {
  const result = extractTurnMemoryChanges({
    userText: '记住：我叫小明\n记住：我叫小明',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  // One explicit + potentially one implicit (different text due to prefix)
  const explicitCount = result.filter((r) => r.isExplicit).length;
  assert.equal(explicitCount, 1);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — explicit delete
// ---------------------------------------------------------------------------

test('explicit delete: Chinese 忘掉 command', () => {
  // "忘掉：我是前端工程师" → explicit delete captures "我是前端工程师"
  // Also triggers implicit add via PERSONAL_PROFILE_SIGNAL_RE
  const result = extractTurnMemoryChanges({
    userText: '忘掉：我是前端工程师',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  const deleteEntry = result.find((r) => r.action === 'delete');
  assert.ok(deleteEntry);
  assert.equal(deleteEntry.isExplicit, true);
  assert.equal(deleteEntry.text, '我是前端工程师');
});

test('explicit delete: Chinese 删除记忆 command with short capture', () => {
  // "删除记忆：我住在杭州" — capture "我住在杭州" is 5 chars, rejected by shouldKeepCandidate
  // Implicit picks up the full text via PERSONAL_PROFILE_SIGNAL_RE
  const result = extractTurnMemoryChanges({
    userText: '删除记忆：我住在杭州',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  assert.ok(result.length >= 1);
  // Result contains an add from implicit, since the delete capture was too short
  assert.ok(result[0].text.includes('我住在杭州'));
});

test('explicit delete: English forget command', () => {
  const result = extractTurnMemoryChanges({
    userText: 'forget this: I use Vim',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  const deleteEntry = result.find((r) => r.action === 'delete');
  assert.ok(deleteEntry);
  assert.equal(deleteEntry.text, 'I use Vim');
});

test('explicit delete appears before explicit add in merged results', () => {
  // "记住：我叫新名字\n忘掉：我叫旧名字"
  // Both explicit captures pass (5 chars but SHORT_FACT_SIGNAL_RE matches 我叫)
  // Implicit also fires on both full-text lines
  const result = extractTurnMemoryChanges({
    userText: '记住：我叫新名字\n忘掉：我叫旧名字',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  const deleteIdx = result.findIndex((r) => r.action === 'delete' && r.isExplicit);
  const addIdx = result.findIndex((r) => r.action === 'add' && r.isExplicit);
  assert.ok(deleteIdx >= 0);
  assert.ok(addIdx >= 0);
  // Merge order: deletes first, then adds
  assert.ok(deleteIdx < addIdx);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — implicit add (personal profile)
// ---------------------------------------------------------------------------

test('implicit: personal profile — 我叫', () => {
  const result = extractTurnMemoryChanges({
    userText: '我叫王伟，帮我分析这段代码',
    assistantText: '当然，我来分析一下。',
    guardLevel: 'standard',
  });
  const profileEntry = result.find((r) => r.reason === 'implicit:personal-profile');
  assert.ok(profileEntry);
  assert.equal(profileEntry.action, 'add');
  assert.ok(profileEntry.confidence >= 0.9);
});

test('implicit: personal profile — my name is (English)', () => {
  const result = extractTurnMemoryChanges({
    userText: 'My name is Alice, please help me debug this',
    assistantText: 'Sure, let me look at the code.',
    guardLevel: 'standard',
  });
  const profileEntry = result.find((r) => r.reason === 'implicit:personal-profile');
  assert.ok(profileEntry);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — implicit add (personal ownership)
// ---------------------------------------------------------------------------

test('implicit: personal ownership — 我养了', () => {
  const result = extractTurnMemoryChanges({
    userText: '我养了一只猫，帮我起一个名字',
    assistantText: '好的，这里有几个可爱的名字……',
    guardLevel: 'standard',
  });
  const ownershipEntry = result.find((r) => r.reason === 'implicit:personal-ownership');
  assert.ok(ownershipEntry);
  assert.ok(ownershipEntry.confidence >= 0.85);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — implicit add (personal preference)
// ---------------------------------------------------------------------------

test('implicit: personal preference — 我喜欢', () => {
  const result = extractTurnMemoryChanges({
    userText: '我喜欢用 VS Code 开发，给我推荐插件',
    assistantText: '以下是一些推荐的插件……',
    guardLevel: 'standard',
  });
  const prefEntry = result.find((r) => r.reason === 'implicit:personal-preference');
  assert.ok(prefEntry);
  assert.ok(prefEntry.confidence >= 0.85);
});

test('implicit: assistant preference — 以后请用中文回复', () => {
  const result = extractTurnMemoryChanges({
    userText: '以后请始终用中文回复我',
    assistantText: '好的，我会用中文回复。',
    guardLevel: 'standard',
  });
  const assistantPref = result.find((r) => r.reason === 'implicit:assistant-preference');
  assert.ok(assistantPref);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — guard levels
// ---------------------------------------------------------------------------

test('guard: strict level filters out borderline implicit candidates', () => {
  const relaxedResult = extractTurnMemoryChanges({
    userText: '我喜欢用 Neovim 写代码',
    assistantText: '好的。',
    guardLevel: 'relaxed',
  });
  const strictResult = extractTurnMemoryChanges({
    userText: '我喜欢用 Neovim 写代码',
    assistantText: '好的。',
    guardLevel: 'strict',
  });
  assert.ok(relaxedResult.length >= strictResult.length);
});

test('guard: explicit adds always pass regardless of guard level', () => {
  const strictResult = extractTurnMemoryChanges({
    userText: '记住：我的 API key 是 sk-xxx',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'strict',
  });
  assert.ok(strictResult.length >= 1);
  const explicitEntry = strictResult.find((r) => r.isExplicit);
  assert.ok(explicitEntry);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — code block stripping
// ---------------------------------------------------------------------------

test('code block: text inside code blocks is not extracted as implicit memory', () => {
  const result = extractTurnMemoryChanges({
    userText: '```python\nmy name is admin\n```\n帮我运行这段代码',
    assistantText: '好的，运行结果如下……',
    guardLevel: 'relaxed',
  });
  const hasCodeContent = result.some((r) => r.text.includes('admin'));
  assert.equal(hasCodeContent, false);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — small talk rejection
// ---------------------------------------------------------------------------

test('small talk: "好的" alone is not extracted', () => {
  const result = extractTurnMemoryChanges({
    userText: '好的',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'relaxed',
  });
  assert.equal(result.filter((r) => !r.isExplicit).length, 0);
});

test('small talk: "ok" alone is not extracted', () => {
  const result = extractTurnMemoryChanges({
    userText: 'ok',
    assistantText: 'Sure.',
    guardLevel: 'relaxed',
  });
  assert.equal(result.filter((r) => !r.isExplicit).length, 0);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — empty / missing inputs
// ---------------------------------------------------------------------------

test('edge: empty userText returns no changes', () => {
  const result = extractTurnMemoryChanges({
    userText: '',
    assistantText: ASSISTANT_ACK,
    guardLevel: 'standard',
  });
  assert.deepEqual(result, []);
});

test('edge: empty assistantText returns no changes', () => {
  const result = extractTurnMemoryChanges({
    userText: '我叫小明',
    assistantText: '',
    guardLevel: 'standard',
  });
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — maxImplicitAdds cap
// ---------------------------------------------------------------------------

test('maxImplicitAdds: caps implicit results at 2 by default', () => {
  const result = extractTurnMemoryChanges({
    userText: '我叫王芳，我喜欢摄影，我养了一只狗',
    assistantText: '好的，了解了。',
    guardLevel: 'relaxed',
    maxImplicitAdds: 2,
  });
  const implicitCount = result.filter((r) => !r.isExplicit).length;
  assert.ok(implicitCount <= 2);
});

test('maxImplicitAdds: 0 disables implicit extraction entirely', () => {
  const result = extractTurnMemoryChanges({
    userText: '我叫王芳，我喜欢摄影',
    assistantText: '好的，了解了。',
    guardLevel: 'relaxed',
    maxImplicitAdds: 0,
  });
  const implicitCount = result.filter((r) => !r.isExplicit).length;
  assert.equal(implicitCount, 0);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — non-durable topic rejection
// ---------------------------------------------------------------------------

test('non-durable: error/exception reports are not extracted as memory', () => {
  const result = extractTurnMemoryChanges({
    userText: '我有一个问题，程序报错了',
    assistantText: '请提供错误信息。',
    guardLevel: 'relaxed',
  });
  const implicitCount = result.filter((r) => !r.isExplicit).length;
  assert.equal(implicitCount, 0);
});

// ---------------------------------------------------------------------------
// extractTurnMemoryChanges — transient signal rejection
// ---------------------------------------------------------------------------

test('transient: date-specific info is not extracted as memory', () => {
  const result = extractTurnMemoryChanges({
    userText: '今天天气真好，帮我推荐一些户外活动',
    assistantText: '好的，这里有一些推荐……',
    guardLevel: 'relaxed',
  });
  const implicitCount = result.filter((r) => !r.isExplicit).length;
  assert.equal(implicitCount, 0);
});
