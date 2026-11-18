import React, { useLayoutEffect, useRef } from 'react';

import {
  sanitizeSidebarBannerHtml,
  SIDEBAR_BANNER_HTML_HOST_STYLE,
} from './sidebarBannerHtml';

interface SidebarAdBannerHtmlProps {
  html: string;
}

const preventNavigation = (event: Event) => {
  event.preventDefault();
};

/**
 * Renders an HTML/CSS banner in an open Shadow DOM. Theme tokens defined on
 * :root (data-theme / .dark) inherit through the shadow boundary, so banner CSS
 * using var(--lobster-*) or :host-context(.dark) follows theme switches live.
 */
const SidebarAdBannerHtml: React.FC<SidebarAdBannerHtmlProps> = ({ html }) => {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `<style>${SIDEBAR_BANNER_HTML_HOST_STYLE}</style>${sanitizeSidebarBannerHtml(html)}`;
    shadowRoot.addEventListener('submit', preventNavigation);
    shadowRoot.addEventListener('dragstart', preventNavigation);
    return () => {
      shadowRoot.removeEventListener('submit', preventNavigation);
      shadowRoot.removeEventListener('dragstart', preventNavigation);
    };
  }, [html]);

  return <div ref={hostRef} aria-hidden="true" className="block w-full" />;
};

export default SidebarAdBannerHtml;
