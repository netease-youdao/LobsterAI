import { describe, expect, test } from 'vitest';

import {
  buildCoworkErrorDetail,
  CoworkErrorModelSource,
  formatCoworkErrorDetailText,
  parseCoworkErrorDetail,
} from './errorDetail';

describe('buildCoworkErrorDetail', () => {
  test('keeps redacted provider metadata for a rate-limit error', () => {
    const detail = buildCoworkErrorDetail({
      rawErrorMessage: 'LLM request failed.',
      displayMessage: '请求过于频繁，请稍后再试。',
      metadata: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        httpCode: '429',
        providerErrorType: 'rate_limit_error',
        providerErrorMessagePreview: 'Number of request tokens has exceeded your per-minute rate limit',
        rawErrorPreview: '429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
        failoverReason: 'rate_limit',
        providerRuntimeFailureKind: 'rate_limit',
      },
    });

    expect(detail).toEqual({
      rawErrorMessage: 'LLM request failed.',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      httpCode: '429',
      providerErrorType: 'rate_limit_error',
      providerErrorMessagePreview: 'Number of request tokens has exceeded your per-minute rate limit',
      rawErrorPreview: '429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
      failoverReason: 'rate_limit',
      providerRuntimeFailureKind: 'rate_limit',
    });
  });

  test('keeps the raw message when i18n normalization rewrote the display copy', () => {
    const detail = buildCoworkErrorDetail({
      rawErrorMessage: '401 authentication_error: invalid x-api-key',
      displayMessage: 'API 密钥无效或已过期，请在设置中检查并更新您的 API 密钥。',
    });

    expect(detail).toEqual({
      rawErrorMessage: '401 authentication_error: invalid x-api-key',
    });
  });

  test('returns undefined when there is nothing beyond the display copy', () => {
    expect(buildCoworkErrorDetail({
      rawErrorMessage: 'OpenClaw run failed',
      displayMessage: 'OpenClaw run failed',
    })).toBeUndefined();

    expect(buildCoworkErrorDetail({
      rawErrorMessage: '  ',
      displayMessage: 'anything',
    })).toBeUndefined();
  });

  test('drops empty and whitespace-only metadata fields', () => {
    const detail = buildCoworkErrorDetail({
      rawErrorMessage: 'LLM request failed.',
      displayMessage: 'LLM request failed.',
      metadata: {
        provider: '  ',
        httpCode: '500',
        rawErrorPreview: '',
      },
    });

    expect(detail).toEqual({ httpCode: '500' });
  });

  test('keeps the model source annotation even without other metadata', () => {
    const detail = buildCoworkErrorDetail({
      rawErrorMessage: 'LLM request failed.',
      displayMessage: 'LLM request failed.',
      modelSource: CoworkErrorModelSource.CustomProvider,
      providerDisplayName: '我的中转',
    });

    expect(detail).toEqual({
      modelSource: 'custom-provider',
      providerDisplayName: '我的中转',
    });
  });

  test('rejects unknown model source values', () => {
    expect(buildCoworkErrorDetail({
      rawErrorMessage: 'x',
      displayMessage: 'x',
      modelSource: 'made-up' as never,
    })).toBeUndefined();
  });
});

describe('formatCoworkErrorDetailText', () => {
  test('renders key/value lines in display order', () => {
    const text = formatCoworkErrorDetailText({
      rawErrorMessage: 'LLM request failed.',
      provider: 'anthropic',
      httpCode: '429',
      providerErrorType: 'rate_limit_error',
    });

    expect(text).toBe([
      'provider: anthropic',
      'httpCode: 429',
      'providerErrorType: rate_limit_error',
      'rawErrorMessage: LLM request failed.',
    ].join('\n'));
  });

  test('includes model source annotations after the model', () => {
    const text = formatCoworkErrorDetailText({
      provider: 'custom',
      providerDisplayName: 'my-relay',
      model: 'kimi-k2.5',
      modelSource: CoworkErrorModelSource.CustomProvider,
    });

    expect(text).toBe([
      'provider: custom',
      'providerDisplayName: my-relay',
      'model: kimi-k2.5',
      'modelSource: custom-provider',
    ].join('\n'));
  });

  test('returns empty string for an empty detail', () => {
    expect(formatCoworkErrorDetailText({})).toBe('');
  });

  test('shows the stop reason before the raw message', () => {
    const detail = buildCoworkErrorDetail({
      rawErrorMessage: 'Agent run ended before producing a complete result.',
      displayMessage: '模型单次回复达到了输出长度上限，任务没有完成。',
      metadata: { provider: 'volcengine', model: 'glm-5.3', stopReason: 'length' },
    });

    expect(detail?.stopReason).toBe('length');
    expect(formatCoworkErrorDetailText(detail ?? {})).toBe([
      'provider: volcengine',
      'model: glm-5.3',
      'stopReason: length',
      'rawErrorMessage: Agent run ended before producing a complete result.',
    ].join('\n'));
  });
});

describe('parseCoworkErrorDetail', () => {
  test('round-trips a detail restored from persisted JSON metadata', () => {
    const persisted = JSON.parse(JSON.stringify({
      provider: 'openai',
      httpCode: '500',
      rawErrorMessage: 'Internal server error',
      unexpected: 123,
    }));

    expect(parseCoworkErrorDetail(persisted)).toEqual({
      provider: 'openai',
      httpCode: '500',
      rawErrorMessage: 'Internal server error',
    });
  });

  test('rejects non-object and empty values', () => {
    expect(parseCoworkErrorDetail(null)).toBeNull();
    expect(parseCoworkErrorDetail('error')).toBeNull();
    expect(parseCoworkErrorDetail([])).toBeNull();
    expect(parseCoworkErrorDetail({ provider: '  ' })).toBeNull();
    expect(parseCoworkErrorDetail({ provider: 42 })).toBeNull();
  });

  test('keeps valid model sources and drops corrupted ones', () => {
    expect(parseCoworkErrorDetail({
      model: 'glm-5',
      modelSource: 'coding-plan',
    })).toEqual({ model: 'glm-5', modelSource: 'coding-plan' });

    expect(parseCoworkErrorDetail({
      model: 'glm-5',
      modelSource: 'not-a-source',
    })).toEqual({ model: 'glm-5' });
  });
});
