export const FOLLOW_UP_SUGGESTION_CHANNEL = 'cowork:suggestFollowUp';

export interface FollowUpSuggestionRequest {
  question: string;
  answer: string;
  language: string;
}

/** Reject verbose, malformed, or multiline output instead of filling it into a draft. */
export function parseFollowUpSuggestion(content: unknown): string | null {
  if (typeof content !== 'string' || content.length > 2000) return null;
  try {
    const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (typeof parsed?.suggestion !== 'string') return null;
    const text = parsed.suggestion.trim();
    return text.length >= 2 && Array.from(text).length <= 180 && !/[\r\n\u0000-\u001f]/.test(text)
      ? text : null;
  } catch { return null; }
}
