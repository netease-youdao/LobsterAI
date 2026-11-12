import { CoworkTurnOutcome } from '../../shared/cowork/turnOutcome';
import type { CoworkStore } from '../coworkStore';
import type { CoworkEngineRouter } from '../libs/agentEngine/coworkEngineRouter';

/** Preserve terminal outcomes when a later turn replaces the session's current status. */
export function bindCoworkTurnOutcomes(runtime: CoworkEngineRouter, store: CoworkStore): void {
  const record = (sessionId: string, outcome?: CoworkTurnOutcome) => {
    try {
      const userMessage = store.getLatestUserMessage(sessionId);
      const session = store.getSession(sessionId, 1);
      const lastMessage = session?.messages.at(-1);
      // Some runtime paths emit complete after a timeout or safety abort, with the session still idle.
      const terminalOutcome = outcome ?? (session?.status === CoworkTurnOutcome.Completed
        ? CoworkTurnOutcome.Completed : CoworkTurnOutcome.Stopped);
      const messages = [userMessage, lastMessage?.type === 'assistant' ? lastMessage : null];
      for (const message of messages) {
        if (!message || (userMessage && message.timestamp < userMessage.timestamp)) continue;
        const outcomeMetadata = { turnOutcome: terminalOutcome, isStreaming: false, isFinal: true };
        store.updateMessage(sessionId, message.id, { metadata: { ...message.metadata, ...outcomeMetadata } });
        runtime.emit('messageUpdate', sessionId, message.id, message.content, outcomeMetadata);
      }
    } catch (error) {
      console.error('[Cowork] Failed to preserve turn outcome:', error);
    }
  };

  runtime.on('complete', (sessionId: string) => record(sessionId));
  runtime.on('sessionStopped', (sessionId: string) => record(sessionId, CoworkTurnOutcome.Stopped));
  runtime.on('error', (sessionId: string) => record(sessionId, CoworkTurnOutcome.Failed));
}
