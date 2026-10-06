type ParsedShortcut = {
  key: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  commandOrControl: boolean;
};

type ShortcutPlatformOptions = {
  isMac?: boolean;
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

// A shortcut carrying a Cmd/Ctrl modifier cannot be produced by plain typing,
// so it is safe to run while a text field is focused. Alt alone is excluded
// because Option+key inserts special characters on macOS.
export const isTextEditingSafeShortcut = (shortcut?: string): boolean => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  return parsed.commandOrControl || parsed.ctrl || parsed.meta;
};

export const matchesShortcut = (event: KeyboardEvent, shortcut?: string): boolean => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  if (event.getModifierState?.('AltGraph')) return false;

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

const formatKeyForDisplay = (key: string): string => {
  const normalized = normalizeKey(key);
  const displayKeyMap: Record<string, string> = {
    ' ': 'Space',
    escape: 'Esc',
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
    ',': ',',
    '.': '.',
    '-': '-',
  };
  return displayKeyMap[normalized] ?? (normalized.length === 1 ? normalized.toUpperCase() : key);
};

export const formatShortcutForDisplay = (
  shortcut?: string,
  options: ShortcutPlatformOptions = {},
): string => {
  if (!shortcut) return '';

  const tokens = shortcut
    .split('+')
    .map(token => token.trim())
    .filter(Boolean);

  const displayTokens = tokens.map((token) => {
    const normalized = normalizeToken(token);
    if (commandOrControlAliases.has(normalized)) {
      return options.isMac ? 'Cmd' : 'Ctrl';
    }
    const modifier = modifierAliases[normalized];
    if (modifier === 'meta') return 'Cmd';
    if (modifier === 'ctrl') return 'Ctrl';
    if (modifier === 'alt') return options.isMac ? 'Option' : 'Alt';
    if (modifier === 'shift') return 'Shift';
    return formatKeyForDisplay(token);
  });

  return displayTokens.join('+');
};

export const getShortcutConflictSignature = (
  shortcut?: string,
  options: ShortcutPlatformOptions = {},
): string | null => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return null;

  const ctrl = parsed.commandOrControl ? !options.isMac : parsed.ctrl;
  const meta = parsed.commandOrControl ? Boolean(options.isMac) : parsed.meta;
  return [
    parsed.key,
    parsed.alt ? 'alt' : '',
    parsed.shift ? 'shift' : '',
    ctrl ? 'ctrl' : '',
    meta ? 'meta' : '',
  ].join('|');
};
