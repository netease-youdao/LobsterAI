export const MediaConfirmationKind = { Image: 'image_generation', Video: 'video_generation' } as const;
export type MediaConfirmationKind = (typeof MediaConfirmationKind)[keyof typeof MediaConfirmationKind];

/** Local confirmation protocol. Analytics reuse existing Hive columns. */
export const MediaConfirmationPolicy = {
  Kind: MediaConfirmationKind.Video,
  /** A quote older than this is re-read from the model catalogue when the user confirms. */
  QuoteFreshMs: 120_000,
  RetentionMs: 30 * 60_000,
} as const;

export const MediaConfirmationStatus = {
  Waiting: 'waiting',
  Visible: 'visible',
  /** Re-reading a stale quote after the user confirmed. */
  Refreshing: 'refreshing',
} as const;
export type MediaConfirmationStatus =
  (typeof MediaConfirmationStatus)[keyof typeof MediaConfirmationStatus];

export const MediaConfirmationAction = {
  Shown: 'shown',
  Respond: 'respond',
} as const;
export type MediaConfirmationAction =
  (typeof MediaConfirmationAction)[keyof typeof MediaConfirmationAction];

export const MediaConfirmationReason = {
  UserCancelled: 'user_cancelled',
  Expired: 'confirmation_expired',
  Timeout: 'confirmation_timeout',
  NotDisplayed: 'confirmation_not_displayed',
  NoRoute: 'confirmation_no_route',
  AccountChanged: 'confirmation_account_changed',
  Interrupted: 'confirmation_interrupted',
  InvalidAnswer: 'confirmation_invalid_answer',
  Skipped: 'confirmation_skipped',
  RefreshFailed: 'confirmation_refresh_failed',
} as const;
export type MediaConfirmationReason =
  (typeof MediaConfirmationReason)[keyof typeof MediaConfirmationReason];

export const MediaConfirmationOutcome = {
  Requested: 'requested',
  Shown: 'shown',
  Expired: 'expired',
  Renewed: 'renewed',
  RefreshFailed: 'refresh_failed',
  Allowed: 'allowed',
  Denied: 'denied',
  Timeout: 'timeout',
  Failed: 'failed',
  Interrupted: 'interrupted',
} as const;
export type MediaConfirmationOutcome =
  (typeof MediaConfirmationOutcome)[keyof typeof MediaConfirmationOutcome];

export const ConfirmationBehavior = { Allow: 'allow', Deny: 'deny' } as const;

/** How far an approval reaches: this attempt, or the rest of the turn at the same model and quote. */
export const MediaConfirmationGrant = { Once: 'once', Turn: 'turn' } as const;
export type MediaConfirmationGrant =
  (typeof MediaConfirmationGrant)[keyof typeof MediaConfirmationGrant];

export interface MediaConfirmationState {
  kind: MediaConfirmationKind;
  revision: number;
  sequence: number;
  status: MediaConfirmationStatus;
  retainedUntil: number;
  /** Set when confirming found a new price; the user must answer again. */
  repriced?: { previousCredits?: number };
  /** The card may offer approving the rest of this turn at the displayed quote. */
  turnGrant?: boolean;
}

export interface MediaConfirmationResponse {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string>;
  skippedQuestionIds?: string[];
  reason?: MediaConfirmationReason;
  /** Omitted means `Once`. */
  grant?: MediaConfirmationGrant;
  /** Set on a turn approval: the quote the user agreed to. */
  quote?: string;
}

export interface MediaConfirmationCommand {
  requestId: string;
  revision: number;
  action: MediaConfirmationAction;
  response?: MediaConfirmationResponse;
}

export interface MediaConfirmationEvent {
  outcome: MediaConfirmationOutcome;
  failureCode?: MediaConfirmationReason;
  durationMs: number;
  count: number;
}

export const readMediaConfirmationState = (value: unknown): MediaConfirmationState | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as MediaConfirmationState;
  return Object.values(MediaConfirmationKind).includes(item.kind) &&
    Number.isInteger(item.revision) &&
    item.revision >= 0 &&
    Number.isInteger(item.sequence) &&
    item.sequence >= 0 &&
    Object.values(MediaConfirmationStatus).includes(item.status) &&
    Number.isFinite(item.retainedUntil) &&
    (item.repriced === undefined || (typeof item.repriced === 'object' && item.repriced !== null)) &&
    (item.turnGrant === undefined || typeof item.turnGrant === 'boolean')
    ? item
    : undefined;
};

export const VideoReferenceKind = { Image: 'image', Video: 'video' } as const;
export type VideoReferenceKind = (typeof VideoReferenceKind)[keyof typeof VideoReferenceKind];

/**
 * Structured facts for the desktop confirmation card. The question text keeps
 * the same facts in prose because it is also the answer key.
 */
export interface VideoConfirmationDetails {
  model: string;
  prompt: string;
  portalUrl: string;
  resolution?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  audio?: boolean;
  estimatedCredits?: number;
  pricingNote?: string;
  references: Array<{ kind: VideoReferenceKind; thumbnail?: string }>;
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export const readVideoConfirmationDetails = (value: unknown): VideoConfirmationDetails | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const model = optionalString(item.model);
  const prompt = optionalString(item.prompt);
  const portalUrl = optionalString(item.portalUrl);
  if (!model || !prompt || !portalUrl) return undefined;
  const kinds = Object.values(VideoReferenceKind) as string[];
  const references = (Array.isArray(item.references) ? item.references : [])
    .filter((reference): reference is { kind: VideoReferenceKind; thumbnail?: unknown } =>
      !!reference && typeof reference === 'object' && kinds.includes((reference as { kind?: string }).kind ?? ''))
    .map(reference => ({ kind: reference.kind, thumbnail: optionalString(reference.thumbnail) }));
  return {
    model,
    prompt,
    portalUrl,
    resolution: optionalString(item.resolution),
    durationSeconds: optionalNumber(item.durationSeconds),
    aspectRatio: optionalString(item.aspectRatio),
    audio: typeof item.audio === 'boolean' ? item.audio : undefined,
    estimatedCredits: optionalNumber(item.estimatedCredits),
    pricingNote: optionalString(item.pricingNote),
    references,
  };
};
