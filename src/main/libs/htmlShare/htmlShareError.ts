import {
  HtmlShareErrorCode,
  type HtmlShareFailureDescriptor,
  type HtmlShareFailureDetails,
  HtmlShareFailureField,
  HtmlShareFailureKind,
  type HtmlShareFailureKind as HtmlShareFailureKindValue,
} from '../../../shared/htmlShare/constants';

interface HtmlShareUserErrorOptions {
  message: string;
  failureKind: HtmlShareFailureKindValue;
  code?: number;
  details?: HtmlShareFailureDetails;
}

export class HtmlShareUserError extends Error {
  readonly code?: number;
  readonly failureKind: HtmlShareFailureKindValue;
  readonly details?: HtmlShareFailureDetails;

  constructor(options: HtmlShareUserErrorOptions) {
    super(options.message);
    this.name = 'HtmlShareUserError';
    this.code = options.code;
    this.failureKind = options.failureKind;
    this.details = options.details;
  }
}

export function createHtmlShareSizeError(
  failureKind:
    | typeof HtmlShareFailureKind.InputTooLong
    | typeof HtmlShareFailureKind.FileTooLarge
    | typeof HtmlShareFailureKind.TotalSizeExceeded
    | typeof HtmlShareFailureKind.ArchiveSizeExceeded
    | typeof HtmlShareFailureKind.FileCountExceeded,
  message: string,
  details?: HtmlShareFailureDetails,
): HtmlShareUserError {
  return new HtmlShareUserError({
    message,
    code: HtmlShareErrorCode.TooLarge,
    failureKind,
    details,
  });
}

export function sanitizeOptionalHtmlShareContent(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error('content must be a string.');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('content is required.');
  }
  if (trimmed.length > maxLength) {
    throw createHtmlShareSizeError(
      HtmlShareFailureKind.InputTooLong,
      'content is too long.',
      { field: HtmlShareFailureField.Content },
    );
  }
  return trimmed;
}

export interface HtmlShareFailureResult extends HtmlShareFailureDescriptor {
  success: false;
}

export function serializeHtmlShareFailure(
  error: unknown,
  fallbackMessage: string,
): HtmlShareFailureResult {
  if (error instanceof HtmlShareUserError) {
    return {
      success: false,
      code: error.code,
      failureKind: error.failureKind,
      details: error.details,
      error: error.message,
    };
  }

  return {
    success: false,
    failureKind: HtmlShareFailureKind.Unknown,
    error: error instanceof Error ? error.message : fallbackMessage,
  };
}
