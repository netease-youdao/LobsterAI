/**
 * Where the failing model comes from in LobsterAI terms, so users can tell at
 * a glance whether an error concerns the LobsterAI plan, a vendor coding plan
 * they configured, or their own custom provider.
 */
export const CoworkErrorModelSource = {
  LobsterAIPlan: 'lobsterai-plan',
  CodingPlan: 'coding-plan',
  CustomProvider: 'custom-provider',
  BuiltinOAuth: 'builtin-oauth',
  BuiltinProvider: 'builtin-provider',
} as const;
export type CoworkErrorModelSource = typeof CoworkErrorModelSource[keyof typeof CoworkErrorModelSource];

const COWORK_ERROR_MODEL_SOURCE_VALUES = new Set<string>(Object.values(CoworkErrorModelSource));

export function isCoworkErrorModelSource(value: unknown): value is CoworkErrorModelSource {
  return typeof value === 'string' && COWORK_ERROR_MODEL_SOURCE_VALUES.has(value);
}

/**
 * Technical detail of an underlying provider/API error, preserved alongside the
 * normalized user-facing error copy so the UI can offer a "technical details"
 * disclosure without weakening the friendly primary message.
 *
 * Every preview field originates from OpenClaw's redacted observation pipeline
 * (rawErrorPreview ≤ 400 chars, providerErrorMessagePreview ≤ 200 chars, with
 * API keys / cookies / request ids already redacted). Never place unredacted
 * provider payloads in this structure.
 */
export interface CoworkErrorDetail {
  /** Runtime error message before LobsterAI i18n normalization. */
  rawErrorMessage?: string;
  provider?: string;
  model?: string;
  /** LobsterAI-side classification of where the failing model comes from. */
  modelSource?: CoworkErrorModelSource;
  /** User-visible provider name from Settings (e.g. a custom provider's displayName). */
  providerDisplayName?: string;
  httpCode?: string;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  rawErrorPreview?: string;
  failoverReason?: string;
  providerRuntimeFailureKind?: string;
  /** Model stop reason reported with the failure, e.g. `length` at the output limit. */
  stopReason?: string;
}

const COWORK_ERROR_DETAIL_METADATA_KEYS = [
  'provider',
  'model',
  'httpCode',
  'providerErrorType',
  'providerErrorMessagePreview',
  'rawErrorPreview',
  'failoverReason',
  'providerRuntimeFailureKind',
  'stopReason',
] as const;

type CoworkErrorDetailMetadataKey = typeof COWORK_ERROR_DETAIL_METADATA_KEYS[number];

export type CoworkErrorDetailSourceMetadata = Partial<
  Record<CoworkErrorDetailMetadataKey, string | undefined>
>;

const normalizeField = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Builds the persisted error detail, or undefined when it would carry no
 * information beyond the user-facing message (so metadata stays lean and the
 * UI only offers the disclosure when there is something extra to show).
 */
export function buildCoworkErrorDetail(input: {
  rawErrorMessage?: string;
  displayMessage?: string;
  metadata?: CoworkErrorDetailSourceMetadata;
  modelSource?: CoworkErrorModelSource;
  providerDisplayName?: string;
}): CoworkErrorDetail | undefined {
  const detail: CoworkErrorDetail = {};

  for (const key of COWORK_ERROR_DETAIL_METADATA_KEYS) {
    const value = normalizeField(input.metadata?.[key]);
    if (value) detail[key] = value;
  }

  if (input.modelSource && isCoworkErrorModelSource(input.modelSource)) {
    detail.modelSource = input.modelSource;
  }
  const providerDisplayName = normalizeField(input.providerDisplayName);
  if (providerDisplayName) {
    detail.providerDisplayName = providerDisplayName;
  }

  const rawErrorMessage = normalizeField(input.rawErrorMessage);
  const displayMessage = normalizeField(input.displayMessage);
  if (rawErrorMessage && rawErrorMessage !== displayMessage) {
    detail.rawErrorMessage = rawErrorMessage;
  }

  return Object.keys(detail).length > 0 ? detail : undefined;
}

const COWORK_ERROR_DETAIL_DISPLAY_ORDER: Array<keyof CoworkErrorDetail> = [
  'provider',
  'providerDisplayName',
  'model',
  'modelSource',
  'httpCode',
  'providerErrorType',
  'failoverReason',
  'providerRuntimeFailureKind',
  'stopReason',
  'providerErrorMessagePreview',
  'rawErrorMessage',
  'rawErrorPreview',
];

/**
 * Multi-line `key: value` text for the technical-details disclosure and its
 * copy action. Values are already redacted upstream; this is display-only
 * formatting.
 */
export function formatCoworkErrorDetailText(detail: CoworkErrorDetail): string {
  const lines: string[] = [];
  for (const key of COWORK_ERROR_DETAIL_DISPLAY_ORDER) {
    const value = normalizeField(detail[key]);
    if (value) lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

export function parseCoworkErrorDetail(value: unknown): CoworkErrorDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const detail: CoworkErrorDetail = {};
  for (const key of COWORK_ERROR_DETAIL_DISPLAY_ORDER) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    if (key === 'modelSource') {
      const normalized = normalizeField(raw);
      if (normalized && isCoworkErrorModelSource(normalized)) detail.modelSource = normalized;
      continue;
    }
    const normalized = normalizeField(raw);
    if (normalized) detail[key as Exclude<keyof CoworkErrorDetail, 'modelSource'>] = normalized;
  }
  return Object.keys(detail).length > 0 ? detail : null;
}
