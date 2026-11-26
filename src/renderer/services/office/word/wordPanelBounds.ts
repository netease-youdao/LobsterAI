import type { WordPanelBounds } from '@shared/office/word/constants';

/** A native child view sits above the DOM. Yield its space when a host menu, drawer or dialog covers it. */
export function observeWordPanelBounds(element: HTMLElement, send: (bounds: WordPanelBounds | null) => void): () => void {
  let frame = 0;
  let previous: string | undefined;
  const measure = () => {
    frame = 0;
    const rect = element.getBoundingClientRect();
    const { left, right, top, bottom, width, height } = rect;
    const overlays = document.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"], [aria-modal="true"], [data-local-file-context-menu] > div');
    const covered = Array.from(overlays).some(overlay => {
      if (overlay.contains(element) || element.contains(overlay)) return false;
      const box = overlay.getBoundingClientRect();
      const x = Math.max(left, box.left), y = Math.max(top, box.top);
      const endX = Math.min(right, box.right), endY = Math.min(bottom, box.bottom);
      return endX > x && endY > y && overlay.contains(document.elementFromPoint((x + endX) / 2, (y + endY) / 2));
    });
    const visible = !covered && width > 2 && height > 2 && !element.closest('[aria-hidden="true"]')
      && [[left + 1, top + 1], [right - 1, top + 1], [left + 1, bottom - 1], [right - 1, bottom - 1],
        [(left + right) / 2, (top + bottom) / 2]].every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    const bounds = visible ? { x: left, y: top, width, height } : null;
    const key = JSON.stringify(bounds);
    if (key !== previous) { previous = key; send(bounds); }
    // A transform can move the host between ResizeObserver notifications.
    if (element.getAnimations({ subtree: false }).length || ancestors.some(node => node.getAnimations().length)) schedule();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const ancestors: HTMLElement[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) ancestors.push(node);
  const resize = new ResizeObserver(schedule);
  resize.observe(element);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'aria-hidden'] });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('transitionrun', schedule, true);
  window.addEventListener('transitionend', schedule, true);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('transitionrun', schedule, true);
    window.removeEventListener('transitionend', schedule, true);
  };
}
