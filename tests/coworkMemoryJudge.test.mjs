/**
 * Unit tests for coworkMemoryJudge.ts
 *
 * Tests the rule-based memory candidate validation engine.
 * All tests use llmEnabled: false to exercise only the deterministic rule path.
 *
 * Key behaviours under test:
 *   - scoreMemoryText: text pattern scoring (factual-personal, transient,
 *     procedural, assistant-preference, request-style, length, question-like)
 *   - thresholdByGuardLevel: acceptance thresholds vary by guard level + explicit flag
 *   - judgeMemoryCandidate: accept / reject decisions across guard levels
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { judgeMemoryCandidate } = require('../dist-electron/main/libs/coworkMemoryJudge.js');

// Helper: synchronous wrapper (llmEnabled=false guarantees no async I/O)
async function judge(text, { isExplicit = false, guardLevel = 'standard' } = {}) {
  return judgeMemoryCandidate({ text, isExplicit, guardLevel, llmEnabled: false });
}

// ==================== 空/极短文本 ====================

test('empty string is rejected by all guard levels', async () => {
  for (const level of ['strict', 'standard', 'relaxed']) {
    const r = await judge('', { guardLevel: level });
    assert.equal(r.accepted, false, `expected rejection for guardLevel=${level}`);
    assert.equal(r.source, 'rule');
    assert.equal(r.reason, 'empty');
  }
});

test('whitespace-only text is rejected (empty after trim)', async () => {
  const r = await judge('   ');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'empty');
});

test('very short text (<6 chars) scores lower and is rejected in strict mode', async () => {
  // "OK" is 2 chars — well below threshold in any mode
  const r = await judge('OK', { guardLevel: 'strict' });
  assert.equal(r.accepted, false);
  assert.equal(r.source, 'rule');
});

// ==================== 疑问句检测 ====================

test('question ending with ? is rejected (question-like)', async () => {
  const r = await judge('你能帮我做什么?');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'question-like');
});

test('question ending with full-width ？ is rejected', async () => {
  const r = await judge('What is your name？');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'question-like');
});

test('Chinese question words 吗/呢 trigger question-like rejection', async () => {
  const r1 = await judge('你好吗');
  const r2 = await judge('完成了呢');
  assert.equal(r1.reason, 'question-like');
  assert.equal(r2.reason, 'question-like');
});

// ==================== 过程性/命令性文本 ====================

test('shell command text is procedural and rejected', async () => {
  const r = await judge('npm install && npm run build');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'procedural-like');
});

test('text with bash shebang path is procedural and rejected', async () => {
  const r = await judge('cd /tmp/ && python setup.py install');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'procedural-like');
});

test('imperative "执行以下命令" text is procedural and rejected', async () => {
  const r = await judge('执行以下命令来部署服务');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'procedural-like');
});

// ==================== 临时性/时效性文本 ====================

test('text containing "今天" is penalised as transient', async () => {
  // "今天天气很好" lacks factual profile signals, transient penalty should dominate
  const r = await judge('今天天气很好', { guardLevel: 'strict' });
  assert.equal(r.accepted, false);
});

test('text with "临时" marker is penalised as transient', async () => {
  const r = await judge('临时使用这个配置', { guardLevel: 'strict' });
  assert.equal(r.accepted, false);
});

test('text with "this week" is penalised as transient', async () => {
  const r = await judge('I will be travelling this week', { guardLevel: 'strict' });
  assert.equal(r.accepted, false);
});

// ==================== 个人事实 (高分) ====================

test('Chinese self-introduction "我叫" is accepted in standard mode', async () => {
  const r = await judge('我叫张三，是一名后端工程师', { guardLevel: 'standard' });
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'factual-personal');
  assert.equal(r.source, 'rule');
});

test('English self-introduction "my name is" is accepted', async () => {
  const r = await judge("My name is Alice and I'm a product manager");
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'factual-personal');
});

test('"我喜欢" preference is accepted in standard mode', async () => {
  const r = await judge('我喜欢用 TypeScript 写代码', { guardLevel: 'standard' });
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'factual-personal');
});

test('"I prefer" preference is accepted in standard mode', async () => {
  const r = await judge('I prefer dark mode in all my editors');
  assert.equal(r.accepted, true);
});

test('"我住在" is a durable geographic fact and is accepted', async () => {
  const r = await judge('我住在北京，平时工作节奏很快', { guardLevel: 'standard' });
  assert.equal(r.accepted, true);
});

// ==================== 助手偏好指令 ====================

test('assistant style directive "以后请用中文回复" is accepted when explicit', async () => {
  // score=0.66 (assistant-preference bonus +0.1, length +0.06)
  // standard-explicit threshold=0.60 → accepted; standard-implicit=0.72 → rejected
  const r = await judge('以后请用中文回复', { isExplicit: true, guardLevel: 'standard' });
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'assistant-preference');
});

test('"请始终用简洁的语气回答" is accepted when explicit+relaxed', async () => {
  // score=0.52 (request penalty -0.14 offsets assistant +0.1)
  // relaxed-explicit threshold=0.52 → accepted at boundary
  const r = await judge('请始终用简洁的语气回答我的问题', { isExplicit: true, guardLevel: 'relaxed' });
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'assistant-preference');
});

test('"请不要使用 Markdown 格式" is accepted when explicit+relaxed', async () => {
  // same scoring as above: score=0.52, relaxed-explicit threshold=0.52 → accepted
  const r = await judge('请不要在回复中使用 Markdown 格式', { isExplicit: true, guardLevel: 'relaxed' });
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'assistant-preference');
});

// ==================== 请求语气惩罚 ====================

test('"帮我" request-style text without profile signals is rejected in strict mode', async () => {
  const r = await judge('帮我整理一下这份文档', { guardLevel: 'strict' });
  assert.equal(r.accepted, false);
});

test('"please do X" without durable facts is rejected in strict mode', async () => {
  const r = await judge('Please write a poem about spring', { guardLevel: 'strict' });
  assert.equal(r.accepted, false);
});

// ==================== Guard level 阈值差异 ====================

test('borderline text is rejected in strict but accepted in relaxed mode', async () => {
  // "默认使用英文代码命名" — assistant-preference signal: score=0.66
  // strict-implicit threshold=0.80  → rejected
  // relaxed-implicit threshold=0.62 → accepted
  const text = '默认使用英文代码命名';
  const strict = await judge(text, { guardLevel: 'strict' });
  const relaxed = await judge(text, { guardLevel: 'relaxed' });
  assert.equal(strict.accepted, false, 'strict should reject borderline text');
  assert.equal(relaxed.accepted, true, 'relaxed should accept borderline text');
});

test('explicit flag lowers acceptance threshold vs implicit', async () => {
  // Same borderline text: explicit threshold < implicit threshold
  // A neutral sentence that is below implicit but above explicit threshold
  // "I work as a freelancer" — "i work as" hits factual profile
  const text = 'I work as a freelancer and manage my own schedule';
  const implicit = await judge(text, { isExplicit: false, guardLevel: 'strict' });
  const explicit = await judge(text, { isExplicit: true, guardLevel: 'strict' });
  // explicit threshold is lower → more likely to accept
  assert.equal(explicit.accepted, true, 'explicit should be accepted');
  // implicit strict threshold is 0.80, factual score ~0.78 → still might reject
  // (just verify that explicit has higher acceptance rate, i.e. explicit accepted OR both rejected)
  if (!implicit.accepted) {
    assert.equal(explicit.accepted, true); // explicit always at least as permissive
  }
});

test('result always contains required fields', async () => {
  const r = await judge('我是一名前端工程师');
  assert.ok('accepted' in r);
  assert.ok('score' in r);
  assert.ok('reason' in r);
  assert.ok('source' in r);
  assert.equal(typeof r.score, 'number');
  assert.ok(r.score >= 0 && r.score <= 1, `score out of [0,1]: ${r.score}`);
  assert.equal(r.source, 'rule');
});

test('score is always clamped to [0, 1]', async () => {
  const inputs = [
    'npm install --save-dev eslint && npx eslint --fix ./src',  // heavy procedural penalty
    '我叫李雷，我住在上海，我喜欢骑行，I prefer dark theme',   // many factual signals
    '',                                                           // empty
  ];
  for (const text of inputs) {
    const r = await judge(text, { guardLevel: 'relaxed' });
    assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} out of range for: "${text}"`);
  }
});

// ==================== LLM 不调用 (llmEnabled=false) ====================

test('source is always "rule" when llmEnabled is false', async () => {
  // Even a borderline score should not trigger LLM since llmEnabled=false
  const texts = [
    '我习惯每天早上复盘昨天的工作',  // borderline — might be in LLM margin
    '今天很开心',
    '我叫王芳',
  ];
  for (const text of texts) {
    const r = await judge(text, { guardLevel: 'standard', llmEnabled: false });
    assert.equal(r.source, 'rule', `expected rule source for: "${text}"`);
  }
});
