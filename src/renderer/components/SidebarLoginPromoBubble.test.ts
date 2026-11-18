import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { i18nService } from '../services/i18n';
import SidebarLoginPromoBubble, { SIDEBAR_LOGIN_PROMO_BUBBLE_ID } from './SidebarLoginPromoBubble';

const render = (props: React.ComponentProps<typeof SidebarLoginPromoBubble>) => (
  renderToStaticMarkup(React.createElement(SidebarLoginPromoBubble, props))
);

describe('SidebarLoginPromoBubble', () => {
  test('combines the login reward and the penny offer', () => {
    const html = render({ autoVisible: true, pennyOfferVisible: true });
    expect(html).toContain(`id="${SIDEBAR_LOGIN_PROMO_BUBBLE_ID}"`);
    expect(html).toContain(i18nService.t('sidebarLoginPromoBadge'));
    expect(html).toContain(i18nService.t('sidebarLoginPromoFreeCredits'));
    expect(html).toContain(i18nService.t('sidebarLoginPromoPennyOffer'));
  });

  test('omits the penny offer when the campaign entry is not available', () => {
    const html = render({ autoVisible: true, pennyOfferVisible: false });
    expect(html).toContain(i18nService.t('sidebarLoginPromoFreeCredits'));
    expect(html).not.toContain(i18nService.t('sidebarLoginPromoPennyOffer'));
  });

  test('stays revealable on hover and keyboard focus after the startup tip ends', () => {
    const html = render({ autoVisible: false, pennyOfferVisible: false });
    expect(html).toContain('invisible');
    expect(html).toContain('peer-hover:visible');
    expect(html).toContain('peer-focus-visible:visible');
  });

  test('never intercepts clicks on the sidebar content beneath it', () => {
    expect(render({ autoVisible: true, pennyOfferVisible: true })).toContain('pointer-events-none');
  });
});
