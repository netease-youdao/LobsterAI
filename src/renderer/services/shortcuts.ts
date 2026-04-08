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
 * Format a shortcut string into human-readable key labels.
 * On macOS, Ctrl is rendered as ⌘ (meta/cmd); on other platforms as Ctrl.
 * Returns an array of label strings, e.g. ['Ctrl', 'N'] or ['⌘', 'N'].
 */
export const formatShortcutLabels = (shortcut: string | undefined, isMac: boolean): string[] => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return [];

  const parts: string[] = [];

  if (parsed.commandOrControl) {
    parts.push(isMac ? '⌘' : 'Ctrl');
  } else if (parsed.ctrl) {
    parts.push(isMac ? '⌃' : 'Ctrl');
  }
  if (parsed.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (parsed.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (parsed.meta && !parsed.commandOrControl) parts.push(isMac ? '⌘' : 'Win');

  // Uppercase single characters; keep special keys as-is
  const key = parsed.key;
  if (key.length === 1) {
    parts.push(key.toUpperCase());
  } else {
    // Capitalize first letter for display
    parts.push(key.charAt(0).toUpperCase() + key.slice(1));
  }

  return parts;
};
