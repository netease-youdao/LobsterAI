import type { CoworkSession } from '../../types/cowork';

export interface FollowUpContext {
  key: string;
  question: string;
  answer: string;
}

const plainContext = (text: string) => text
  .replace(/<(think|thinking|analysis)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '')
  .replace(/```[\s\S]*?(?:```|$)/g, '')
  .replace(/data:[^\s)]+/g, '')
  .trim();

/** Only a finished answer to the latest user turn is useful; tool traces are never sent. */
export function getFollowUpContext(session: CoworkSession | null | undefined): FollowUpContext | null {
  if (!session || !['completed', 'idle'].includes(session.status)) return null;
  const messages = session.messages;
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].type === 'user') { userIndex = index; break; }
  }
  if (userIndex < 0) return null;
  const reply = messages.slice(userIndex + 1).reverse().find(message => message.type === 'assistant');
  if (!reply || reply.metadata?.isThinking || reply.metadata?.isError || reply.metadata?.isStreaming
    || reply.metadata?.isGenerating || reply.metadata?.questionReceipt || !reply.content.trim()) return null;
  const question = plainContext(messages[userIndex].content).slice(0, 2000);
  const answer = plainContext(reply.content).slice(-6000);
  if (!question || !answer) return null;
  return { question, answer, key: JSON.stringify([session.id, messages[userIndex].id, reply.id, question, answer]) };
}

export { parseFollowUpSuggestion } from '../../../shared/followUpSuggestion';

export function isFollowUpAcceptKey(event: {
  key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
    && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}

/** Check the live input as well as React state: a pending render must never replace typed text. */
export function handleFollowUpSuggestionKey({ event, suggestion, inputValue, accept, dismiss }: {
  event: Parameters<typeof isFollowUpAcceptKey>[0] & { preventDefault(): void; stopPropagation(): void };
  suggestion: string | null;
  inputValue: string;
  accept(text: string): void;
  dismiss(): void;
}): boolean {
  if (!suggestion || inputValue.length > 0) return false;
  if (isFollowUpAcceptKey(event)) {
    event.preventDefault();
    accept(suggestion);
    dismiss();
    return true;
  }
  if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    return true;
  }
  return false;
}
