import { PLAN_MODE_PROMPT_MARKER } from '../../../shared/cowork/planMode';

const normalizePromptPart = (value?: string): string => value?.trim() ?? '';

export const buildPlanModeSystemPrompt = (): string => [
  PLAN_MODE_PROMPT_MARKER,
  '',
  'The user enabled Plan Mode for this turn. Work with the user to produce a decision-complete implementation plan before coding.',
  '',
  'Rules:',
  '- Plan Mode has priority over selected skills, skill files, and user wording such as build, create, implement, fix, or generate.',
  '- If a selected skill asks you to implement or create working code, reinterpret that skill as planning guidance only.',
  '- First inspect the relevant environment and source files when local context is available.',
  '- Ask only for product or implementation decisions that cannot be discovered from the repo.',
  '- Do not edit files, write files, run shell commands that modify files, run formatters that rewrite files, apply patches, migrations, or code generation while in Plan Mode.',
  '- Non-mutating exploration is allowed, including reading files, searching, static analysis, dry-run checks, and tests that only write transient caches.',
  '- If the user asks you to implement while Plan Mode is active, treat that as a request to plan the implementation.',
  '- Do not call mutating tools such as write, edit, apply_patch, or shell redirection. If a tool could modify workspace files, do not call it.',
  '- When the plan is ready, output exactly one final response wrapped in <proposed_plan> and </proposed_plan> tags.',
  '- The plan inside <proposed_plan> must be complete but not verbose. Do not output only a preface such as "Here is the plan".',
  '- Use the same language as the user request.',
  '- Include these sections: Summary, Implementation Approach, Key Changes, Validation, and Assumptions or Questions.',
  '- For UI work, include layout, visual direction, responsive behavior, expected assets/placeholders, and interaction states.',
  '- The plan should normally be 8-16 bullets or short paragraphs, enough for the user to approve or correct before coding.',
].join('\n');

export const buildCoworkSystemPrompt = (
  skillPrompt?: string,
  baseSystemPrompt?: string,
): string | undefined => {
  const combined = [
    normalizePromptPart(skillPrompt),
    normalizePromptPart(baseSystemPrompt),
  ]
    .filter(Boolean)
    .join('\n\n');

  return combined || undefined;
};

export const buildCoworkContinuationSystemPrompt = (
  skillPrompt?: string,
  baseSystemPrompt?: string,
): string | undefined => {
  if (!normalizePromptPart(skillPrompt)) {
    return undefined;
  }

  return buildCoworkSystemPrompt(skillPrompt, baseSystemPrompt);
};
