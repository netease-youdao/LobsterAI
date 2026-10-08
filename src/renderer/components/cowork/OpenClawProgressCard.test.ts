import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { type OpenClawProgressCard, ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { type CoworkSessionStatus, CoworkSessionStatusValue } from '../../types/cowork';
import { OpenClawProgressCardView } from './OpenClawProgressCard';
import {
  getProgressCardOutcome,
  getProgressCardSummary,
  ProgressCardOutcome,
  toProgressNoteText,
} from './progressCardDisplay';
import ProgressCardMarkdown from './ProgressCardMarkdown';

const card: OpenClawProgressCard = {
  sessionKey: 'agent:main:lobsterai:118d4ab5',
  revision: 2,
  updatedAt: Date.now(),
  markdown: '**Anthropic 公司介绍 PPT**\n\n进行中：设计封面配图',
  steps: [
    { step: '调研 Anthropic 关键事实', status: ProgressCardStepStatus.Completed },
    { step: '确定设计语言与内容大纲', status: ProgressCardStepStatus.InProgress },
    { step: '生成封面配图', status: ProgressCardStepStatus.Pending },
  ],
};
const allDone: OpenClawProgressCard = {
  ...card,
  steps: card.steps!.map((step) => ({ ...step, status: ProgressCardStepStatus.Completed })),
};

const render = (
  value: OpenClawProgressCard,
  status: CoworkSessionStatus,
  onDismiss?: () => void,
  isExpanded = false,
): string => renderToStaticMarkup(React.createElement(OpenClawProgressCardView, {
  card: value,
  sessionStatus: status,
  isExpanded,
  onExpandedChange: () => undefined,
  onDismiss,
}));

test('the summary follows the step being worked on', () => {
  expect(getProgressCardSummary(card)).toMatchObject({
    total: 3,
    doneCount: 1,
    position: 2,
    currentStep: '确定设计语言与内容大纲',
    isComplete: false,
    note: 'Anthropic 公司介绍 PPT 进行中：设计封面配图',
  });
  expect(getProgressCardSummary(allDone)).toMatchObject({ isComplete: true, position: 3 });
  expect(toProgressNoteText('<progress value="3" max="7"></progress> [预览](https://example.com) `x`')).toBe('预览 x');
});

test('an unfinished card reads as its session run: running, turn ended, stopped, or failed', () => {
  const summary = getProgressCardSummary(card);
  expect(getProgressCardOutcome(summary, CoworkSessionStatusValue.Running)).toBe(ProgressCardOutcome.Running);
  expect(getProgressCardOutcome(summary, CoworkSessionStatusValue.Completed)).toBe(ProgressCardOutcome.TurnEnded);
  expect(getProgressCardOutcome(summary, CoworkSessionStatusValue.Idle)).toBe(ProgressCardOutcome.Stopped);
  expect(getProgressCardOutcome(summary, CoworkSessionStatusValue.Error)).toBe(ProgressCardOutcome.Failed);
  expect(getProgressCardOutcome(getProgressCardSummary(allDone), CoworkSessionStatusValue.Running))
    .toBe(ProgressCardOutcome.Complete);
});

test('while the agent works on it the card stays one line, with no close button', () => {
  const html = render(card, CoworkSessionStatusValue.Running, () => undefined);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('确定设计语言与内容大纲');
  expect(html).toContain('第 2/3 步');
  expect(html).not.toContain('data-progress-card-body');
  expect(html).not.toContain('关闭任务进度');
});

test('opened, the card shows the note, the whole checklist, and when it was updated', () => {
  const html = render(card, CoworkSessionStatusValue.Running, () => undefined, true);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('刚刚更新');
  expect(html).toContain('data-progress-card-body');
  expect(html).toContain('Anthropic 公司介绍 PPT');
  expect(html).toContain('生成封面配图');
});

test('the header pie fills with the share of steps done, and done steps are struck through', () => {
  const html = render(card, CoworkSessionStatusValue.Running, undefined, true);
  const [, filled, whole] = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(html) ?? [];
  expect(Number(filled) / Number(whole)).toBeCloseTo(1 / 3);
  const stepItems = Object.fromEntries(
    [...html.matchAll(/<li[^>]*data-status="(\w+)"[^>]*>[\s\S]*?<\/li>/g)].map(([item, status]) => [status, item]),
  );
  expect(stepItems[ProgressCardStepStatus.Completed]).toContain('line-through');
  expect(stepItems[ProgressCardStepStatus.InProgress]).not.toContain('line-through');
  expect(stepItems[ProgressCardStepStatus.Pending]).not.toContain('line-through');
});

test('once the run ends the card folds to one line that says so and can be closed', () => {
  const html = render(card, CoworkSessionStatusValue.Completed, () => undefined);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('确定设计语言与内容大纲');
  expect(html).toContain('第 2/3 步 · 本轮已结束');
  expect(html).not.toContain('data-progress-card-body');
  expect(html).toContain('关闭任务进度');
  expect(render(card, CoworkSessionStatusValue.Idle, () => undefined)).toContain('已停止');
});

test('a finished checklist folds to "all done" and can be closed even during a new run', () => {
  const html = render(allDone, CoworkSessionStatusValue.Running, () => undefined);
  expect(html).toContain('已完成全部 3 步');
  expect(html).not.toContain('第 3/3 步');
  expect(html).toContain('关闭任务进度');
});

test('a note-only card shows its note as the line', () => {
  const noteOnly: OpenClawProgressCard = { ...card, steps: undefined, markdown: '已打开原文，正在制作译稿。' };
  const html = render(noteOnly, CoworkSessionStatusValue.Completed, () => undefined);
  expect(html).toContain('已打开原文，正在制作译稿。');
  expect(html).not.toContain('第 ');
});

test('card markdown renders validated progress bars but no raw HTML, images, or script links', () => {
  const html = renderToStaticMarkup(React.createElement(ProgressCardMarkdown, {
    content: [
      '**Goal**',
      '<progress value="2" max="4" aria-label="Checked" onclick="alert(1)"></progress>',
      '<script>alert(1)</script>',
      '<img src="https://bad.test/x" onerror="alert(1)">',
      '![Secret](https://bad.test/y)',
      '[bad](javascript:alert(1)) [good](https://example.com)',
    ].join('\n\n'),
  }));
  expect(html).toContain('<strong>Goal</strong>');
  expect(html).toMatch(/<progress[^>]*value="2"[^>]*max="4"/);
  expect(html).not.toContain('onclick');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('javascript:');
  expect(html).toContain('href="https://example.com"');
});

test('card markdown keeps the single line breaks agents write, as OpenClaw renders them', () => {
  const html = renderToStaticMarkup(React.createElement(ProgressCardMarkdown, {
    content: '已完成：资料调研\n进行中：设计封面配图\n\n```\nkeep\nthis\n```',
  }));
  expect(html).toMatch(/已完成：资料调研<br\/>\s*进行中：设计封面配图/);
  expect(html).toContain('keep\nthis');
});
