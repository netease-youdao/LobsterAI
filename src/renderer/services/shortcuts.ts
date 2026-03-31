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
 * Detect if the current platform is macOS
 */
const isMacPlatform = (): boolean => {
  // Check if running in Electron renderer process
  if (typeof window !== 'undefined' && (window as any).electron?.platform) {
    return (window as any).electron.platform === 'darwin';
  }
  // Fallback to navigator.userAgent for web environment
  return navigator.platform.toLowerCase().includes('mac') || 
         navigator.userAgent.toLowerCase().includes('mac');
};

/**
 * Get the default modifier key label for the current platform
 * Returns 'Cmd' for macOS, 'Ctrl' for Windows/Linux
 */
export const getDefaultModifierKey = (): 'Cmd' | 'Ctrl' => {
  return isMacPlatform() ? 'Cmd' : 'Ctrl';
};

/**
 * Get default shortcuts for the current platform
 * macOS: Uses Cmd (⌘) as the primary modifier
 * Windows/Linux: Uses Ctrl as the primary modifier
 */
export const getDefaultShortcuts = (): { newChat: string; search: string; settings: string } => {
  const modifier = getDefaultModifierKey();
  return {
    newChat: `${modifier}+N`,
    search: `${modifier}+F`,
    settings: `${modifier}+,`,
  };
};

/**
 * Convert a KeyboardEvent to a shortcut string
 * e.g. KeyboardEvent with metaKey=true and key='n' → 'Cmd+N' (on macOS)
 */
export const keyboardEventToShortcut = (event: KeyboardEvent): string | null => {
  const parts: string[] = [];
  
  // Add modifiers in consistent order: Cmd/Ctrl, Alt, Shift
  if (event.metaKey) {
    parts.push('Cmd');
  }
  if (event.ctrlKey) {
    parts.push('Ctrl');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  
  // Get the main key
  let key = event.key;
  
  // Ignore modifier-only combinations
  if (key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift') {
    return null;
  }
  
  // Normalize key names
  if (key === ' ') {
    key = 'Space';
  } else if (key.length === 1) {
    // Single character keys - uppercase for letters, keep as-is for others
    key = key.toUpperCase();
  } else {
    // Special keys - capitalize first letter
    key = key.charAt(0).toUpperCase() + key.slice(1);
  }
  
  parts.push(key);
  
  return parts.join('+');
};
