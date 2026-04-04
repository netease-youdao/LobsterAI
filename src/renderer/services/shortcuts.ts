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

/**
 * Format a shortcut string for display, applying platform-specific modifier
 * symbols.  On macOS `Cmd` is rendered as `⌘`, `Ctrl` as `⌃`, `Alt` as `⌥`,
 * and `Shift` as `⇧`.  On other platforms the string is returned unchanged.
 */
export const formatShortcutForDisplay = (shortcut: string | undefined): string => {
  if (!shortcut) return '';
  const isMac = typeof window !== 'undefined' && window.electron?.platform === 'darwin';
  if (!isMac) return shortcut;
  return shortcut
    .replace(/\bCmd\b/g, '⌘')
    .replace(/\bCtrl\b/g, '⌃')
    .replace(/\bAlt\b/g, '⌥')
    .replace(/\bShift\b/g, '⇧');
};
