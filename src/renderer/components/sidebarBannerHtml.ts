import DOMPurify, { type Config } from 'dompurify';

/**
 * Admin-configured sidebar banner markup is static HTML + <style> only. It is
 * rendered inside a Shadow DOM so its CSS cannot leak into the app, while the
 * app's --lobster-* theme variables still inherit into it.
 */
export const SIDEBAR_BANNER_HTML_SANITIZE_CONFIG: Config = {
  // Keep a leading <style> block instead of hoisting it out of the body.
  FORCE_BODY: true,
  ADD_TAGS: ['style'],
  // Navigation and interactive controls would bypass the banner's own click
  // handling; the whole banner opens linkUrl externally instead.
  FORBID_TAGS: [
    'a', 'area', 'base', 'button', 'embed', 'form', 'frame', 'iframe', 'input',
    'link', 'meta', 'object', 'script', 'select', 'textarea',
  ],
  FORBID_ATTR: ['href', 'xlink:href', 'action', 'formaction', 'target'],
  ALLOW_DATA_ATTR: true,
};

export const sanitizeSidebarBannerHtml = (html: string): string => String(
  DOMPurify.sanitize(html, SIDEBAR_BANNER_HTML_SANITIZE_CONFIG),
);

/** Host styles for the shadow root: block layout, clip anything positioned outside the banner box. */
export const SIDEBAR_BANNER_HTML_HOST_STYLE = ':host{display:block;overflow:hidden;contain:layout paint;}';
