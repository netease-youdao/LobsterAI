type ParsedShortcut = {
  key: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  commandOrControl: boolean;
};

type ModifierKey = 'alt' | 'ctrl' | 'shift' | 'meta';

const modifierAliases: Record<string, ModifierKey> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  super: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

const commandOrControlAliases = new Set([
  'cmdorctrl',
  'commandorcontrol',
  'cmdorcontrol',
  'ctrlorcmd',
  'ctrlorcommand',
]);

const keyAliases: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  space: ' ',
  spacebar: ' ',
  comma: ',',
  period: '.',
  dot: '.',
  minus: '-',
  dash: '-',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  tab: 'tab',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  pageup: 'pageup',
  pagedown: 'pagedown',
  home: 'home',
  end: 'end',
  insert: 'insert',
};

const normalizeToken = (token: string) => token.trim().toLowerCase();

const normalizeKey = (key: string) => {
  if (key === ' ') return ' ';
  const normalized = normalizeToken(key);
  return keyAliases[normalized] ?? normalized;
};

export const parseShortcut = (shortcut?: string): ParsedShortcut | null => {
  if (!shortcut) return null;
  const tokens = shortcut
    .split('+')
    .map(token => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return null;

  const parsed: ParsedShortcut = {
    key: '',
    alt: false,
    ctrl: false,
    shift: false,
    meta: false,
    commandOrControl: false,
  };

  for (const token of tokens) {
    const normalized = normalizeToken(token);
    if (commandOrControlAliases.has(normalized)) {
      parsed.commandOrControl = true;
      continue;
    }
    const modifier = modifierAliases[normalized];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    parsed.key = normalizeKey(token);
  }

  if (!parsed.key) return null;
  return parsed;
};

/**
 * Detect current platform using window.electron.platform exposed by preload (process.platform).
 * Three distinct platforms: macOS ('darwin'), Windows ('win32'), Linux (everything else).
 */
const platformId = typeof window !== 'undefined' ? window.electron?.platform : undefined;
const isMac = platformId === 'darwin';
const isWindows = platformId === 'win32';
const isLinux = !!platformId && !isMac && !isWindows; // linux, freebsd, etc.

/**
 * Convert an internal shortcut string (e.g. "CmdOrCtrl+Shift+N") into a
 * human-friendly display string.
 *
 * macOS  → ⌃⇧⌥⌘N  (symbol style, no separator)
 * Others → Ctrl+Shift+N
 */
export const formatShortcut = (shortcut?: string): string => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut ?? '';

  const useCtrl = parsed.commandOrControl ? !isMac : parsed.ctrl;
  const useMeta = parsed.commandOrControl ? isMac : parsed.meta;

  // Pretty-print the main key
  const prettyKey = (key: string): string => {
    if (key.length === 1) return key.toUpperCase();
    const map: Record<string, string> = isMac
      ? {
          arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
          enter: '↩', backspace: '⌫', delete: '⌦', tab: '⇥',
          escape: 'Esc', ' ': '␣', ',': ',', '.': '.', '-': '-',
        }
      : {
          arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
          enter: 'Enter', backspace: 'Backspace', delete: 'Delete', tab: 'Tab',
          escape: 'Esc', ' ': 'Space', ',': ',', '.': '.', '-': '-',
        };
    return map[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
  };

  if (isMac) {
    // macOS symbol order: ⌃ Control → ⇧ Shift → ⌥ Option → ⌘ Command
    let display = '';
    if (useCtrl) display += '⌃';
    if (parsed.shift) display += '⇧';
    if (parsed.alt) display += '⌥';
    if (useMeta) display += '⌘';
    display += prettyKey(parsed.key);
    return display;
  }

  // Windows / Linux: Ctrl+Shift+Alt+Key
  const parts: string[] = [];
  if (useCtrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  if (useMeta) parts.push(isLinux ? 'Super' : 'Win');
  parts.push(prettyKey(parsed.key));
  return parts.join('+');
};

/**
 * Convert a KeyboardEvent into the internal shortcut storage string.
 *
 * Returns `null` if no valid main key was pressed (i.e. only modifiers).
 *
 * Platform-specific primary modifier:
 *   - macOS:  Meta/⌘ (metaKey)  — Ctrl is treated as a secondary modifier
 *   - Windows: Ctrl (ctrlKey)   — Win/Meta key alone is NOT accepted
 *   - Linux:   Ctrl (ctrlKey)   — Super/Meta key alone is NOT accepted
 *
 * Shift and Alt/Option are optional secondary modifiers.
 */
export const keyboardEventToShortcut = (event: KeyboardEvent): string | null => {
  const key = event.key;

  // Ignore standalone modifier presses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;

  // Platform-specific primary modifier requirement
  if (isMac) {
    // macOS: must have Meta (⌘); Ctrl alone is not enough for a primary shortcut
    if (!event.metaKey) return null;
  } else {
    // Windows / Linux: must have Ctrl; Meta (Win/Super) alone is not enough
    if (!event.ctrlKey) return null;
  }

  const parts: string[] = [];

  // Use CmdOrCtrl for cross-platform storage when the primary modifier is pressed
  parts.push('CmdOrCtrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');

  // Normalize the key
  const normalizedKey = normalizeKey(key);
  // Re-map back to a readable token
  const reverseKeyMap: Record<string, string> = {
    ' ': 'Space',
    escape: 'Escape',
    enter: 'Enter',
    backspace: 'Backspace',
    delete: 'Delete',
    tab: 'Tab',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    home: 'Home',
    end: 'End',
    insert: 'Insert',
  };
  const keyToken = reverseKeyMap[normalizedKey] ?? (normalizedKey.length === 1 ? normalizedKey.toUpperCase() : normalizedKey);
  parts.push(keyToken);

  return parts.join('+');
};

export const matchesShortcut = (event: KeyboardEvent, shortcut?: string): boolean => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;

  const key = normalizeKey(event.key);
  if (key !== parsed.key) return false;

  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;

  if (parsed.commandOrControl) {
    if (!event.ctrlKey && !event.metaKey) return false;
  } else {
    if (event.ctrlKey !== parsed.ctrl) return false;
    if (event.metaKey !== parsed.meta) return false;
  }

  return true;
};
