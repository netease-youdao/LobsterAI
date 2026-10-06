import { describe, expect, test } from 'vitest';

import {
  HtmlShareErrorCode,
  HtmlShareFailureField,
  HtmlShareFailureKind,
} from '../../../shared/htmlShare/constants';
import {
  createHtmlShareSizeError,
  sanitizeOptionalHtmlShareContent,
  serializeHtmlShareFailure,
} from './htmlShareError';

describe('htmlShareError', () => {
  test('serializes a user-facing size failure without changing its diagnostic message', () => {
    const failure = serializeHtmlShareFailure(
      createHtmlShareSizeError(
        HtmlShareFailureKind.InputTooLong,
        'content is too long.',
        {
          field: HtmlShareFailureField.Content,
          limitBytes: 30,
        },
      ),
      'fallback',
    );

    expect(failure).toEqual({
      success: false,
      code: HtmlShareErrorCode.TooLarge,
      failureKind: HtmlShareFailureKind.InputTooLong,
      details: {
        field: HtmlShareFailureField.Content,
        limitBytes: 30,
      },
      error: 'content is too long.',
    });
  });

  test('classifies unknown exceptions without exposing presentation semantics', () => {
    expect(serializeHtmlShareFailure(new Error('socket failed'), 'fallback')).toEqual({
      success: false,
      failureKind: HtmlShareFailureKind.Unknown,
      error: 'socket failed',
    });
  });

  test('keeps the existing content-length rejection while returning a structured error', () => {
    expect(() => sanitizeOptionalHtmlShareContent('1234', 3)).toThrowError(
      expect.objectContaining({
        code: HtmlShareErrorCode.TooLarge,
        failureKind: HtmlShareFailureKind.InputTooLong,
        details: { field: HtmlShareFailureField.Content },
        message: 'content is too long.',
      }),
    );
    expect(sanitizeOptionalHtmlShareContent(' 123 ', 3)).toBe('123');
  });
});
