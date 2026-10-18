import { parseFollowUpSuggestion } from '../../shared/followUpSuggestion';
import type { FollowUpContext } from '../components/cowork/followUpSuggestion';

/** Model credentials and completion requests stay in the main process. */
export async function requestFollowUpSuggestion(context: FollowUpContext, language: string, isCurrentAccount = () => true): Promise<string | null> {
  try {
    if (!isCurrentAccount()) return null;
    const text = await window.electron.cowork.suggestFollowUp({ question: context.question, answer: context.answer, language });
    return isCurrentAccount() ? parseFollowUpSuggestion(JSON.stringify({ suggestion: text })) : null;
  } catch { return null; }
}
