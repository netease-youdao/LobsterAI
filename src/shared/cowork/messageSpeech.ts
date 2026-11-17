import type { LanguageToolEvent, LanguageToolResult } from '../desktopCompanion/languageTools';

export const MessageSpeechIpc = {
  Start: 'cowork:speech:start',
  Stop: 'cowork:speech:stop',
  Event: 'cowork:speech:event',
  Reset: 'cowork:speech:reset',
} as const;

export interface MessageSpeechRequest {
  requestId: string;
  sessionId: string;
  messageId: string;
  text: string;
}

export interface MessageSpeechBridge {
  start(request: MessageSpeechRequest): Promise<LanguageToolResult>;
  stop(requestId: string): Promise<void>;
  onEvent(callback: (event: LanguageToolEvent) => void): () => void;
  onReset(callback: (requestId: string) => void): () => void;
}
