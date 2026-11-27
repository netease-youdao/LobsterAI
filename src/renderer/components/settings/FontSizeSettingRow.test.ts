import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { FontPreferences } from '../../config';
import { i18nService } from '../../services/i18n';
import FontSizeSettingRow from './FontSizeSettingRow';

afterEach(() => {
  i18nService.setLanguage('zh', { persist: false });
});

const renderRow = (overrides: Partial<React.ComponentProps<typeof FontSizeSettingRow>> = {}) =>
  renderToStaticMarkup(
    React.createElement(FontSizeSettingRow, {
      id: 'ui-font-size',
      title: i18nService.t('uiFontSize'),
      description: i18nService.t('uiFontSizeDescription'),
      value: FontPreferences.UiFontSizeDefault,
      defaultValue: FontPreferences.UiFontSizeDefault,
      min: FontPreferences.UiFontSizeMin,
      max: FontPreferences.UiFontSizeMax,
      onChange: vi.fn(),
      ...overrides,
    }),
  );

describe('FontSizeSettingRow', () => {
  test('renders range hint and hides reset button at the default value', () => {
    i18nService.setLanguage('zh', { persist: false });
    const zhHtml = renderRow();
    expect(zhHtml).toContain('范围 12–20 px，默认 15 px');
    expect(zhHtml).toContain('role="spinbutton"');
    expect(zhHtml).toContain('aria-valuemin="12"');
    expect(zhHtml).toContain('aria-valuemax="20"');
    expect(zhHtml).toContain('aria-valuenow="15"');
    expect(zhHtml).not.toContain('恢复默认');

    i18nService.setLanguage('en', { persist: false });
    const enHtml = renderRow();
    expect(enHtml).toContain('Range 12–20 px, default 15 px');
    expect(enHtml).not.toContain('>Reset<');
  });

  test('shows reset button when changed from default and disables stepper buttons at bounds', () => {
    i18nService.setLanguage('zh', { persist: false });

    const maxHtml = renderRow({ value: FontPreferences.UiFontSizeMax });
    expect(maxHtml).toContain('恢复默认');
    expect(maxHtml).toMatch(/<button[^>]*disabled=""[^>]*aria-label="增大字号"/);
    expect(maxHtml).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="减小字号"/);

    const minHtml = renderRow({ value: FontPreferences.UiFontSizeMin });
    expect(minHtml).toContain('恢复默认');
    expect(minHtml).toMatch(/<button[^>]*disabled=""[^>]*aria-label="减小字号"/);
    expect(minHtml).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="增大字号"/);
  });
});
