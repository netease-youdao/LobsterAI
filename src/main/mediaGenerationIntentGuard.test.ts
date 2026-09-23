import { describe, expect, test } from 'vitest';

import {
  collectMediaGenerationIntentContext,
  findPendingMediaGenerationConfirmation,
  findStandingMediaGenerationStopMessage,
  hasExplicitMediaGenerationIntent,
  isContextualMediaFollowUp,
  isMediaGenerationStopIntent,
  isMetaMediaGenerationPrompt,
  MediaGenerationIntentBlockReason,
  type MediaIntentMessageLike,
  messagesAfterLastAnsweredQuestion,
  resolveMediaGenerationIntentGate,
} from './mediaGenerationIntentGuard';

const user = (content: string): MediaIntentMessageLike => ({ type: 'user', content });
const assistant = (content: string): MediaIntentMessageLike => ({ type: 'assistant', content });
const toolUse = (toolName: string, toolUseId: string): MediaIntentMessageLike => ({
  type: 'tool_use',
  content: `Using tool: ${toolName}`,
  metadata: { toolName, toolUseId },
});
const toolResult = (toolUseId: string, content = 'ok'): MediaIntentMessageLike => ({
  type: 'tool_result',
  content,
  metadata: { toolUseId },
});

describe('isMediaGenerationStopIntent', () => {
  test.each([
    '先不要生图',
    '停止做图',
    '暂时别再生成图片了',
    '取消图像生成',
    '停止做视频',
    '先不要制作视频',
    'stop generating images',
    'stop making videos',
    "please don't create another picture",
    "please don't make another video",
  ])('recognizes an explicit stop request: %s', (prompt) => {
    expect(isMediaGenerationStopIntent(prompt)).toBe(true);
  });

  test.each([
    '按照这个再生成一张不同姿势的图片',
    '不要停止生图，继续做',
    '不要生成文案，只生成一张商品图',
    '不要制作方案，生成一张商品图',
    '生成一张海报，不要生成图片边框',
    "don't stop generating images, keep going",
    "don't generate reports, only generate an image",
    "don't stop generating",
    '先整理一下图片提示词',
  ])('does not treat a positive or unrelated request as a stop: %s', (prompt) => {
    expect(isMediaGenerationStopIntent(prompt)).toBe(false);
  });

  test.each([
    '不要停止生图，不过现在先不要再生成图片',
    "don't stop generating images, but stop making videos",
  ])('obeys the last media directive: %s', (prompt) => {
    expect(isMediaGenerationStopIntent(prompt)).toBe(true);
  });

  test.each([
    '先不要生成图片，后来想了下，继续生成图片',
    '停止做图，算了，还是生成一张图片',
    'stop generating images, actually generate an image',
  ])('allows a later explicit generation directive: %s', (prompt) => {
    expect(isMediaGenerationStopIntent(prompt)).toBe(false);
  });
});

describe('isMetaMediaGenerationPrompt', () => {
  test('blocks a refusal that a model passed as the image prompt', () => {
    // Real-world case: this text was rendered into a picture and billed.
    expect(isMetaMediaGenerationPrompt(
      '本回合无需生成任何图片。用户已明确要求：讨论期间不生产图片，请勿调用图像生成。',
    )).toBe(true);
  });

  test.each([
    '无需生成任何图片。',
    '请勿调用图像生成工具',
    '本轮不需要出图',
    '不生产图片，仅讨论方案',
    '停止生成图片',
    'No image is needed for this turn.',
    'Do not generate any images.',
    'Do not call the image generation tool; the user only wants feedback on the copy.',
    'Skip image generation for now',
    'The user has asked not to create media during the discussion.',
  ])('blocks refusal and meta instructions: %s', (prompt) => {
    expect(isMetaMediaGenerationPrompt(prompt)).toBe(true);
  });

  test.each([
    '一只在雪地里奔跑的柴犬，电影感光线，浅景深，高清写实风格',
    '电商产品主图：白色背景，不锈钢保温杯居中放置，柔和棚拍光，画面干净利落，不要出现文字和水印，不要生成品牌 logo，构图简洁，符合天猫主图规范',
    '海报设计，蓝色渐变背景，不要生成图片边框',
    'A clean product shot of a ceramic mug. Do not generate text or watermarks.',
    'A portrait of an astronaut, do not make it cartoonish.',
    '',
  ])('allows real visual prompts, including negative constraints: %s', (prompt) => {
    expect(isMetaMediaGenerationPrompt(prompt)).toBe(false);
  });

  test('handles a missing prompt', () => {
    expect(isMetaMediaGenerationPrompt(undefined)).toBe(false);
  });
});

describe('hasExplicitMediaGenerationIntent', () => {
  test.each([
    '帮我生成一张产品主图',
    '现在作图吧',
    'generate an image of a red car',
  ])('detects an explicit generation request: %s', (prompt) => {
    expect(hasExplicitMediaGenerationIntent(prompt)).toBe(true);
  });

  test.each([
    '这个方案的优缺点是什么？',
    '先不要生成图片',
    '',
  ])('ignores discussion and stop messages: %s', (prompt) => {
    expect(hasExplicitMediaGenerationIntent(prompt)).toBe(false);
  });
});

describe('isContextualMediaFollowUp', () => {
  test.each([
    '把刚才那张的背景换成红色',
    '再来一张',
    'make it brighter',
    'another version with a different pose',
  ])('detects an edit or repeat of earlier media: %s', (prompt) => {
    expect(isContextualMediaFollowUp(prompt)).toBe(true);
  });

  test.each([
    '这张表格帮我汇总一下',
    '介绍一下这个产品的卖点',
  ])('ignores unrelated requests: %s', (prompt) => {
    expect(isContextualMediaFollowUp(prompt)).toBe(false);
  });
});

describe('findStandingMediaGenerationStopMessage', () => {
  test('keeps an earlier pause in effect across discussion turns', () => {
    expect(findStandingMediaGenerationStopMessage({
      latestUserPrompt: '那这个方案的优缺点分别是什么？',
      recentUserPrompts: ['我们先讨论一下', '讨论期间先不要生成图片'],
    })).toBe('讨论期间先不要生成图片');
  });

  test('an explicit generation request lifts the pause', () => {
    expect(findStandingMediaGenerationStopMessage({
      latestUserPrompt: '好，现在生成一张对比图',
      recentUserPrompts: ['讨论期间先不要生成图片'],
    })).toBeNull();
  });

  test('a follow-up on earlier media lifts the pause', () => {
    expect(findStandingMediaGenerationStopMessage({
      latestUserPrompt: '把刚才那张的背景改成红色',
      recentUserPrompts: ['先不要生成图片'],
    })).toBeNull();
  });

  test('a stop in the latest message is reported', () => {
    expect(findStandingMediaGenerationStopMessage({
      latestUserPrompt: '先别生成图片了',
      recentUserPrompts: [],
    })).toBe('先别生成图片了');
  });

  test('a generation request newer than the pause wins', () => {
    expect(findStandingMediaGenerationStopMessage({
      latestUserPrompt: 'which colors work best for the brand?',
      recentUserPrompts: ['generate an image of a red car', 'stop generating images'],
    })).toBeNull();
  });

  test('no directive means no standing stop', () => {
    expect(findStandingMediaGenerationStopMessage({
      latestUserPrompt: '介绍一下这个产品的卖点',
      recentUserPrompts: ['我们聊聊定价策略'],
    })).toBeNull();
  });

  test('a pause older than the lookback window expires', () => {
    expect(findStandingMediaGenerationStopMessage({
      latestUserPrompt: 'next question',
      recentUserPrompts: [...Array.from({ length: 7 }, (_, index) => `question ${index}`), 'stop generating images'],
    })).toBeNull();
  });
});

describe('findPendingMediaGenerationConfirmation', () => {
  test.each([
    '需要我调整提示词重新生成吗？',
    '是否按调整后的参数继续出图？',
    '要不要修改背景后再试一次？',
    'Would you like me to adjust the prompt and regenerate the image?',
  ])('detects a same-turn media confirmation question: %s', (message) => {
    expect(findPendingMediaGenerationConfirmation([message])).toBe(message);
  });

  test.each([
    '我会调整提示词并立即重新生成。',
    '如需调整提示词，请告诉我。',
    '为什么两张图看起来相似？因为亮片的描述没有明显变化。',
    'I adjusted the image prompt and will regenerate it now.',
  ])('ignores narration that does not wait for a decision: %s', (message) => {
    expect(findPendingMediaGenerationConfirmation([message])).toBeNull();
  });

  test('handles an empty turn', () => {
    expect(findPendingMediaGenerationConfirmation([])).toBeNull();
    expect(findPendingMediaGenerationConfirmation(undefined)).toBeNull();
  });
});

describe('messagesAfterLastAnsweredQuestion', () => {
  const ask = assistant('要不要修改背景后再试一次？');
  const later = assistant('好的，开始生成海报。');

  test('an answered AskUserQuestion call resolves the confirmation asked before it', () => {
    const turn = [ask, toolUse('AskUserQuestion', 'q1'), toolResult('q1', '{"answers":{}}'), later];
    expect(messagesAfterLastAnsweredQuestion(turn)).toEqual([later]);
  });

  test('an unanswered question keeps the whole turn', () => {
    const turn = [ask, toolUse('AskUserQuestion', 'q2')];
    expect(messagesAfterLastAnsweredQuestion(turn)).toEqual(turn);
  });

  test('results of other tools do not resolve a question', () => {
    const turn = [ask, toolUse('exec', 't1'), toolResult('t1')];
    expect(messagesAfterLastAnsweredQuestion(turn)).toEqual(turn);
  });
});

describe('collectMediaGenerationIntentContext', () => {
  test('splits the latest user turn from older user messages', () => {
    const context = collectMediaGenerationIntentContext([
      user('first'),
      assistant('reply 1'),
      user('second'),
      assistant('reply 2'),
      user('latest'),
      assistant('Should I generate the image now?'),
    ]);
    expect(context).toEqual({
      latestUserPrompt: 'latest',
      recentUserPrompts: ['second', 'first'],
      currentTurnAssistantMessages: ['Should I generate the image now?'],
    });
  });

  test('drops assistant text the user already answered through a question card', () => {
    const context = collectMediaGenerationIntentContext([
      user('design a poster'),
      assistant('Would you like me to generate the poster now?'),
      toolUse('AskUserQuestion', 'q1'),
      toolResult('q1', '{"answers":{"Generate?":"Yes"}}'),
      assistant('Generating the poster.'),
    ]);
    expect(context.currentTurnAssistantMessages).toEqual(['Generating the poster.']);
  });

  test('returns an empty context without a user message', () => {
    expect(collectMediaGenerationIntentContext([assistant('hello')])).toEqual({
      recentUserPrompts: [],
      currentTurnAssistantMessages: [],
    });
  });
});

describe('resolveMediaGenerationIntentGate', () => {
  const visualPrompt = 'A red sports car on a coastal road at sunset, cinematic lighting';

  test('allows a generate request that follows an explicit user request', () => {
    expect(resolveMediaGenerationIntentGate({
      prompt: visualPrompt,
      conversation: collectMediaGenerationIntentContext([user('generate an image of a red car')]),
    })).toEqual({ allowed: true });
  });

  test('blocks when the latest user message asks to stop', () => {
    const result = resolveMediaGenerationIntentGate({
      prompt: visualPrompt,
      conversation: collectMediaGenerationIntentContext([
        user('generate an image of a red car'),
        assistant('Here it is.'),
        user('stop generating images, let us talk about the copy'),
      ]),
    });
    expect(result).toMatchObject({
      allowed: false,
      reason: MediaGenerationIntentBlockReason.UserStopped,
    });
    expect(result.allowed === false && result.message).toContain('latest user message');
  });

  test('keeps blocking in a later discussion turn after the user paused generation', () => {
    const result = resolveMediaGenerationIntentGate({
      prompt: visualPrompt,
      conversation: collectMediaGenerationIntentContext([
        user('讨论期间先不要生成图片'),
        assistant('好的。'),
        user('这个方案的优缺点分别是什么？'),
      ]),
    });
    expect(result).toMatchObject({
      allowed: false,
      reason: MediaGenerationIntentBlockReason.UserStopped,
    });
    expect(result.allowed === false && result.message).toContain('previously asked to pause');
  });

  test('blocks a refusal passed as the prompt even when the user asked for media earlier', () => {
    expect(resolveMediaGenerationIntentGate({
      prompt: '本回合无需生成任何图片。用户已明确要求：讨论期间不生产图片，请勿调用图像生成。',
      conversation: collectMediaGenerationIntentContext([user('帮我生成一张产品主图')]),
    })).toMatchObject({
      allowed: false,
      reason: MediaGenerationIntentBlockReason.MetaPrompt,
    });
  });

  test('checks the prompt even without conversation context', () => {
    expect(resolveMediaGenerationIntentGate({ prompt: 'No image is needed for this turn.' })).toMatchObject({
      allowed: false,
      reason: MediaGenerationIntentBlockReason.MetaPrompt,
    });
    expect(resolveMediaGenerationIntentGate({ prompt: visualPrompt })).toEqual({ allowed: true });
  });

  test('blocks while the assistant waits for an answer to its own confirmation question', () => {
    expect(resolveMediaGenerationIntentGate({
      prompt: visualPrompt,
      conversation: collectMediaGenerationIntentContext([
        user('I need a poster for the product launch'),
        assistant('Would you like me to generate the poster image now?'),
      ]),
    })).toMatchObject({
      allowed: false,
      reason: MediaGenerationIntentBlockReason.AwaitingUserConfirmation,
    });
  });

  test('allows generation in the same turn after the user answered the question card', () => {
    expect(resolveMediaGenerationIntentGate({
      prompt: visualPrompt,
      conversation: collectMediaGenerationIntentContext([
        user('I need a poster for the product launch'),
        assistant('Would you like me to generate the poster image now?'),
        toolUse('AskUserQuestion', 'q1'),
        toolResult('q1', '{"answers":{"Generate the poster now?":"Yes"}}'),
      ]),
    })).toEqual({ allowed: true });
  });
});
