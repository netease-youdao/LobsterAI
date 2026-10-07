import { CoworkSessionStatusValue } from '../../types/cowork';
import type { CompanionSession } from './useCompanionSession';

export const CompanionPhase = {
  Ready: 'ready',
  Running: 'running',
  Completed: 'completed',
  Paused: 'paused',
  Error: 'error',
  Waiting: 'waiting',
} as const;

export function companionPhase(session: Pick<CompanionSession, 'status'> | null, waiting: boolean) {
  if (waiting) return { value: CompanionPhase.Waiting, key: 'desktopCompanionWaiting' };
  switch (session?.status) {
    case CoworkSessionStatusValue.Running: return { value: CompanionPhase.Running, key: 'desktopCompanionRunning' };
    case CoworkSessionStatusValue.Completed: return { value: CompanionPhase.Completed, key: 'desktopCompanionDone' };
    case CoworkSessionStatusValue.Error: return { value: CompanionPhase.Error, key: 'desktopCompanionFailed' };
    case CoworkSessionStatusValue.Idle: return { value: CompanionPhase.Paused, key: 'desktopCompanionIdle' };
    default: return { value: CompanionPhase.Ready, key: 'desktopCompanionOrbIdle' };
  }
}

const MessageKind = { Assistant: 'assistant', User: 'user' } as const;

export function companionReply(session: CompanionSession | null): string {
  const messages = session?.messages ?? [];
  // Do not present a previous turn's answer as the result of a new request.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === MessageKind.User) break;
    if (message.type === MessageKind.Assistant && !message.metadata?.isThinking && message.content.trim()) {
      return message.content.slice(0, 2400);
    }
  }
  return '';
}
