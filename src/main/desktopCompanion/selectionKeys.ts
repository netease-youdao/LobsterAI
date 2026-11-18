/** What a key pressed in another app means for the selection toolbar. */
export const SelectionKeyEffect = {
  /** Typing or moving the caret changes the selection, so the toolbar goes away. */
  Dismiss: 'dismiss',
  /** A shortcut, function key or media key leaves the selection alone, and the toolbar with it. */
  Keep: 'keep',
  /** macOS area or window screenshot (Cmd+Shift+4): taken when its click or drag ends. */
  Capture: 'capture',
  /** macOS screenshot toolbar (Cmd+Shift+5): may take several clicks before the shot. */
  CaptureToolbar: 'capture-toolbar',
} as const;
export type SelectionKeyEffect = typeof SelectionKeyEffect[keyof typeof SelectionKeyEffect];

/** The fields of selection-hook's KeyboardEventData this module reads. */
export interface SelectionKeyEvent {
  uniKey?: string;
  vkCode?: number;
  /** Ctrl, Alt or Win on Windows (also Cmd, Option or Fn on macOS) is held. */
  sys?: boolean;
  /** CGEventFlags on macOS. */
  flags?: number;
}

// CGEventFlags masks. Fn is left out on purpose: macOS sets it on arrow and navigation keys.
const MAC_SHIFT = 0x20000;
const MAC_SHORTCUT_FLAGS = 0x40000 | 0x80000 | 0x100000; // Control, Option, Command
const MAC_COMMAND = 0x100000;
// kVK_ANSI_4 and kVK_ANSI_5 from HIToolbox/Events.h.
const MAC_KEY_4 = 0x15;
const MAC_KEY_5 = 0x17;
const NON_TYPING_KEY = /^(F\d{1,2}|PrintScreen|Audio\w*|Media\w*|Brightness\w*|Launch\w*|Browser\w*)$/;
// Screenshot overlays that take the foreground: macOS bundle ids and Windows executables.
const SCREENSHOT_APP = /screencapture|screenshot|screenclipping|snipping|screensketch|snipaste|cleanshot|shottr|xnip|ishot|pixpin|sharex|snagit|fscapture/i;

/** A screenshot tool's overlay came to the front; the toolbar and card should stay to be captured. */
export function isScreenshotApp(appId: string): boolean {
  return SCREENSHOT_APP.test(appId);
}

export function selectionKeyEffect(event: SelectionKeyEvent, platform: NodeJS.Platform): SelectionKeyEffect {
  if (platform === 'darwin') {
    const flags = event.flags ?? 0;
    if ((flags & MAC_COMMAND) && (flags & MAC_SHIFT)) {
      if (event.vkCode === MAC_KEY_4) return SelectionKeyEffect.Capture;
      if (event.vkCode === MAC_KEY_5) return SelectionKeyEffect.CaptureToolbar;
    }
    if (flags & MAC_SHORTCUT_FLAGS) return SelectionKeyEffect.Keep;
  } else if (event.sys) {
    return SelectionKeyEffect.Keep;
  }
  return NON_TYPING_KEY.test(event.uniKey ?? '') ? SelectionKeyEffect.Keep : SelectionKeyEffect.Dismiss;
}
