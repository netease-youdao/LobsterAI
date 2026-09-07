/**
 * Quit confirmation for user-initiated quits.
 *
 * Scheduled tasks and IM replies only run while LobsterAI is open, so a quit
 * the user triggers (Cmd+Q, app menu, Dock, tray "Quit") pauses at a native
 * confirmation first. Programmatic quits — update install, relaunch, OS
 * logout/shutdown — arm a one-shot bypass so the prompt never gets in the way.
 *
 * The alert is shown without an owner window. On macOS that runs a nested
 * native loop which still services main-process timers and IPC (verified on
 * Electron 40), so IM delivery and cron polling keep working while it is open.
 */
import { app, dialog, type MessageBoxOptions } from 'electron';

import { APP_NAME } from '../appConstants';
import { t } from '../i18n';

export const AppQuitRequestVerdict = {
  /** Skip the prompt: a programmatic quit or OS shutdown already decided. */
  Bypass: 'bypass',
  /** Ask the user before quitting. */
  Prompt: 'prompt',
  /** A prompt is already open; drop this repeated quit request. */
  Ignore: 'ignore',
} as const;
export type AppQuitRequestVerdict =
  typeof AppQuitRequestVerdict[keyof typeof AppQuitRequestVerdict];

/** Indexes into the message box `buttons` array. */
export const APP_QUIT_CONFIRM_BUTTON_INDEX = 0;
export const APP_QUIT_CANCEL_BUTTON_INDEX = 1;

export class AppQuitConfirmationGate {
  private bypassArmed = false;
  private promptOpen = false;

  /** Let the next quit request through without a prompt. */
  armBypass(): void {
    this.bypassArmed = true;
  }

  /**
   * Classify an incoming quit request.
   *
   * While a prompt is open every request is ignored, so repeated Cmd+Q presses
   * do not stack alerts. A bypass armed meanwhile is kept for `finishPrompt()`
   * rather than acted on: on macOS the open alert runs a nested native loop in
   * which `app.exit()` only stops the modal session and the process lives on.
   * Otherwise an armed bypass is consumed by this one request, and a plain
   * user quit opens the prompt.
   */
  resolveQuitRequest(): AppQuitRequestVerdict {
    if (this.promptOpen) {
      return AppQuitRequestVerdict.Ignore;
    }
    if (this.bypassArmed) {
      this.bypassArmed = false;
      return AppQuitRequestVerdict.Bypass;
    }
    this.promptOpen = true;
    return AppQuitRequestVerdict.Prompt;
  }

  /**
   * Close the prompt with the user's answer and report whether to quit: the
   * user's choice, or `true` when a programmatic quit (update install,
   * relaunch) arrived while the prompt was open — that flow has already
   * launched its installer or restart and is waiting for the exit.
   */
  finishPrompt(userConfirmed: boolean): boolean {
    this.promptOpen = false;
    const bypassArmed = this.bypassArmed;
    this.bypassArmed = false;
    return userConfirmed || bypassArmed;
  }

  isPromptOpen(): boolean {
    return this.promptOpen;
  }
}

export const appQuitConfirmationGate = new AppQuitConfirmationGate();

export interface AppQuitConfirmationText {
  appName: string;
  translate: (key: string) => string;
}

/**
 * Native message box options. `buttons[0]` is the default button, which macOS
 * lays out rightmost and Windows leftmost, so this single order renders as
 * "Cancel | Quit" on macOS and "Quit | Cancel" on Windows — both native. The
 * `warning` type is what gives macOS the caution triangle badged with the app
 * icon; `title` only shows on Windows/Linux, where it is the window caption.
 */
export function buildAppQuitConfirmationOptions({
  appName,
  translate,
}: AppQuitConfirmationText): MessageBoxOptions {
  return {
    type: 'warning',
    title: appName,
    message: translate('appQuitConfirmTitle'),
    detail: translate('appQuitConfirmDetail'),
    buttons: [translate('appQuitConfirmQuit'), translate('appQuitConfirmCancel')],
    defaultId: APP_QUIT_CONFIRM_BUTTON_INDEX,
    cancelId: APP_QUIT_CANCEL_BUTTON_INDEX,
    noLink: true,
  };
}

/** Esc, the window close button, and the Cancel button all report `cancelId`. */
export function isAppQuitConfirmed(response: number): boolean {
  return response === APP_QUIT_CONFIRM_BUTTON_INDEX;
}

/**
 * Show the quit confirmation as a standalone alert, so it looks the same
 * whether the quit came from Cmd+Q or from the tray with the window hidden.
 * Resolves `true` when the user chose to quit.
 */
export async function showAppQuitConfirmation(): Promise<boolean> {
  try {
    // A tray-menu quit can arrive while another app is frontmost; do not let
    // the alert open behind it.
    app.focus({ steal: true });
  } catch (error) {
    console.debug('[AppQuit] failed to focus app before quit confirmation:', error);
  }
  const { response } = await dialog.showMessageBox(
    buildAppQuitConfirmationOptions({ appName: APP_NAME, translate: t }),
  );
  return isAppQuitConfirmed(response);
}

/**
 * Quit on behalf of a flow that already carries the user's intent (update
 * install, relaunch). `app.quit()` emits `before-quit` synchronously, which
 * consumes the bypass right away.
 */
export function quitAppWithoutConfirmation(reason: string): void {
  console.log(`[AppQuit] quitting without confirmation (${reason})`);
  appQuitConfirmationGate.armBypass();
  app.quit();
}
