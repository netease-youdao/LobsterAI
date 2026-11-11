// Remembers that the user closed the home image examples, so a new task does
// not bring them back. The tab itself stays and reopens them on demand.
const STORAGE_KEY = 'lobsterai.image-creation-home-collapsed';
const COLLAPSED = '1';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): PreferenceStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

export function readHomeExamplesCollapsed(storage: PreferenceStorage | null = defaultStorage()): boolean {
  try { return storage?.getItem(STORAGE_KEY) === COLLAPSED; }
  catch { return false; }
}

export function rememberHomeExamplesCollapsed(collapsed: boolean, storage: PreferenceStorage | null = defaultStorage()): void {
  try {
    if (collapsed) storage?.setItem(STORAGE_KEY, COLLAPSED);
    else storage?.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort preference: unwritable storage only loses the choice.
  }
}
