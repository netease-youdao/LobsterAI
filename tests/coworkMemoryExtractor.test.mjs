import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isQuestionLikeMemoryText } = require('../dist-electron/main/libs/coworkMemoryExtractor.js');

// ==================== isQuestionLikeMemoryText ====================

test('detects question mark at end', () => {
  assert.equal(isQuestionLikeMemoryText('今天天气怎么样？'), true);
  assert.equal(isQuestionLikeMemoryText('What is your name?'), true);
  assert.equal(isQuestionLikeMemoryText('你好吗？'), true);
});

test('detects Chinese question prefix', () => {
  // These match the CHINESE_QUESTION_PREFIX_RE pattern
  assert.equal(isQuestionLikeMemoryText('请问今天的天气'), true);
  assert.equal(isQuestionLikeMemoryText('是否可以'), true);
  assert.equal(isQuestionLikeMemoryText('如何解决'), true);
  assert.equal(isQuestionLikeMemoryText('为什么这样'), true);
  assert.equal(isQuestionLikeMemoryText('怎么操作'), true);
});

test('detects English question prefix', () => {
  assert.equal(isQuestionLikeMemoryText('Can you help me?'), true);
  assert.equal(isQuestionLikeMemoryText('Could you explain'), true);
  assert.equal(isQuestionLikeMemoryText('Would you like'), true);
});

test('detects inline question', () => {
  assert.equal(isQuestionLikeMemoryText('what is 2+2? yes or no'), true);
  assert.equal(isQuestionLikeMemoryText('is this working? please check'), true);
});

test('detects question suffix', () => {
  assert.equal(isQuestionLikeMemoryText('please tell me, is this right?'), true);
});

test('returns false for non-question text', () => {
  assert.equal(isQuestionLikeMemoryText('今天天气很好'), false);
  assert.equal(isQuestionLikeMemoryText('我的名字是小明'), false);
  assert.equal(isQuestionLikeMemoryText('I live in Shanghai'), false);
});

test('returns false for empty text', () => {
  assert.equal(isQuestionLikeMemoryText(''), false);
});

test('strips trailing punctuation before checking', () => {
  // '今天天气怎么样?' ends with ? so it should be detected
  assert.equal(isQuestionLikeMemoryText('今天天气怎么样？'), true);
  // Without ? should return false
  assert.equal(isQuestionLikeMemoryText('今天天气怎么样'), false);
});

test('handles text with only whitespace', () => {
  assert.equal(isQuestionLikeMemoryText('   '), false);
});

test('handles short texts', () => {
  assert.equal(isQuestionLikeMemoryText('你好？'), true);
  assert.equal(isQuestionLikeMemoryText('Hi?'), true);
  assert.equal(isQuestionLikeMemoryText('hi'), false);
});
