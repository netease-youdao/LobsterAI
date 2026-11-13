export const SendShortcut = {
  Disabled: '',
  Enter: 'Enter',
  ShiftEnter: 'Shift+Enter',
  ControlEnter: 'Ctrl+Enter',
  AltEnter: 'Alt+Enter',
} as const;

export function matchesSendShortcut(
  shortcut: string,
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  isMac: boolean,
): boolean {
  if (event.key !== 'Enter') return false;
  switch (shortcut) {
    case SendShortcut.Disabled: return false;
    case SendShortcut.ShiftEnter: return event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    case SendShortcut.ControlEnter: return (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
      && !event.shiftKey && !event.altKey;
    case SendShortcut.AltEnter: return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    default: return !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
  }
}
