import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import FullAccessConfirmDialog from './FullAccessConfirmDialog';

describe('FullAccessConfirmDialog', () => {
  test('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      React.createElement(FullAccessConfirmDialog, {
        isOpen: false,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toBe('');
  });

  test('renders risk breakdown and enabled confirm button without checkbox when opened', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderToStaticMarkup(
      React.createElement(FullAccessConfirmDialog, {
        isOpen: true,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('z-[9999]');
    expect(html).toContain(i18nService.t('coworkFullAccessConfirmTitle'));
    expect(html).toContain(i18nService.t('coworkFullAccessRiskFilesTitle'));
    expect(html).toContain(i18nService.t('coworkFullAccessRiskTerminalTitle'));
    expect(html).toContain(i18nService.t('coworkFullAccessRiskNetworkTitle'));
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/<button type="button" class="[^"]*">.*<span>启用完全权限<\/span><\/button>/);
  });

  test('renders English copy and disables buttons while confirming', () => {
    i18nService.setLanguage('en', { persist: false });
    const html = renderToStaticMarkup(
      React.createElement(FullAccessConfirmDialog, {
        isOpen: true,
        confirming: true,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toContain('Enable Full Access?');
    expect(html).toContain('Files and folders');
    expect(html).toContain('Terminal commands');
    expect(html).toContain('Internet and connected apps');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*<span>Enable Full Access<\/span><\/button>/);
  });
});
