import { expect, test } from 'vitest';

import { pptCatalogFixture } from '../../../tests/fixtures/pptCreation';
import { containsPlanModePrompt } from '../../shared/cowork/planMode';
import { PptCreation, PptWorkflow } from '../../shared/pptCreation/constants';
import { buildPptOutlineSystemPrompt, shouldUsePptOutlinePrompt } from '../../shared/pptCreation/outline';
import { buildPptCreationPrompt, buildPptDirectPrompt } from './pptCreationPrompt';

test('custom work does not inherit fictional example content and includes the selected template', () => {
  const prompt = buildPptCreationPrompt(pptCatalogFixture().examples[0], { language: 'zh', useDemo: false,
    topic: '本季度留存分析', audience: '产品团队', slideCount: 8, workflow: PptWorkflow.Outline, templateName: 'business.pptx' });
  expect(prompt).not.toContain('使用演示数据制作');
  expect(prompt).toContain('本季度留存分析'); expect(prompt).toContain('business.pptx');
  expect(prompt).toContain('<proposed_plan>'); expect(prompt).toContain('等待我确认');
});
test('strict editing preserves scope without requesting another outline', () => {
  const prompt = buildPptCreationPrompt(pptCatalogFixture().examples[0], { language: 'en', useDemo: true,
    topic: 'Only revise slide 3', audience: '', slideCount: 10, workflow: PptWorkflow.Strict });
  expect(prompt).toContain('Only revise slide 3'); expect(prompt).toContain('modifying only requested');
  expect(prompt).not.toContain('<proposed_plan>');
});

test('switching an outline example to direct creation retains edits and overrides its approval step', () => {
  const edited = 'Create 12 slides about our new topic. First present an outline for approval.';
  const prompt = buildPptDirectPrompt(edited, 'en', 'business.pptx');
  expect(prompt.startsWith(edited)).toBe(true);
  expect(prompt).toContain('business.pptx');
  expect(prompt).toContain('placeholders, not facts');
  expect(prompt.endsWith('Do not wait for separate outline approval.')).toBe(true);
});
test('presentation planning retains the runtime gate without asking for a software implementation plan', () => {
  const prompt = buildPptOutlineSystemPrompt();
  expect(containsPlanModePrompt(prompt)).toBe(true);
  expect(prompt).toContain('This turn is read-only');
  expect(prompt).toContain('numbered slide-by-slide outline');
  expect(prompt).toContain('An outline adjustment is not approval');
  expect(prompt).not.toContain('Include these sections: Summary, Implementation Approach');
});

test('PPT expert outline adjustments remain presentations after transient skill selection is cleared', () => {
  expect(shouldUsePptOutlinePrompt([], [PptCreation.ActionId], 'Base agent instructions')).toBe(true);
  expect(shouldUsePptOutlinePrompt([PptCreation.ActionId], [], '')).toBe(true);
  expect(shouldUsePptOutlinePrompt([], [], buildPptOutlineSystemPrompt())).toBe(true);
  expect(shouldUsePptOutlinePrompt([], [], 'Base agent instructions')).toBe(false);
});
