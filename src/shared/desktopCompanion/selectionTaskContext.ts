import type { CompanionQuickAnswerTurn } from './constants';
import { COMPANION_SELECTION_MAX_CHARS, type CompanionSelectionAction, isCompanionSelectionAction } from './selectionActions';

/** Reference material travels separately from the user's editable task request. */
export interface CompanionSelectionTaskContext {
  id: string;
  action: CompanionSelectionAction;
  sourceText: string;
  turns: CompanionQuickAnswerTurn[];
}

export function normalizeSelectionTaskContext(value: unknown): CompanionSelectionTaskContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const context = value as Partial<CompanionSelectionTaskContext>;
  if (typeof context.id !== 'string' || !context.id || !isCompanionSelectionAction(context.action)
    || typeof context.sourceText !== 'string' || !context.sourceText.trim() || !Array.isArray(context.turns)) return undefined;
  return {
    id: context.id.slice(0, 100),
    action: context.action,
    sourceText: context.sourceText.slice(0, COMPANION_SELECTION_MAX_CHARS),
    turns: context.turns.filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant')
      && typeof turn.content === 'string' && turn.content.trim()).slice(-64)
      .map(turn => ({ role: turn.role, content: turn.content.slice(0, 32_000) })),
  };
}

/** Human-readable task history, with reference material explicitly quoted. */
export function buildSelectionTaskPrompt(
  request: string,
  context: CompanionSelectionTaskContext | undefined,
  t: (key: string) => string,
): string {
  if (!context) return request;
  const quote = (text: string) => text.split(/\r?\n/).map(line => `> ${line}`).join('\n');
  return [
    request,
    t('desktopCompanionTaskContextIntro'),
    `### ${t('desktopToolsInput')}`,
    quote(context.sourceText),
    ...context.turns.flatMap(turn => [
      `### ${t(turn.role === 'user' ? 'desktopCompanionTaskContextQuestion' : 'desktopToolsReply')}`,
      quote(turn.content),
    ]),
  ].join('\n\n');
}
