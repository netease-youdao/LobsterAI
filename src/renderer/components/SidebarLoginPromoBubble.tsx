import { CircleStackIcon, GiftIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../services/i18n';

export const SIDEBAR_LOGIN_PROMO_BUBBLE_ID = 'sidebar-login-promo-bubble';

const BENEFIT_ROW_CLASS_NAME = 'flex items-start gap-2';
const BENEFIT_ICON_CLASS_NAME = 'mt-px h-4 w-4 shrink-0';
// Must render as a later sibling of the `peer` login button: the hover and
// keyboard-focus reveal is driven entirely by these peer variants.
const HIDDEN_UNTIL_PEER_ACTIVE_CLASS_NAME = 'invisible translate-y-1 opacity-0 peer-hover:visible peer-hover:translate-y-0 peer-hover:opacity-100 peer-focus-visible:visible peer-focus-visible:translate-y-0 peer-focus-visible:opacity-100';

interface SidebarLoginPromoBubbleProps {
  autoVisible: boolean;
  pennyOfferVisible: boolean;
}

const SidebarLoginPromoBubble: React.FC<SidebarLoginPromoBubbleProps> = ({
  autoVisible,
  pennyOfferVisible,
}) => (
  <div
    id={SIDEBAR_LOGIN_PROMO_BUBBLE_ID}
    role="tooltip"
    className={`pointer-events-none absolute bottom-full left-0 z-40 mb-2.5 w-max max-w-[12.25rem] rounded-2xl border border-border bg-surface px-3 py-2.5 shadow-popover transition-[opacity,transform,visibility] duration-200 ease-out ${
      autoVisible ? 'visible translate-y-0 opacity-100' : HIDDEN_UNTIL_PEER_ACTIVE_CLASS_NAME
    }`}
  >
    <span className="inline-flex h-5 items-center rounded-full bg-foreground px-2 text-[11px] font-medium leading-none text-surface">
      {i18nService.t('sidebarLoginPromoBadge')}
    </span>
    <ul className="mt-2 space-y-1.5 text-[13px] font-medium leading-[18px] text-foreground">
      <li className={BENEFIT_ROW_CLASS_NAME}>
        <GiftIcon className={BENEFIT_ICON_CLASS_NAME} aria-hidden="true" />
        {i18nService.t('sidebarLoginPromoFreeCredits')}
      </li>
      {pennyOfferVisible && (
        <li className={BENEFIT_ROW_CLASS_NAME}>
          <CircleStackIcon className={BENEFIT_ICON_CLASS_NAME} aria-hidden="true" />
          {i18nService.t('sidebarLoginPromoPennyOffer')}
        </li>
      )}
    </ul>
    <span
      className="absolute -bottom-[6px] left-[2.625rem] h-2.5 w-2.5 rotate-45 rounded-[2px] border-b border-r border-border bg-surface"
      aria-hidden="true"
    />
  </div>
);

export default SidebarLoginPromoBubble;
