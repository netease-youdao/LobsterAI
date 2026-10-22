export const FeedbackUiEvent = { OpenSettings: 'feedback:open-settings' } as const;
export const FeedbackIpc = { Submit: 'feedback:submit' } as const;
export const FeedbackCategory = {
  Issue: 'issue',
  Suggestion: 'suggestion',
  AiReport: 'ai_report',
} as const;
export type FeedbackCategory = typeof FeedbackCategory[keyof typeof FeedbackCategory];
export const FeedbackError = {
  Invalid: 'invalid',
  Unauthorized: 'unauthorized',
  RateLimited: 'rate_limited',
  Failed: 'failed',
  LogsTooLarge: 'logs_too_large',
} as const;
export type FeedbackError = typeof FeedbackError[keyof typeof FeedbackError];
export const FEEDBACK_LIMITS = {
  content: 10_000,
  images: 10,
  imageBytes: 5 * 1024 * 1024,
  totalImageBytes: 20 * 1024 * 1024,
  logBytes: 50 * 1024 * 1024,
} as const;
export const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const FEEDBACK_PRIVACY_URL = 'https://c.youdao.com/dict/hardware/lobsterai/privacy.html';

export interface FeedbackInput {
  requestId: string;
  category: FeedbackCategory;
  content: string;
  includeLogs: boolean;
  images: { name: string; type: string; bytes: Uint8Array }[];
}
export type FeedbackResult = { success: true; id: number } | { success: false; error: FeedbackError };
export interface FeedbackBridge {
  submit: (input: FeedbackInput) => Promise<FeedbackResult>;
}

export function isValidFeedback(input: FeedbackInput): boolean {
  return Boolean(input && typeof input.requestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)
    && Object.values(FeedbackCategory).includes(input.category)
    && typeof input.content === 'string' && input.content.trim()
    && input.content.length <= FEEDBACK_LIMITS.content
    && typeof input.includeLogs === 'boolean'
    && Array.isArray(input.images) && input.images.length <= FEEDBACK_LIMITS.images
    && input.images.every(image => image && typeof image.name === 'string' && image.name.length <= 255
      && FEEDBACK_IMAGE_TYPES.some(type => type === image.type)
      && image.bytes instanceof Uint8Array && image.bytes.byteLength > 0
      && image.bytes.byteLength <= FEEDBACK_LIMITS.imageBytes)
    && input.images.reduce((total, image) => total + image.bytes.byteLength, 0) <= FEEDBACK_LIMITS.totalImageBytes);
}
