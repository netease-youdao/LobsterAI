import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quit: vi.fn(),
  focus: vi.fn(),
  showMessageBox: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    quit: mocks.quit,
    focus: mocks.focus,
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
  },
}));

import {
  APP_QUIT_CANCEL_BUTTON_INDEX,
  APP_QUIT_CONFIRM_BUTTON_INDEX,
  AppQuitConfirmationGate,
  appQuitConfirmationGate,
  AppQuitRequestVerdict,
  buildAppQuitConfirmationOptions,
  isAppQuitConfirmed,
  quitAppWithoutConfirmation,
  showAppQuitConfirmation,
} from './appQuitConfirmation';

describe('AppQuitConfirmationGate', () => {
  test('prompts on a user quit and ignores repeats while the prompt is open', () => {
    const gate = new AppQuitConfirmationGate();

    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Prompt);
    expect(gate.isPromptOpen()).toBe(true);
    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Ignore);

    expect(gate.finishPrompt(false)).toBe(false);
    expect(gate.isPromptOpen()).toBe(false);
    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Prompt);
    expect(gate.finishPrompt(true)).toBe(true);
    expect(gate.isPromptOpen()).toBe(false);
  });

  test('an armed bypass is consumed by exactly one quit request', () => {
    const gate = new AppQuitConfirmationGate();
    gate.armBypass();

    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Bypass);
    expect(gate.isPromptOpen()).toBe(false);
    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Prompt);
  });

  test('a programmatic quit during an open prompt is deferred until the prompt closes', () => {
    const gate = new AppQuitConfirmationGate();
    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Prompt);

    gate.armBypass();
    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Ignore);
    expect(gate.isPromptOpen()).toBe(true);

    // The user cancelled, but the update/relaunch flow is waiting for the exit.
    expect(gate.finishPrompt(false)).toBe(true);
    expect(gate.isPromptOpen()).toBe(false);
    // The bypass was consumed by that decision; the next quit prompts again.
    expect(gate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Prompt);
    expect(gate.finishPrompt(true)).toBe(true);
  });
});

describe('buildAppQuitConfirmationOptions', () => {
  test('builds a warning alert with Quit as default and Cancel as escape', () => {
    const options = buildAppQuitConfirmationOptions({
      appName: 'LobsterAI',
      translate: key => `<${key}>`,
    });

    expect(options).toEqual({
      type: 'warning',
      title: 'LobsterAI',
      message: '<appQuitConfirmTitle>',
      detail: '<appQuitConfirmDetail>',
      buttons: ['<appQuitConfirmQuit>', '<appQuitConfirmCancel>'],
      defaultId: APP_QUIT_CONFIRM_BUTTON_INDEX,
      cancelId: APP_QUIT_CANCEL_BUTTON_INDEX,
      noLink: true,
    });
    expect(options.buttons?.[options.defaultId ?? -1]).toBe('<appQuitConfirmQuit>');
    expect(options.buttons?.[options.cancelId ?? -1]).toBe('<appQuitConfirmCancel>');
  });

  test('warns that unsafe Markdown edits will be lost and defaults to Cancel', () => {
    const options = buildAppQuitConfirmationOptions({
      appName: 'LobsterAI',
      translate: key => `<${key}>`,
      hasUnsafeMarkdownEdits: true,
    });

    expect(options.detail).toBe('<appQuitConfirmUnsafeMarkdown>\n\n<appQuitConfirmDetail>');
    expect(options.defaultId).toBe(APP_QUIT_CANCEL_BUTTON_INDEX);
    expect(options.cancelId).toBe(APP_QUIT_CANCEL_BUTTON_INDEX);
  });
});

describe('isAppQuitConfirmed', () => {
  test.each([
    [APP_QUIT_CONFIRM_BUTTON_INDEX, true],
    [APP_QUIT_CANCEL_BUTTON_INDEX, false],
    [-1000, false],
  ])('response %i → confirmed=%s', (response, confirmed) => {
    expect(isAppQuitConfirmed(response)).toBe(confirmed);
  });
});

describe('showAppQuitConfirmation', () => {
  beforeEach(() => {
    mocks.focus.mockReset();
    mocks.showMessageBox.mockReset();
  });

  test('brings the app forward and resolves true when the user picks Quit', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: APP_QUIT_CONFIRM_BUTTON_INDEX, checkboxChecked: false });

    await expect(showAppQuitConfirmation()).resolves.toBe(true);

    expect(mocks.focus).toHaveBeenCalledWith({ steal: true });
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    const [options] = mocks.showMessageBox.mock.calls[0];
    expect(options).toMatchObject({ type: 'warning', title: 'LobsterAI', noLink: true });
    expect(options.buttons).toHaveLength(2);
    expect(options.message).not.toBe('appQuitConfirmTitle');
    expect(options.detail).not.toBe('appQuitConfirmDetail');
  });

  test('resolves false when the user cancels', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: APP_QUIT_CANCEL_BUTTON_INDEX, checkboxChecked: false });

    await expect(showAppQuitConfirmation()).resolves.toBe(false);
  });

  test('requires only one confirmation when the initial prompt warns about unsafe edits', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: APP_QUIT_CONFIRM_BUTTON_INDEX });

    await expect(showAppQuitConfirmation(() => true)).resolves.toBe(true);

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox.mock.calls[0][0].defaultId).toBe(APP_QUIT_CANCEL_BUTTON_INDEX);
  });

  test.each([
    [APP_QUIT_CONFIRM_BUTTON_INDEX, true],
    [APP_QUIT_CANCEL_BUTTON_INDEX, false],
  ])('asks again when edits become unsafe during the generic prompt: response %i', async (response, expected) => {
    const hasUnsafeMarkdownEdits = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: APP_QUIT_CONFIRM_BUTTON_INDEX })
      .mockResolvedValueOnce({ response });

    await expect(showAppQuitConfirmation(hasUnsafeMarkdownEdits)).resolves.toBe(expected);

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    expect(mocks.showMessageBox.mock.calls[0][0].defaultId).toBe(APP_QUIT_CONFIRM_BUTTON_INDEX);
    expect(mocks.showMessageBox.mock.calls[1][0].defaultId).toBe(APP_QUIT_CANCEL_BUTTON_INDEX);
  });

  test('does not ask again after the user cancels the generic prompt', async () => {
    const hasUnsafeMarkdownEdits = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    mocks.showMessageBox.mockResolvedValue({ response: APP_QUIT_CANCEL_BUTTON_INDEX });

    await expect(showAppQuitConfirmation(hasUnsafeMarkdownEdits)).resolves.toBe(false);

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });

  test('does not add a second prompt when a programmatic quit arrives during confirmation', async () => {
    const hasUnsafeMarkdownEdits = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    expect(appQuitConfirmationGate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Prompt);
    mocks.showMessageBox.mockImplementation(async () => {
      appQuitConfirmationGate.armBypass();
      return { response: APP_QUIT_CONFIRM_BUTTON_INDEX };
    });

    await expect(showAppQuitConfirmation(hasUnsafeMarkdownEdits)).resolves.toBe(true);

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(appQuitConfirmationGate.finishPrompt(false)).toBe(true);
  });

  test('propagates an unsafe-edit prompt failure instead of confirming the quit', async () => {
    const error = new Error('dialog unavailable');
    mocks.showMessageBox.mockRejectedValue(error);

    await expect(showAppQuitConfirmation(() => true)).rejects.toBe(error);
  });

  test('still shows the prompt when focusing the app throws', async () => {
    mocks.focus.mockImplementation(() => {
      throw new Error('no window server');
    });
    mocks.showMessageBox.mockResolvedValue({ response: APP_QUIT_CONFIRM_BUTTON_INDEX, checkboxChecked: false });

    await expect(showAppQuitConfirmation()).resolves.toBe(true);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe('quitAppWithoutConfirmation', () => {
  test('arms the shared gate before asking Electron to quit', () => {
    mocks.quit.mockReset();

    quitAppWithoutConfirmation('unit test');

    expect(mocks.quit).toHaveBeenCalledTimes(1);
    expect(appQuitConfirmationGate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Bypass);
    expect(appQuitConfirmationGate.resolveQuitRequest()).toBe(AppQuitRequestVerdict.Prompt);
    expect(appQuitConfirmationGate.finishPrompt(false)).toBe(false);
  });
});
