import { PublishingSubscriptionRecoveryMode } from '@shared/publishing/constants';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import PublishingSubscriptionRecoveryButton from './PublishingSubscriptionRecoveryButton';

const renderButton = (compact = false): string => renderToStaticMarkup(
  React.createElement(PublishingSubscriptionRecoveryButton, {
    recoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
    onClick: () => {},
    compact,
  }),
);

describe('PublishingSubscriptionRecoveryButton', () => {
  test('uses an inverted black and white palette across light and dark themes', () => {
    const html = renderButton();

    expect(html).toContain('bg-black');
    expect(html).toContain('text-white');
    expect(html).toContain('hover:bg-neutral-800');
    expect(html).toContain('active:bg-neutral-700');
    expect(html).toContain('focus-visible:ring-black/40');
    expect(html).toContain('dark:bg-white');
    expect(html).toContain('dark:text-black');
    expect(html).toContain('dark:hover:bg-neutral-200');
    expect(html).toContain('dark:active:bg-neutral-300');
    expect(html).toContain('dark:focus-visible:ring-white/60');
    expect(html).not.toContain('bg-primary');
    expect(html).not.toContain('text-primary-foreground');
  });

  test('preserves normal and compact sizing', () => {
    expect(renderButton()).toContain('h-10 min-w-[112px] px-4 text-sm');
    expect(renderButton(true)).toContain('h-7 px-2.5 text-xs');
  });

  test('uses the concise Chinese automatic recovery label', () => {
    const previousLanguage = i18nService.getLanguage();
    i18nService.setLanguage('zh', { persist: false });

    try {
      const html = renderButton();
      expect(html).toContain('>订阅恢复</button>');
      expect(html).not.toContain('订阅恢复分享');
    } finally {
      i18nService.setLanguage(previousLanguage, { persist: false });
    }
  });
});
