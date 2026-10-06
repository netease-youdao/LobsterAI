import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import SiteDeleteWarnings from './SiteDeleteWarnings';

const renderWarnings = (
  showFreeQuotaNotice: boolean,
  showPersistenceWarning: boolean,
): string => renderToStaticMarkup(React.createElement(SiteDeleteWarnings, {
  showFreeQuotaNotice,
  showPersistenceWarning,
}));

describe('SiteDeleteWarnings', () => {
  test('renders no warning container when no additional consequence applies', () => {
    expect(renderWarnings(false, false)).toBe('');
  });

  test('shows the historical site quota warning for a free user', () => {
    const html = renderWarnings(true, false);
    expect(html).toContain(i18nService.t('sitesDeleteQuotaNotice'));
    expect(html).not.toContain(i18nService.t('sitesDeletePersistenceWarning'));
  });

  test('shows the persistence warning independently of subscription status', () => {
    const html = renderWarnings(false, true);
    expect(html).not.toContain(i18nService.t('sitesDeleteQuotaNotice'));
    expect(html).toContain(i18nService.t('sitesDeletePersistenceWarning'));
  });

  test('combines both warnings in one warning container', () => {
    const html = renderWarnings(true, true);
    expect(html).toContain(i18nService.t('sitesDeleteQuotaNotice'));
    expect(html).toContain(i18nService.t('sitesDeletePersistenceWarning'));
    expect(html.match(/border-red-500\/20/g)).toHaveLength(1);
  });
});
