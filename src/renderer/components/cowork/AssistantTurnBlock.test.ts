import { configureStore } from '@reduxjs/toolkit';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { expect, test } from 'vitest';

import { buildCoworkTurnUsage, CoworkTurnUsageStatus } from '../../../shared/cowork/llmTurnUsage';
import { ModelPresetId } from '../../../shared/modelPresets/constants';
import { i18nService } from '../../services/i18n';
import { type Artifact, ArtifactMediaOriginType, ArtifactTypeValue } from '../../types/artifact';
import type { CoworkMessage } from '../../types/cowork';
import AssistantTurnBlock from './AssistantTurnBlock';
import ConversationTurnsView from './ConversationTurnsView';
import { buildConversationTurns, buildDisplayItems } from './messageDisplayUtils';

const renderTurn = (
  messages: CoworkMessage[],
  isStreamingTurn: boolean,
  showActivityIndicator = false,
  options: {
    artifacts?: Artifact[];
    enableMessageSpeech?: boolean;
    showCopyButtons?: boolean;
  } = {},
): string => {
  const store = configureStore({
    reducer: {
      auth: () => ({ creditQuotaSnapshot: null, isLoggedIn: true }),
      cowork: () => ({ isStreaming: isStreamingTurn, currentSession: null }),
      enterpriseAccount: () => ({ context: null }),
    },
  });
  const turn = buildConversationTurns(buildDisplayItems(messages))[0];
  return renderToStaticMarkup(React.createElement(Provider, {
    store,
    children: React.createElement(AssistantTurnBlock, {
      turn,
      isStreamingTurn,
      showActivityIndicator,
      artifacts: options.artifacts,
      enableMessageSpeech: options.enableMessageSpeech,
      showCopyButtons: options.showCopyButtons,
      onForkMessage: () => {},
    }),
  }));
};

const toolMessages = (id: string, timestamp: number): CoworkMessage[] => [
  {
    id, type: 'tool_use', content: '', timestamp,
    metadata: { toolName: 'exec', toolInput: { command: 'ls' }, toolUseId: id },
  },
  { id: `${id}-result`, type: 'tool_result', content: 'ok', timestamp: timestamp + 500, metadata: { toolUseId: id } },
];

const process: CoworkMessage[] = [
  { id: 'user-1', type: 'user', content: 'make a deck', timestamp: 1_000 },
  { id: 'think-1', type: 'assistant', content: 'plan', timestamp: 2_000, metadata: { isThinking: true } },
  ...toolMessages('tool-1', 3_000),
  ...toolMessages('tool-2', 5_000),
];

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const usage = buildCoworkTurnUsage({ traceId, requestCount: 3, creditsUsed: 12.5 }, { traceId, now: 60_000 })!;
const userWithUsage: CoworkMessage = { ...process[0], metadata: {
  turnUsage: usage, modelPresetId: ModelPresetId.Balanced, resolvedModelId: 'deepseek-flash',
} };

test.each([
  { name: 'before any assistant output', items: [] },
  { name: 'during thinking', items: [process[1]] },
  { name: 'during a tool call after earlier text', items: [
    { id: 'progress', type: 'assistant' as const, content: 'Working on it.', timestamp: 2_000 },
    ...toolMessages('stopped-tool', 3_000).slice(0, 1),
  ] },
])('shows one complete stopped turn footer $name', ({ items }) => {
  const html = renderTurn([userWithUsage, ...items], false);
  expect(html.match(/12\.5 积分/g)).toHaveLength(1);
  expect(html.match(/class="cowork-message-meta /g)).toHaveLength(1);
  expect(html).toContain('cowork-message-meta-full-date');
  expect(html).toContain('deepseek-flash');
  expect(html).toContain(`aria-label="${i18nService.t('coworkForkFromMessage')}"`);
  const copyButton = html.match(/<button[^>]*aria-label="复制到剪贴板"[^>]*>/)?.[0];
  expect(copyButton).toBeDefined();
  expect(copyButton?.includes('disabled=""')).toBe(!items.some(
    item => item.type === 'assistant' && !item.metadata?.isThinking,
  ));
});

test('keeps a single usage chip with the final reply, including a stopped partial reply', () => {
  const html = renderTurn([
    userWithUsage, ...process.slice(1),
    { id: 'partial-reply', type: 'assistant', content: 'Here is the first part.', timestamp: 55_000 },
  ], false);
  expect(html.match(/12\.5 积分/g)).toHaveLength(1);
  expect(html.match(/class="cowork-message-meta /g)).toHaveLength(1);
  expect(html.match(/aria-label="复制到剪贴板"/g)).toHaveLength(1);
  expect(html).toContain(`aria-label="${i18nService.t('coworkForkFromMessage')}"`);
});

test('a stopped footer retains the actual model when the last assistant segment has no model metadata', () => {
  const html = renderTurn([
    userWithUsage,
    { id: 'progress', type: 'assistant', content: 'Working on it.', timestamp: 2_000,
      metadata: { model: 'deepseek-pro' } },
    { ...process[1], timestamp: 2_500 },
    ...toolMessages('tool', 3_000),
  ], false);
  expect(html).toContain('deepseek-pro');
  expect(html).not.toContain('deepseek-flash');
  expect(html.match(/12\.5 积分/g)).toHaveLength(1);
});

test('a stopped footer does not offer to copy hidden assistant output', () => {
  const html = renderTurn([
    userWithUsage,
    { id: 'silent', type: 'assistant', content: 'NO_REPLY', timestamp: 2_000 },
    ...toolMessages('tool', 3_000),
  ], false);
  const copyButton = html.match(/<button[^>]*aria-label="复制到剪贴板"[^>]*>/)?.[0];
  expect(copyButton).toContain('disabled=""');
  expect(html).not.toContain('NO_REPLY');
});

test('keeps usage hidden while the turn is streaming', () => {
  expect(renderTurn([userWithUsage, ...process.slice(1)], true)).not.toContain('12.5 积分');
});

test.each([
  { status: CoworkTurnUsageStatus.Pending, label: '积分计算中' },
  { status: CoworkTurnUsageStatus.Partial, label: '≥12.5 积分' },
  { status: CoworkTurnUsageStatus.Failed, label: '积分消耗' },
])('renders the $status usage entry without a reply', ({ status, label }) => {
  const html = renderTurn([{ ...userWithUsage, metadata: { turnUsage: { ...usage, status } } }], false);
  expect(html).toContain(label);
});

test('mounts a conversation turn containing only the user message and persisted usage', () => {
  const store = configureStore({ reducer: {
    auth: () => ({ creditQuotaSnapshot: null }),
    enterpriseAccount: () => ({ context: null }),
    kit: () => ({ installedKits: [] }),
    cowork: () => ({ isStreaming: false }),
  } });
  const html = renderToStaticMarkup(React.createElement(Provider, { store,
    children: React.createElement(ConversationTurnsView, {
      messages: [userWithUsage], scrollContainerRef: React.createRef<HTMLDivElement>(),
    }),
  }));
  expect(html).toContain('12.5 积分');
});

test('a finished turn folds its process behind a duration line that keeps its arrow', () => {
  const html = renderTurn([
    ...process,
    { id: 'answer-1', type: 'assistant', content: 'Done.', timestamp: 55_000 },
  ], false);
  expect(html).toMatch(/耗时 54秒<\/span><svg[^>]*aria-hidden="true"/);
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('运行了 2 个命令');
  expect(html).toContain('Done.');
});

test('a running step line carries no timer of its own; the status line owns the only clock', () => {
  const startedAt = Date.now() - 10_000;
  const writing = renderTurn([
    ...process,
    {
      id: 'write-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'write', toolInput: {}, toolUseId: 'write-1', isGenerating: true, liveEditDiff: { added: 151, removed: 0 } },
    },
  ], true);
  expect(writing).toContain('正在写入文件');
  expect(writing).not.toContain('data-diff-stats');
  expect(writing).toContain('查看详情');
  expect(writing).not.toMatch(/ · \d+s/);
  // The write line leads with the app's compose icon (34×34 artboard).
  expect(writing).toMatch(/data-activity-step-kind="edit"[^]*?viewBox="0 0 34 34"/);

  const commanding = renderTurn([
    ...process,
    {
      id: 'exec-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'exec', toolInput: { command: 'npm install' }, toolUseId: 'exec-1' },
    },
  ], true);
  expect(commanding).toContain('data-activity-label="live"');
  expect(commanding).not.toMatch(/ · \d+s/);
});

test('the status line does not repeat the phrase of the step line right above it', () => {
  const startedAt = Date.now() - 20_000;
  const waiting = renderTurn([
    ...process,
    {
      id: 'poll-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'process', toolInput: { action: 'poll', sessionId: 's' }, toolUseId: 'poll-1' },
    },
  ], true, true);
  expect(waiting.match(/正在等待命令输出/g)).toHaveLength(1);
  expect(waiting).toMatch(/role="status"[^>]*>正在处理</);
  // One clock on screen: the turn's, counted from the user's message.
  expect(waiting.match(/tabular-nums/g)).toHaveLength(1);

  // A step line that names its target leaves the status line its own phrase.
  const fetching = renderTurn([
    ...process,
    {
      id: 'fetch-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'web_fetch', toolInput: { url: 'https://github.com/openclaw/openclaw' }, toolUseId: 'fetch-1' },
    },
  ], true, true);
  expect(fetching).toContain('github.com');
  expect(fetching).toMatch(/role="status"[^>]*>[^<]*网页/);
  expect(fetching).not.toMatch(/role="status"[^>]*>正在处理</);
});

test('a running turn lists every step of its current run without a duration line', () => {
  const html = renderTurn(process, true);
  expect(html).not.toContain('耗时');
  expect(html).not.toContain('data-activity-run-summary');
  expect(html.match(/data-activity-step-kind="command"/g)).toHaveLength(2);
  // The thought before them has finished, so it no longer takes a line.
  expect(html).not.toContain('深度思考');
});

test('a running turn that keeps calling tools folds its older steps behind one line', () => {
  const html = renderTurn([
    ...process,
    ...[3, 4, 5, 6, 7, 8].flatMap((n) => toolMessages(`tool-${n}`, n * 2_000 + 3_000)),
  ], true);
  expect(html).toContain('显示更早的 3 步');
  expect(html.match(/data-activity-step-kind="command"/g)).toHaveLength(5);
  expect(html).not.toContain('耗时');
});

test('a running turn spends no step line on progress card updates once they finish', () => {
  const planCall: CoworkMessage[] = [
    {
      id: 'plan-1', type: 'tool_use', content: '', timestamp: 7_000,
      metadata: {
        toolName: 'progress_card',
        toolUseId: 'plan-1',
        toolInput: {
          markdown: 'Deck underway',
          plan: [
            { step: 'Research', status: 'completed' },
            { step: 'Draft slides', status: 'in_progress' },
          ],
        },
      },
    },
    { id: 'plan-1-result', type: 'tool_result', content: 'Progress card updated', timestamp: 7_100, metadata: { toolUseId: 'plan-1' } },
  ];
  const running = renderTurn([...process, ...planCall, ...toolMessages('tool-9', 9_000)], true);
  expect(running).not.toContain('更新了任务进度');
  expect(running).not.toContain('progress_card');
  expect(running.match(/data-activity-step-kind="command"/g)).toHaveLength(3);
});

test('a turn stopped during a tool step still shows its credits after usage settles', () => {
  const turnUsage = {
    traceId: '0123456789abcdef0123456789abcdef',
    status: CoworkTurnUsageStatus.Settled,
    requestCount: 2,
    failedRequestCount: 1,
    models: ['deepseek-flash'],
    creditsUsed: 37,
    displayCreditsUsed: 37,
    uncachedInputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 1_000,
    outputTokens: 200,
    totalTokens: 1_200,
    updatedAt: 9_000,
  };
  const html = renderTurn([
    { ...process[0], metadata: { turnUsage, model: 'deepseek-flash' } },
    ...process.slice(1),
  ], false);
  expect(html).toContain('cowork-message-meta');
  expect(html).toContain('37');
  // The trailing row uses the same time, model, usage, and action layout as a reply.
  expect(html).toContain('cowork-message-meta-full-date');
  expect(html).toMatch(/title="deepseek-flash"|DeepSeek/i);
  expect(html).toContain('aria-label="复制到剪贴板"');
  expect(html).toContain(`aria-label="${i18nService.t('coworkForkFromMessage')}"`);

  const live = renderTurn([
    { ...process[0], metadata: { turnUsage } },
    ...process.slice(1),
  ], true);
  expect(live).not.toContain('cowork-message-meta');
});

test('places result file cards above the reply time, model, credits, and actions row', () => {
  const artifact: Artifact = {
    id: 'artifact-md-1',
    messageId: 'reply-1',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Markdown,
    title: 'report.md',
    fileName: 'report.md',
    filePath: '/tmp/report.md',
    content: '# Report',
    createdAt: 55_000,
  };
  const html = renderTurn([
    userWithUsage,
    ...process.slice(1),
    {
      id: 'reply-1',
      type: 'assistant',
      content: 'Report is ready.',
      timestamp: 55_000,
      metadata: { model: 'deepseek-flash', modelPresetId: ModelPresetId.Balanced },
    },
  ], false, false, { artifacts: [artifact], enableMessageSpeech: true });

  expect(html.match(/class="cowork-message-meta /g)).toHaveLength(1);
  expect(html.match(/12\.5 积分/g)).toHaveLength(1);
  expect(html).toContain('report.md');
  expect(html).toContain(`aria-label="${i18nService.t('coworkForkFromMessage')}"`);
  expect(html).toContain(`aria-label="${i18nService.t('copyToClipboard')}"`);
  expect(html).toContain(`aria-label="${i18nService.t('coworkReadAloud')}"`);

  const replyIndex = html.indexOf('Report is ready.');
  const cardIndex = html.indexOf('artifact-preview-card-group');
  const metaIndex = html.indexOf('class="cowork-message-meta ');
  expect(replyIndex).toBeGreaterThan(-1);
  expect(cardIndex).toBeGreaterThan(replyIndex);
  expect(metaIndex).toBeGreaterThan(cardIndex);
});

test('places result file cards above the reply meta row even without credit usage', () => {
  const artifact: Artifact = {
    id: 'artifact-doc-1',
    messageId: 'reply-no-usage',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Document,
    title: 'summary.docx',
    fileName: 'summary.docx',
    filePath: '/tmp/summary.docx',
    content: '',
    createdAt: 55_000,
  };
  const html = renderTurn([
    ...process,
    {
      id: 'reply-no-usage',
      type: 'assistant',
      content: 'Document created.',
      timestamp: 55_000,
      metadata: { model: 'claude-sonnet-4' },
    },
  ], false, false, { artifacts: [artifact] });

  expect(html.match(/class="cowork-message-meta /g)).toHaveLength(1);
  expect(html).toContain('claude-sonnet-4');
  expect(html.indexOf('artifact-preview-card-group')).toBeLessThan(html.indexOf('class="cowork-message-meta '));
});

test('places inline image artifacts above the reply meta row', () => {
  const imageArtifact: Artifact = {
    id: 'artifact-img-1',
    messageId: 'reply-img',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Image,
    title: 'poster.png',
    fileName: 'poster.png',
    filePath: '/tmp/poster.png',
    content: 'data:image/png;base64,iVBORw0KGgo=',
    createdAt: 55_000,
  };
  const html = renderTurn([
    userWithUsage,
    {
      id: 'reply-img',
      type: 'assistant',
      content: 'Here is your poster.',
      timestamp: 55_000,
    },
  ], false, false, { artifacts: [imageArtifact] });

  expect(html.match(/class="cowork-message-meta /g)).toHaveLength(1);
  expect(html.indexOf('alt="poster.png"')).toBeGreaterThan(html.indexOf('Here is your poster.'));
  expect(html.indexOf('alt="poster.png"')).toBeLessThan(html.indexOf('class="cowork-message-meta '));
});

test('keeps the reply meta row hidden while streaming even when artifacts are present', () => {
  const artifact: Artifact = {
    id: 'artifact-live-1',
    messageId: 'reply-live',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Markdown,
    title: 'draft.md',
    fileName: 'draft.md',
    filePath: '/tmp/draft.md',
    content: '# Draft',
    createdAt: 55_000,
  };
  const html = renderTurn([
    userWithUsage,
    { id: 'reply-live', type: 'assistant', content: 'Writing draft...', timestamp: 55_000 },
  ], true, true, { artifacts: [artifact], showCopyButtons: false });

  expect(html).toContain('draft.md');
  expect(html).not.toContain('cowork-message-meta');
});

test('renders videos inline without duplicating path rows or generic video file cards', () => {
  const videoArtifact: Artifact = {
    id: 'artifact-vid-1',
    messageId: 'reply-vid',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Video,
    title: 'demo.mp4',
    fileName: 'demo.mp4',
    filePath: '/tmp/demo.mp4',
    content: '',
    createdAt: 55_000,
  };
  const html = renderTurn([
    userWithUsage,
    {
      id: 'reply-vid',
      type: 'assistant',
      content: 'Video is ready.',
      timestamp: 55_000,
    },
  ], false, false, { artifacts: [videoArtifact] });

  expect(html).toContain('data-inline-video-id="artifact-vid-1"');
  expect(html).toContain('demo.mp4');
  expect(html).not.toContain('artifact-preview-card-row');
  expect(html.indexOf('data-inline-video-id="artifact-vid-1"')).toBeGreaterThan(html.indexOf('Video is ready.'));
  expect(html.indexOf('data-inline-video-id="artifact-vid-1"')).toBeLessThan(html.indexOf('class="cowork-message-meta '));
});

test('promotes reply-referenced final video and collapses intermediate clips while keeping non-video files in file cards', () => {
  const clip1: Artifact = {
    id: 'clip-1',
    messageId: 'tool-1-result',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Video,
    title: 'generated-video-1.mp4',
    fileName: 'generated-video-1.mp4',
    filePath: '/tmp/generated-video-1.mp4',
    content: '',
    createdAt: 10_000,
  };
  const clip2: Artifact = {
    id: 'clip-2',
    messageId: 'tool-2-result',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Video,
    title: 'generated-video-2.mp4',
    fileName: 'generated-video-2.mp4',
    filePath: '/tmp/generated-video-2.mp4',
    content: '',
    createdAt: 20_000,
  };
  const finalVideo: Artifact = {
    id: 'final-video',
    messageId: 'reply-final',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Video,
    title: 'arrow-chase-30s-final.mp4',
    fileName: 'arrow-chase-30s-final.mp4',
    filePath: '/tmp/arrow-chase-30s-final.mp4',
    content: '',
    createdAt: 30_000,
  };
  const scriptDoc: Artifact = {
    id: 'script-doc',
    messageId: 'reply-final',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Markdown,
    title: 'storyboard.md',
    fileName: 'storyboard.md',
    filePath: '/tmp/storyboard.md',
    content: '# Storyboard',
    createdAt: 31_000,
  };

  const html = renderTurn([
    userWithUsage,
    ...process.slice(1),
    {
      id: 'reply-final',
      type: 'assistant',
      content: 'Final cut and storyboard are ready.',
      timestamp: 55_000,
    },
  ], false, false, { artifacts: [clip1, clip2, finalVideo, scriptDoc] });

  expect(html).toContain('data-inline-video-id="final-video"');
  expect(html).toContain('arrow-chase-30s-final.mp4');
  expect(html).toContain(i18nService.t('artifactVideoFinalBadge'));
  expect(html).toContain(
    i18nService.t('artifactVideoProcessAssets').replace(
      '{summary}',
      i18nService.t('artifactVideoProcessClipMany').replace('{count}', '2'),
    ),
  );
  // Intermediate clips are folded behind the disclosure toggle by default.
  expect(html).not.toContain('data-inline-video-id="clip-1"');
  expect(html).not.toContain('data-inline-video-id="clip-2"');
  // Non-video files stay in the file card group below.
  expect(html).toContain('storyboard.md');
  expect(html).toContain('artifact-preview-card-row');
  expect(html.indexOf('data-inline-video-id="final-video"')).toBeLessThan(html.indexOf('storyboard.md'));
});

test('folds first-frame reference image under process assets instead of showing a large standalone image below the video', () => {
  const keyframeImage: Artifact = {
    id: 'keyframe-1',
    messageId: 'img-tool-result',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Image,
    title: 'first-frame.png',
    fileName: 'first-frame.png',
    filePath: '/tmp/first-frame.png',
    content: '',
    source: 'tool',
    createdAt: 10_000,
  };
  const finalVideo: Artifact = {
    id: 'generated-video-1',
    messageId: 'vid-tool-result',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Video,
    title: 'generated-video-20261124-223129-1.mp4',
    fileName: 'generated-video-20261124-223129-1.mp4',
    filePath: '/tmp/generated-video-20261124-223129-1.mp4',
    content: '',
    source: 'tool',
    mediaOrigin: {
      type: ArtifactMediaOriginType.GeneratedVideo,
      taskId: '99',
      outputIndex: 0,
    },
    createdAt: 20_000,
  };

  const html = renderTurn([
    userWithUsage,
    {
      id: 'img-tool', type: 'tool_use', content: '', timestamp: 2_000,
      metadata: { toolName: 'lobsterai_image_generate', toolInput: { prompt: 'first frame' }, toolUseId: 'img-tool' },
    },
    { id: 'img-tool-result', type: 'tool_result', content: 'saved', timestamp: 3_000, metadata: { toolUseId: 'img-tool' } },
    {
      id: 'vid-tool', type: 'tool_use', content: '', timestamp: 4_000,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolInput: { prompt: 'cycling boy', firstFrame: '/tmp/first-frame.png' },
        toolUseId: 'vid-tool',
      },
    },
    { id: 'vid-tool-result', type: 'tool_result', content: 'saved', timestamp: 5_000, metadata: { toolUseId: 'vid-tool' } },
    { id: 'reply-1', type: 'assistant', content: 'Video generated.', timestamp: 6_000 },
  ], false, false, { artifacts: [keyframeImage, finalVideo] });

  expect(html).toContain('data-inline-video-id="generated-video-1"');
  expect(html).toContain(i18nService.t('artifactVideoFinalBadge'));
  expect(html).toContain(
    i18nService.t('artifactVideoProcessAssets').replace(
      '{summary}',
      i18nService.t('artifactVideoProcessImageOne'),
    ),
  );
  // Keyframe image is folded away and not rendered as a full-size inline image below the video.
  expect(html).not.toContain('alt="first-frame.png"');
});
