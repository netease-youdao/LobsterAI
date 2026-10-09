export const LanguageTool = { Translate: 'translate', Tts: 'tts' } as const;
export type LanguageTool = typeof LanguageTool[keyof typeof LanguageTool];
export const TranslationTarget = { Auto: 'auto', Chinese: 'zh-CHS', English: 'en' } as const;
export type TranslationTarget = typeof TranslationTarget[keyof typeof TranslationTarget];
export const LanguageToolEventType = { Delta: 'delta', Audio: 'audio', Done: 'done', Error: 'error' } as const;
export const SpeechStatus = { Idle: 'idle', Loading: 'loading', Playing: 'playing', Paused: 'paused', Ended: 'ended', Error: 'error' } as const;
export type SpeechStatus = typeof SpeechStatus[keyof typeof SpeechStatus];
export const SpeechCommand = { Pause: 'pause', Resume: 'resume', Stop: 'stop' } as const;
export type SpeechCommand = typeof SpeechCommand[keyof typeof SpeechCommand];
export const LanguageToolCode = {
  Unauthorized: 40100, Unavailable: 42500, InvalidInput: 42501, TooLong: 42502,
  DailyLimit: 42503, RateLimit: 42504, Duplicate: 42505, Upstream: 42506,
} as const;
export const LANGUAGE_TRANSLATION_MAX_CHARS = 5_000;
export const LANGUAGE_TTS_MAX_CHARS = 100_000;
export const LanguageToolsIpc = {
  Open: 'desktop-tools:open', Input: 'desktop-tools:input', GetInput: 'desktop-tools:get-input',
  Start: 'desktop-tools:start', Abort: 'desktop-tools:abort', Event: 'desktop-tools:event',
  Quota: 'desktop-tools:quota', Hide: 'desktop-tools:hide', SpeechStatus: 'desktop-tools:speech-status',
  Close: 'desktop-tools:close', Pin: 'desktop-tools:pin',
  SpeechCommand: 'desktop-tools:speech-command', Reset: 'desktop-tools:reset',
} as const;

export interface LanguageToolInput { tool: LanguageTool; text?: string; id?: string }
export interface LanguageToolRequest {
  requestId: string; tool: LanguageTool; text: string; targetLanguage?: TranslationTarget;
}
export interface LanguageToolQuota {
  usageDate: string; usedRequests: number; limitRequests: number; remainingRequests: number;
  usedCharacters: number; limitCharacters: number | null; remainingCharacters: number | null; resetsAt: string;
}
export interface LanguageToolQuotas {
  tools: Record<LanguageTool, LanguageToolQuota>; translationMaxCharacters: number; ttsMaxCharacters: number;
}
export interface LanguageToolResult { success: boolean; code?: number; data?: LanguageToolQuotas }
export type LanguageToolEvent = { requestId: string } & (
  | { type: typeof LanguageToolEventType.Delta; text: string; language: string }
  | { type: typeof LanguageToolEventType.Audio; index: number; total: number; mimeType: string; audioBase64: string }
  | { type: typeof LanguageToolEventType.Done; quota: LanguageToolQuotas }
  | { type: typeof LanguageToolEventType.Error; code: number }
);
export interface LanguageToolsBridge {
  openLanguageTool(input: LanguageToolInput): Promise<void>;
  getLanguageToolInput(): Promise<LanguageToolInput | null>;
  startLanguageTool(request: LanguageToolRequest): Promise<LanguageToolResult>;
  abortLanguageTool(requestId: string): Promise<void>;
  getLanguageToolQuota(): Promise<LanguageToolResult>;
  hideLanguageTool(): Promise<void>;
  closeLanguageTool(): Promise<void>;
  pinLanguageTool(pinned: boolean): Promise<void>;
  setSpeechStatus(status: SpeechStatus): Promise<void>;
  speechCommand(command: SpeechCommand): Promise<void>;
  onLanguageToolInput(callback: (input: LanguageToolInput) => void): () => void;
  onLanguageToolEvent(callback: (event: LanguageToolEvent) => void): () => void;
  onSpeechCommand(callback: (command: SpeechCommand) => void): () => void;
  onLanguageToolsReset(callback: () => void): () => void;
}

export function isSpeechActive(status?: SpeechStatus): boolean {
  return status === SpeechStatus.Playing || status === SpeechStatus.Paused || status === SpeechStatus.Loading;
}
