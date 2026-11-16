import { PLAN_MODE_PROMPT_MARKER } from '../cowork/planMode';
import { PptCreation } from './constants';

export const PPT_OUTLINE_PROMPT_MARKER = '# Presentation Outline';
export const PPT_OUTLINE_CONTENT_GUIDANCE = 'Include presentation objective, a numbered slide-by-slide outline with content and evidence, template/material mapping, and any explicit assumptions.';

export function isPptOutlineSystemPrompt(prompt: string): boolean {
  return prompt.split(/\r?\n/).includes(PPT_OUTLINE_PROMPT_MARKER);
}

export function shouldUsePptOutlinePrompt(selectedSkillIds: readonly string[], agentSkillIds: readonly string[], sessionPrompt = ''): boolean {
  return selectedSkillIds.includes(PptCreation.ActionId)
    || agentSkillIds.includes(PptCreation.ActionId)
    || isPptOutlineSystemPrompt(sessionPrompt);
}

/** Retains the existing planning flow while requesting presentation-specific output. */
export function buildPptOutlineSystemPrompt(): string {
  return [
    PLAN_MODE_PROMPT_MARKER,
    PPT_OUTLINE_PROMPT_MARKER,
    'Prepare a presentation outline, not a software implementation plan.',
    'This turn is read-only. Inspect supplied materials using available read-only tools. Do not create, modify, render or export files or call mutating tools.',
    'Read attached text, Markdown and CSV files directly with the read tool. Use read-only document inspection tools for Office files. Do not run setup, dependency checks, conversion scripts or shell interpreters while preparing the outline.',
    'For source research, use web_fetch for known URLs or read-only browser navigation. Record the source URL, edition, date and scope for every figure; do not use shell-based search or download scripts in this turn.',
    'Use the supplied topic, audience, slide count and template. Ask once only for essential missing facts; never invent business figures or career history.',
    'If an attachment cannot be read, identify the missing evidence and leave its specific values unspecified; do not substitute plausible sample sizes, dates, results or other invented placeholders.',
    `Your final answer must be one <proposed_plan> block in the user language. ${PPT_OUTLINE_CONTENT_GUIDANCE}`,
    'Wait for the user to approve the outline through the confirmation control before creating the editable PPTX. An outline adjustment is not approval to generate.',
  ].join('\n');
}
