import { EventEmitter } from 'events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CompanionCapability,
  DEFAULT_DESKTOP_COMPANION_PREFERENCES,
  DesktopCompanionIpc,
  DesktopCompanionSelectionCommandType,
  DesktopCompanionSelectionMode,
} from '../../shared/desktopCompanion/constants';
import { CompanionSelectionAction } from '../../shared/desktopCompanion/selectionActions';

const trusted = vi.hoisted(() => ({ value: true }));
const menu = vi.hoisted(() => ({ build: vi.fn(), popup: vi.fn() }));

vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 400, y: 300 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    screenToDipPoint: (point: unknown) => point,
  },
  systemPreferences: { isTrustedAccessibilityClient: () => trusted.value },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  clipboard: { writeText: vi.fn() },
  Menu: { buildFromTemplate: menu.build },
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
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  destroy() { this.destroyed = true; }
}

let preferences = { ...DEFAULT_DESKTOP_COMPANION_PREFERENCES, enabled: true };
let win: FakeWindow;
let quickAnswer: { abortOwnedBy: ReturnType<typeof vi.fn> };

function create() {
  win = new FakeWindow();
  quickAnswer = { abortOwnedBy: vi.fn() };
  const controller = new CompanionSelectionController({
    preferences: () => preferences,
    isAvailable: () => preferences.enabled,
    createWindow: () => win as never,
    setPreferences: patch => { preferences = { ...preferences, ...patch }; },
    publish: vi.fn(),
    openSettings: vi.fn(),
  }, quickAnswer as never, () => FakeHook as never);
  controller.sync();
  return controller;
}

function select(text = 'ambient co-worker', programName = 'com.microsoft.Word') {
  FakeHook.last!.emit('text-selection', {
    text,
    programName,
    posLevel: 3,
    startTop: { x: 300, y: 200 },
    endTop: { x: 500, y: 200 },
    endBottom: { x: 500, y: 220 },
    mousePosEnd: { x: 480, y: 218 },
  });
}

function sentSelection() {
  const calls = win.webContents.send.mock.calls.filter(([channel]) => channel === DesktopCompanionIpc.Selection);
  return calls[calls.length - 1]?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  menu.build.mockReturnValue({ popup: menu.popup });
  trusted.value = true;
  preferences = { ...DEFAULT_DESKTOP_COMPANION_PREFERENCES, enabled: true };
});

describe('selection toolbar', () => {
  test('overflow actions keep the selection while the native menu handles mouse and keyboard input', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More });
    const items = menu.build.mock.calls[0][0] as Array<{ label?: string; click?: () => void }>;
    expect(items.slice(0, 3).map(item => item.label)).toEqual([
      'desktopCompanionActionExplain', 'desktopCompanionActionSummarize', 'desktopCompanionActionPolish',
    ]);
    expect(items.some(item => item.label === 'desktopCompanionSelectionCopy')).toBe(false);
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    FakeHook.last!.emit('key-down', { uniKey: 'ArrowDown' });
    controller.onForegroundChange();
    expect(win.visible).toBe(true);
    expect(sentSelection().text).toBe('ambient co-worker');

    items[1].click?.();
    expect(sentSelection()).toMatchObject({
      mode: DesktopCompanionSelectionMode.Answer, action: CompanionSelectionAction.Summarize,
    });
    expect(win.focusable).toBe(true);
    const { callback } = menu.popup.mock.calls[0][0] as { callback: () => void };
    callback();
    FakeHook.last!.emit('mouse-down', { x: 5, y: 5, button: 0 });
    expect(win.visible).toBe(false);
    controller.dispose();
  });

  test('an old overflow menu cannot run an action against a replacement selection', () => {
    const controller = create();
    select();
    vi.advanceTimersByTime(200);
    controller.handleCommand({ type: DesktopCompanionSelectionCommandType.More });
    const items = menu.build.mock.calls[0][0] as Array<{ click?: () => void }>;
    select('a different passage');
    items[0].click?.();
    expect(sentSelection()).toMatchObject({ text: 'a different passage', mode: DesktopCompanionSelectionMode.Toolbar });
    controller.dispose();
  });

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

  test('shows the ranked actions under the selection', () => {
    create();
    select();
    vi.advanceTimersByTime(200);
    expect(win.visible).toBe(true);
    expect(win.bounds.y).toBeGreaterThan(200);
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
    FakeHook.last!.emit('mouse-down', { x: win.bounds.x + 10, y: win.bounds.y + 10, button: 0 });
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
