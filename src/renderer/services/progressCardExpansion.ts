/**
 * Whether the user keeps the progress card above the composer open.
 *
 * Like Claude Code's task list (Ctrl+T), the card stays folded to one line
 * unless the user opens it: an agent that is working does not get to push the
 * conversation up. Whichever way the user leaves it carries over to the next
 * card, other sessions, and restarts.
 */
const STORAGE_KEY = 'lobsterai.progress-card-expanded';

export function readProgressCardExpanded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberProgressCardExpanded(expanded: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, expanded ? '1' : '0');
  } catch {
    // Best effort: the card still toggles for the session it is in.
  }
}
