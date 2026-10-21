import { EventEmitter } from 'events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  COMPANION_COPY_MAX_BYTES,
  CompanionCapability,
  DEFAULT_DESKTOP_COMPANION_PREFERENCES,
  DesktopCompanionIpc,
  DesktopCompanionSelectionCommandType,
  DesktopCompanionSelectionMode,
  DesktopCompanionSize,
} from '../../shared/desktopCompanion/constants';
import { CompanionSelectionAction } from '../../shared/desktopCompanion/selectionActions';

const trusted = vi.hoisted(() => ({ value: true }));
const focused = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => focused.value },
  screen: {
    getCursorScreenPoint: () => ({ x: 400, y: 300 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    screenToDipPoint: (point: unknown) => point,
  },
  systemPreferences: { isTrustedAccessibilityClient: () => trusted.value },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

const { CompanionSelectionController } = await import('./companionSelection');

class FakeHook extends EventEmitter {
  static FilterMode = { EXCLUDE_LIST: 2 };
  static PositionLevel = { SEL_FULL: 3 };
  static last: FakeHook | null = null;
  config: Record<string, unknown> | undefined;
  start(config?: Record<string, unknown>) { this.config = config; FakeHook.last = this; return true; }
  stop() { return true; }
  cleanup() {}
  setGlobalFilterMode = vi.fn(() => true);
  getCurrentSelection = vi.fn((): unknown => null);
}

class FakeWindow extends EventEmitter {
  visible = false;
  destroyed = false;
  focusable = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  webContents = Object.assign(new EventEmitter(), { id: 77, send: vi.fn() });
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getBounds() { return this.bounds; }
  setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
  setFocusable(value: boolean) { this.focusable = value; }
  setIgnoreMouseEvents = vi.fn();
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  destroy() { this.destroyed = true; }
}

let preferences = { ...DEFAULT_DESKTOP_COMPANION_PREFERENCES, enabled: true };
let win: FakeWindow;
let quickAnswer: { abortOwnedBy: ReturnType<typeof vi.fn> };
let openSettings: ReturnType<typeof vi.fn>;

function create() {
  win = new FakeWindow();
  quickAnswer = { abortOwnedBy: vi.fn() };
  openSettings = vi.fn();
  const controller = new CompanionSelectionController({
    preferences: () => preferences,
    isAvailable: () => preferences.enabled,
    createWindow: () => win as never,
    setPreferences: patch => { preferences = { ...preferences, ...patch }; },
    publish: vi.fn(),
    openSettings,
  }, quickAnswer as never, () => FakeHook as never);
  controller.sync();
  return controller;
}

function select(text = 'ambient co-worker', programName = 'com.microsoft.Word', lineTop = 200, lastLineTop = lineTop) {
  FakeHook.last!.emit('text-selection', {
    text,
    programName,
    posLevel: 3,
    startTop: { x: 300, y: lineTop },
    startBottom: { x: 300, y: lineTop + 20 },
    endTop: { x: 500, y: lastLineTop },
    endBottom: { x: 500, y: lastLineTop + 20 },
    mousePosEnd: { x: 480, y: lastLineTop + 18 },
  });
}

const PAD = DesktopCompanionSize.SurfacePad;
const MAC_COMMAND = 0x100000;
const MAC_SHIFT = 0x20000;

/** The bottom edge of the toolbar or card inside its window. */
const visibleBottom = () => win.bounds.y + win.bounds.height - PAD
  - (sentSelection()?.mode === DesktopCompanionSelectionMode.Toolbar && !sentSelection()?.menuUp ? DesktopCompanionSize.ToolbarMenu : 0);

function sentSelection() {
  const calls = win.webContents.send.mock.calls.filter(([channel]) => channel === DesktopCompanionIpc.Selection);
  return calls[calls.length - 1]?.[1];
}

function onMac(run: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  try {
    run();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

function drag() {
  FakeHook.last!.emit('mouse-down', { x: 300, y: 200, button: 0 });
  FakeHook.last!.emit('mouse-up', { x: 480, y: 218, button: 0 });
}

// What a direct read returns: no gesture, so the mouse position is (0, 0).
const chromeSelection = { text: 'first selection', programName: 'com.google.Chrome', posLevel: 0, mousePosEnd: { x: 0, y: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  trusted.value = true;
  focused.value = null;
  preferences = { ...DEFAULT_DESKTOP_COMPANION_PREFERENCES, enabled: true };
});

describe('selection toolbar', () => {
  test.each([33_890, 250_000, COMPANION_COPY_MAX_BYTES])('preserves all %i characters of selected JSON for copying', length => {
    const controller = create();
    const prefix = '{"payload":"';
    const suffix = '","tail":"complete"}';
    const text = prefix + 'x'.repeat(length - prefix.length - suffix.length) + suffix;
    select(text);
    expect(sentSelection()?.text.length).toBe(length);
    expect(sentSelection()?.text).toBe(text);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Explain });
    expect(sentSelection()?.text).toBe(text);
    controller.dispose();
  });

  test.each(['x'.repeat(COMPANION_COPY_MAX_BYTES + 1), '字'.repeat(Math.ceil(COMPANION_COPY_MAX_BYTES / 3))])(
    'replaces an oversized selection with a notice and recovers on the next selection', text => {
      const controller = create();
      select(text);
      expect(sentSelection()).toMatchObject({ text: '', tooLarge: true, actions: [], mode: DesktopCompanionSelectionMode.Toolbar });
      controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Explain });
      expect(sentSelection()).toMatchObject({ mode: DesktopCompanionSelectionMode.Toolbar, action: null });
      select('a smaller selection');
      expect(sentSelection()).toMatchObject({ text: 'a smaller selection', tooLarge: false });
      controller.dispose();
    },
  );

  test('preserves selected whitespace and Unicode verbatim', () => {
    const controller = create();
    const text = ' \t\r\n  {"message":"完整内容 🦞"}\r\n\t ';
    select(text);
    expect(sentSelection()?.text).toBe(text);
    controller.dispose();
  });

  test('ignores selections containing only whitespace', () => {
    const controller = create();
    select(' \t\r\n ');
    vi.advanceTimersByTime(200);
    expect(sentSelection()).toBeUndefined();
    expect(win.visible).toBe(false);
    controller.dispose();
  });

  test('reserves menu space before showing the toolbar and keeps the window still when toggling more', () => {
    const controller = create();
    select('ambient co-worker', 'com.microsoft.Word', 450);
    controller.setContentSize({ width: 450, height: 80 });
    vi.advanceTimersByTime(200);
    const toolbar = { ...win.bounds };
    expect(toolbar.height).toBe(80 + DesktopCompanionSize.ToolbarMenu);
    const setBounds = vi.spyOn(win, 'setBounds');
    for (let toggle = 0; toggle < 4; toggle += 1) {
      controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: true });
      expect(sentSelection()).toMatchObject({ mode: DesktopCompanionSelectionMode.Toolbar, menuOpen: true, menuUp: false });
      expect(win.bounds).toEqual(toolbar);
      controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: false });
      expect(win.bounds).toEqual(toolbar);
    }
    expect(setBounds).not.toHaveBeenCalled();
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: true });
    // A click in the menu keeps the toolbar; its actions run on the same selection.
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.PassThrough, passThrough: false });
    FakeHook.last!.emit('mouse-down', { x: toolbar.x + 300, y: toolbar.y + 200, button: 0 });
    expect(win.visible).toBe(true);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Explain });
    expect(sentSelection()).toMatchObject({
      text: 'ambient co-worker', mode: DesktopCompanionSelectionMode.Answer, action: CompanionSelectionAction.Explain, menuOpen: false,
    });
    expect(win.focusable).toBe(true);
    controller.dispose();
  });

  test('reserves space above only near the bottom of the screen, without moving on open or close', () => {
    const controller = create();
    select('ambient co-worker', 'com.microsoft.Word', 800);
    controller.setContentSize({ width: 450, height: 80 });
    vi.advanceTimersByTime(200);
    const toolbar = { ...win.bounds };
    expect(sentSelection()).toMatchObject({ menuOpen: false, menuUp: true });
    expect(toolbar.height).toBe(80 + DesktopCompanionSize.ToolbarMenu);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: true });
    expect(sentSelection()).toMatchObject({ menuOpen: true, menuUp: true });
    expect(win.bounds).toEqual(toolbar);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: false });
    expect(win.bounds).toEqual(toolbar);
    expect(sentSelection()).toMatchObject({ menuOpen: false });
    controller.dispose();
  });

  test.each([false, true])('clicks in unused menu space dismiss the toolbar with menuOpen=%s', menuOpen => {
    const controller = create();
    select();
    controller.setContentSize({ width: 450, height: 80 });
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: menuOpen });
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.PassThrough, passThrough: true });
    // The renderer forwards the pointer over the transparent area beside/below the menu.
    FakeHook.last!.emit('mouse-down', { x: win.bounds.x + PAD + 10, y: win.bounds.y + 120, button: 0 });
    expect(win.visible).toBe(false);
    controller.dispose();
  });

  test('a new selection comes with the menu closed', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: true });
    select('a different passage');
    expect(sentSelection()).toMatchObject({ text: 'a different passage', mode: DesktopCompanionSelectionMode.Toolbar, menuOpen: false });
    controller.dispose();
  });

  test('settings closes the toolbar and opens the settings page', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Settings });
    expect(win.visible).toBe(false);
    expect(openSettings).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  test.each([450, 800])('a dragged toolbar keeps its hit area, menu and answer at the new position from line %i', lineTop => {
    const controller = create();
    select('ambient co-worker', 'com.microsoft.Word', lineTop);
    controller.setContentSize({ width: 450, height: 92 });
    vi.advanceTimersByTime(200);
    const original = controller.selectionToolbarBounds!;
    win.emit('will-move');
    win.bounds = { ...win.bounds, x: win.bounds.x + 120, y: win.bounds.y - 100 };
    win.emit('move');
    const moved = { ...original, x: original.x + 120, y: original.y - 100 };
    expect(controller.selectionToolbarBounds).toEqual(moved);
    expect(sentSelection().pinned).toBe(false);
    FakeHook.last!.emit('mouse-up', { x: moved.x + PAD + 10, y: moved.y + PAD + 4, button: 0 });
    FakeHook.last!.emit('mouse-down', { x: moved.x + PAD + 10, y: moved.y + PAD + 4, button: 0 });
    expect(win.visible).toBe(true);
    controller.setContentSize({ width: 470, height: 92 });
    expect(controller.selectionToolbarBounds).toMatchObject({ x: moved.x, y: moved.y });
    const bounds = { ...win.bounds };
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: true });
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: false });
    expect(win.bounds).toEqual(bounds);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Explain });
    expect(win.bounds).toMatchObject({ x: moved.x, y: moved.y });
    controller.dispose();
  });

  test('a toolbar dragged to the bottom moves menu space above without shifting the visible bar', () => {
    const controller = create();
    select();
    controller.setContentSize({ width: 450, height: 92 });
    vi.advanceTimersByTime(200);
    expect(sentSelection().menuUp).toBe(false);
    win.emit('will-move');
    win.bounds = { ...win.bounds, x: 600, y: 780 };
    win.emit('move');
    FakeHook.last!.emit('mouse-up', { x: 630, y: 806, button: 0 });
    expect(sentSelection()).toMatchObject({ menuUp: true, pinned: false });
    expect(controller.selectionToolbarBounds).toEqual({ x: 600, y: 780, width: 450, height: 92 });
    expect(win.bounds).toEqual({ x: 600, y: 580, width: 450, height: 292 });
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More, open: true });
    FakeHook.last!.emit('mouse-down', { x: 630, y: 806, button: 0 });
    expect(win.visible).toBe(true);
    select('a new selection');
    controller.setContentSize({ width: 450, height: 92 });
    expect(controller.selectionToolbarBounds!.x).not.toBe(600);
    expect(visibleBottom()).toBeLessThanOrEqual(200);
    controller.dispose();
  });

  test('a card the user drags is pinned and keeps its new spot as the answer grows', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Explain });
    controller.setContentSize({ width: 444, height: 200 });
    win.bounds = { ...win.bounds, x: 100, y: 500 };
    win.emit('will-move');
    expect(sentSelection()).toMatchObject({ pinned: true });
    controller.setContentSize({ width: 444, height: 320 });
    expect(win.bounds).toEqual({ x: 100, y: 500, width: 444, height: 320 });
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    expect(win.visible).toBe(true);
    // The next selection starts from the anchor again.
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Dismiss });
    select();
    controller.setContentSize({ width: 450, height: 80 });
    expect(visibleBottom()).toBeLessThanOrEqual(200);
    expect(visibleBottom()).toBeGreaterThan(180);
    controller.dispose();
  });

  test.each([CompanionSelectionAction.Explain, CompanionSelectionAction.Summarize, CompanionSelectionAction.Ask])(
    '%s replaces the measured toolbar in place, even for a long selection', action => {
      const controller = create();
      select('A long selected paragraph', 'com.microsoft.Word', 200, 780);
      controller.setContentSize({ width: 410, height: 80 });
      vi.advanceTimersByTime(200);
      const { x, y } = win.bounds;
      controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action });
      controller.setContentSize({ width: 444, height: 300 });
      expect(win.bounds).toMatchObject({ x, y });
      expect(sentSelection().cardMaxHeight).toBe(DesktopCompanionSize.Answer.height - PAD * 2);
      controller.setContentSize(DesktopCompanionSize.Answer);
      expect(win.bounds).toMatchObject({ x, y });
      controller.dispose();
    },
  );

  test('a growing answer stays by the toolbar until it reaches the screen edge', () => {
    const controller = create();
    select('ambient co-worker', 'com.microsoft.Word', 450, 580);
    vi.advanceTimersByTime(200);
    const { x, y } = win.bounds;
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Explain });
    expect(sentSelection().cardMaxHeight).toBe(DesktopCompanionSize.Answer.height - PAD * 2);
    controller.setContentSize({ width: 444, height: 280 });
    expect(win.bounds).toMatchObject({ x, y });
    controller.setContentSize({ width: 444, height: 900 });
    expect(win.bounds).toMatchObject({ y: 900 - DesktopCompanionSize.Answer.height, height: DesktopCompanionSize.Answer.height });
    controller.dispose();
  });

  test('a bottom-edge card uses the toolbar position without inheriting the upward menu offset', () => {
    const controller = create();
    select('ambient co-worker', 'com.microsoft.Word', 800);
    vi.advanceTimersByTime(200);
    expect(sentSelection().menuUp).toBe(true);
    const toolbar = controller.selectionToolbarBounds!;
    expect(toolbar.y).toBeGreaterThan(win.bounds.y);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Explain });
    expect(win.bounds.height).toBe(DesktopCompanionSize.AnswerStartHeight);
    const bottom = visibleBottom();
    expect(bottom).toBe(900 - PAD);
    controller.setContentSize({ width: 444, height: 236 });
    expect(visibleBottom()).toBe(bottom);
    expect(win.bounds.height).toBe(236);
    controller.hide();
    expect(controller.selectionToolbarBounds).toBeNull();
    controller.dispose();
  });

  test('the transparent margin over the selected line lets clicks through to the app', () => {
    const controller = create();
    select();
    controller.setContentSize({ width: 450, height: 80 });
    vi.advanceTimersByTime(200);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.PassThrough, passThrough: false });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    // A click on the first selected line, inside the window but below the toolbar itself.
    FakeHook.last!.emit('mouse-down', { x: 400, y: win.bounds.y + 80 - 4, button: 0 });
    expect(win.visible).toBe(false);
    controller.dispose();
  });

  test('shortcuts leave the toolbar up and typing closes it', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    FakeHook.last!.emit('key-down', { uniKey: 'c', sys: true, flags: MAC_COMMAND });
    FakeHook.last!.emit('key-down', { uniKey: 'F1', sys: false, flags: 0 });
    expect(win.visible).toBe(true);
    FakeHook.last!.emit('key-down', { uniKey: 'x', sys: false, flags: 0 });
    expect(win.visible).toBe(false);
    controller.dispose();
  });

  test('a macOS screenshot keeps the toolbar through its drag; the next click closes it', () => onMac(() => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    FakeHook.last!.emit('key-down', { uniKey: '$', vkCode: 0x15, sys: true, flags: MAC_COMMAND | MAC_SHIFT });
    expect(controller.capturing).toBe(true);
    // Space switches to window capture; the overlay may also count as an app switch.
    FakeHook.last!.emit('key-down', { uniKey: ' ', sys: false, flags: 0 });
    controller.onForegroundChange();
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    FakeHook.last!.emit('mouse-up', { x: 600, y: 500, button: 0 });
    expect(win.visible).toBe(true);
    vi.advanceTimersByTime(500);
    expect(controller.capturing).toBe(false);
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    expect(win.visible).toBe(false);
    controller.dispose();
  }));

  test('a screenshot overlay coming to the front keeps the toolbar until it goes away', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    controller.onForegroundChange('com.apple.screencaptureui');
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    FakeHook.last!.emit('mouse-up', { x: 600, y: 500, button: 0 });
    FakeHook.last!.emit('mouse-down', { x: 700, y: 520, button: 0 });
    expect(win.visible).toBe(true);
    controller.onForegroundChange('com.microsoft.Word');
    expect(win.visible).toBe(true);
    vi.advanceTimersByTime(500);
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    expect(win.visible).toBe(false);
    controller.dispose();
  });

  test('a screenshot cancelled with Escape keeps the toolbar for the next try', () => onMac(() => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    FakeHook.last!.emit('key-down', { uniKey: '$', vkCode: 0x15, sys: true, flags: MAC_COMMAND | MAC_SHIFT });
    FakeHook.last!.emit('key-down', { uniKey: 'Escape', sys: false, flags: 0 });
    expect(controller.capturing).toBe(false);
    expect(win.visible).toBe(true);
    controller.dispose();
  }));

  test('starts the hook without touching the clipboard and skips default-excluded apps natively', () => {
    const controller = create();
    expect(controller.capability).toBe(CompanionCapability.Ready);
    expect(FakeHook.last?.config).toMatchObject({ enableClipboard: false });
    expect(FakeHook.last?.config?.globalFilterList).toContain('com.apple.finder');
  });

  test('waits for Accessibility on macOS before starting', () => {
    trusted.value = false;
    FakeHook.last = null;
    const controller = create();
    if (process.platform === 'darwin') {
      expect(controller.capability).toBe(CompanionCapability.NeedsPermission);
      expect(FakeHook.last).toBeNull();
      trusted.value = true;
      vi.advanceTimersByTime(2_500);
      expect(controller.capability).toBe(CompanionCapability.Ready);
    }
    controller.dispose();
  });

  test('shows the toolbar just above the selection, centered on a one-line selection', () => {
    const controller = create();
    select();
    controller.setContentSize({ width: 450, height: 80 });
    vi.advanceTimersByTime(200);
    expect(win.visible).toBe(true);
    expect(visibleBottom()).toBeLessThanOrEqual(200);
    expect(win.bounds.x + win.bounds.width / 2).toBe(400);
    expect(sentSelection()).toMatchObject({
      text: 'ambient co-worker',
      appId: 'com.microsoft.Word',
      mode: DesktopCompanionSelectionMode.Toolbar,
      actions: [CompanionSelectionAction.Translate, CompanionSelectionAction.Explain, CompanionSelectionAction.Ask],
    });
  });

  test('ignores LobsterAI, password managers and apps the user excluded', () => {
    preferences = { ...preferences, selectionExcludedApps: ['com.google.Chrome'] };
    create();
    for (const app of ['com.lobsterai.app', 'com.1password.1password', 'com.google.Chrome']) select('secret', app);
    vi.advanceTimersByTime(200);
    expect(win.visible).toBe(false);
  });

  test('a click elsewhere, typing, or switching apps dismisses the toolbar; a click on it does not', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    FakeHook.last!.emit('mouse-down', { x: win.bounds.x + PAD + 10, y: win.bounds.y + PAD + 10, button: 0 });
    expect(win.visible).toBe(true);
    FakeHook.last!.emit('key-down', { uniKey: 'Shift' });
    expect(win.visible).toBe(true);
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    expect(win.visible).toBe(false);
    select();
    vi.advanceTimersByTime(200);
    FakeHook.last!.emit('key-down', { uniKey: 'a' });
    expect(win.visible).toBe(false);
    select();
    vi.advanceTimersByTime(200);
    controller.onForegroundChange();
    expect(win.visible).toBe(false);
  });

  test('running an action turns the toolbar into a focusable answer card that a pin keeps open', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Translate });
    expect(win.focusable).toBe(true);
    expect(sentSelection()).toMatchObject({ mode: DesktopCompanionSelectionMode.Answer, action: CompanionSelectionAction.Translate });
    // Typing into the card or switching apps no longer closes it.
    FakeHook.last!.emit('key-down', { uniKey: 'a' });
    controller.onForegroundChange();
    expect(win.visible).toBe(true);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Pin, pinned: true });
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    expect(win.visible).toBe(true);
    // A new selection does not replace a pinned card.
    select('another text');
    expect(sentSelection()).toMatchObject({ text: 'ambient co-worker', pinned: true });
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Dismiss });
    expect(win.visible).toBe(false);
    expect(win.focusable).toBe(false);
    expect(quickAnswer.abortOwnedBy).toHaveBeenCalledWith(77);
  });

  test('"hide in this app" remembers the app and closes the toolbar', () => {
    const controller = create();
    select('text', 'com.tencent.xinWeChat');
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.ExcludeApp });
    expect(preferences.selectionExcludedApps).toEqual(['com.tencent.xinWeChat']);
    expect(win.visible).toBe(false);
  });

  test('pausing stops the hook for an hour', () => {
    const controller = create();
    select();
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.Pause });
    expect(controller.capability).toBe(CompanionCapability.Off);
    vi.advanceTimersByTime(60 * 60_000 + 2_000);
    expect(controller.capability).toBe(CompanionCapability.Ready);
  });
});

describe('a selection the hook missed on macOS', () => {
  test('is read again once a Chromium app has had time to build its accessibility tree', () => onMac(() => {
    create();
    const hook = FakeHook.last!;
    drag();
    vi.advanceTimersByTime(100);
    expect(hook.getCurrentSelection).toHaveBeenCalledTimes(1);
    hook.getCurrentSelection.mockReturnValue(chromeSelection);
    // Reading inside Chromium's 2 s wait would restart it.
    vi.advanceTimersByTime(2_000);
    expect(hook.getCurrentSelection).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    expect(sentSelection()).toMatchObject({ text: 'first selection', appId: 'com.google.Chrome' });
    vi.advanceTimersByTime(200);
    expect(win.visible).toBe(true);
    // Anchored where the drag ended, not at the (0, 0) a direct read reports.
    expect(win.bounds.x + win.bounds.width / 2).toBe(480);
  }));

  test('is given up after the last read', () => onMac(() => {
    create();
    drag();
    vi.advanceTimersByTime(10_000);
    expect(FakeHook.last!.getCurrentSelection).toHaveBeenCalledTimes(3);
    expect(win.visible).toBe(false);
  }));

  test('is not invented from text that was readable right after the gesture', () => onMac(() => {
    create();
    const hook = FakeHook.last!;
    hook.getCurrentSelection.mockReturnValue(chromeSelection);
    drag();
    vi.advanceTimersByTime(10_000);
    expect(hook.getCurrentSelection).toHaveBeenCalledTimes(1);
    expect(win.visible).toBe(false);
  }));

  test('is not read when the hook reported the gesture or the user moved on', () => onMac(() => {
    const controller = create();
    const hook = FakeHook.last!;
    drag();
    select();
    vi.advanceTimersByTime(10_000);
    expect(hook.getCurrentSelection).not.toHaveBeenCalled();
    for (const interrupt of [
      () => hook.emit('mouse-down', { x: 5, y: 5, button: 0 }),
      () => hook.emit('key-down', { uniKey: 'c' }),
      () => hook.emit('mouse-wheel', { x: 5, y: 5, button: 0, flag: 1 }),
      () => controller.onForegroundChange(),
    ]) {
      hook.getCurrentSelection.mockClear();
      drag();
      vi.advanceTimersByTime(100);
      interrupt();
      vi.advanceTimersByTime(10_000);
      expect(hook.getCurrentSelection).toHaveBeenCalledTimes(1);
    }
  }));

  test('is only looked for after drags and double-clicks in other apps', () => onMac(() => {
    create();
    const hook = FakeHook.last!;
    hook.emit('mouse-down', { x: 300, y: 200, button: 0 });
    hook.emit('mouse-up', { x: 302, y: 200, button: 0 });
    vi.advanceTimersByTime(1_000);
    expect(hook.getCurrentSelection).not.toHaveBeenCalled();
    focused.value = {};
    drag();
    vi.advanceTimersByTime(10_000);
    expect(hook.getCurrentSelection).not.toHaveBeenCalled();
    focused.value = null;
    for (let click = 0; click < 2; click += 1) {
      hook.emit('mouse-down', { x: 300, y: 200, button: 0 });
      hook.emit('mouse-up', { x: 300, y: 200, button: 0 });
    }
    vi.advanceTimersByTime(100);
    expect(hook.getCurrentSelection).toHaveBeenCalledTimes(1);
  }));
});
