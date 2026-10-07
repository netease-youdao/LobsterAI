interface ShortcutKeys {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function companionShortcutFromKeys(event: ShortcutKeys): string | null {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const special: Record<string, string> = {
    Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
  };
  const key = special[event.code]
    ?? (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : undefined)
    ?? (/^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : undefined)
    ?? (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key) ? event.key : undefined);
  if (!key) return null;
  return [
    event.metaKey && 'Command',
    event.ctrlKey && 'Control',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    key,
  ].filter(Boolean).join('+');
}
