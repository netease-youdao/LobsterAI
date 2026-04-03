const STYLE_ID = 'lobster-theme-styles';

/** Inject a CSS string into the document head */
export function injectStyles(css: string): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/** Remove the injected style element */
export function removeStyles(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(STYLE_ID)?.remove();
}
