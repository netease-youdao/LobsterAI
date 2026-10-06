import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  defaultNotificationSettings,
  normalizeNotificationSettings,
  type NotificationSettings,
  TaskCompletionNotificationMode,
  WaitingNotificationKind,
} from '../../shared/notifications/constants';
import { t } from '../i18n';

const hoisted = vi.hoisted(() => {
  class FakeNotification {
    static supported = true;
    static instances: FakeNotification[] = [];

    options: Record<string, unknown>;
    shown = false;
    closed = false;
    private clickHandlers: Array<() => void> = [];

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeNotification.instances.push(this);
    }

    static isSupported(): boolean {
      return FakeNotification.supported;
    }

    on(event: string, handler: () => void): void {
      if (event === 'click') this.clickHandlers.push(handler);
    }

    show(): void {
      this.shown = true;
    }

    close(): void {
      this.closed = true;
    }

    click(): void {
      for (const handler of this.clickHandlers) handler();
    }
  }
  return { FakeNotification };
});

vi.mock('electron', () => ({
  app: { dock: undefined },
  Notification: hoisted.FakeNotification,
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({ isEmpty: () => false }),
  },
}));

import { SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../shared/cowork/constants';
import { DesktopNotificationManager } from './desktopNotificationManager';

const { FakeNotification } = hoisted;

interface FakeWindowState {
  focused?: boolean;
  visible?: boolean;
  minimized?: boolean;
  destroyed?: boolean;
}

const makeWindow = (state: FakeWindowState = {}) => {
  const win = {
    isDestroyed: () => state.destroyed ?? false,
    isVisible: () => state.visible ?? true,
    isMinimized: () => state.minimized ?? false,
    isFocused: () => state.focused ?? true,
    setOverlayIcon: vi.fn(),
    flashFrame: vi.fn(),
  };
  return { win: win as unknown as BrowserWindow, state };
};

const createManager = (options?: {
  windowState?: FakeWindowState;
  settings?: Partial<NotificationSettings>;
}) => {
  const { win, state: windowState } = makeWindow(options?.windowState ?? { focused: false });
  const harness = {
    windowState,
    settings: options?.settings as Partial<NotificationSettings> | undefined,
    trayCalls: [] as Array<{ count: number; hasClick: boolean }>,
    openedSessions: [] as string[],
    focusCount: 0,
    titles: new Map<string, string>(),
  };
  const manager = new DesktopNotificationManager({
    getWindow: () => win,
    getNotificationIconPath: () => null,
    getNotificationSettings: () => harness.settings,
    getSessionTitle: (sessionId) => harness.titles.get(sessionId) ?? null,
    focusMainWindow: () => {
      harness.focusCount += 1;
    },
    openSession: (sessionId) => {
      harness.openedSessions.push(sessionId);
    },
    updateTrayReminder: (count, onClick) => {
      harness.trayCalls.push({ count, hasClick: !!onClick });
    },
  });
  return { manager, harness };
};

const shownNotifications = () => FakeNotification.instances.filter((n) => n.shown && !n.closed);

beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
});

describe('normalizeNotificationSettings', () => {
  test('falls back to defaults when value is missing', () => {
    expect(normalizeNotificationSettings(undefined)).toEqual(defaultNotificationSettings);
    expect(normalizeNotificationSettings(null)).toEqual(defaultNotificationSettings);
  });

  test('migrates the legacy boolean switch', () => {
    expect(
      normalizeNotificationSettings({ taskCompletionNotificationsEnabled: true })
        .taskCompletionNotificationMode,
    ).toBe(TaskCompletionNotificationMode.Unfocused);
    expect(
      normalizeNotificationSettings({ taskCompletionNotificationsEnabled: false })
        .taskCompletionNotificationMode,
    ).toBe(TaskCompletionNotificationMode.Off);
  });

  test('prefers the explicit mode over the legacy boolean', () => {
    const normalized = normalizeNotificationSettings({
      taskCompletionNotificationMode: TaskCompletionNotificationMode.Always,
      taskCompletionNotificationsEnabled: false,
    });
    expect(normalized.taskCompletionNotificationMode).toBe(TaskCompletionNotificationMode.Always);
  });

  test('rejects unknown mode values', () => {
    const normalized = normalizeNotificationSettings({
      taskCompletionNotificationMode: 'sometimes' as TaskCompletionNotificationMode,
    });
    expect(normalized.taskCompletionNotificationMode).toBe(TaskCompletionNotificationMode.Unfocused);
  });

  test('keeps the legacy boolean in sync for downgrade compatibility', () => {
    expect(
      normalizeNotificationSettings({
        taskCompletionNotificationMode: TaskCompletionNotificationMode.Off,
      }).taskCompletionNotificationsEnabled,
    ).toBe(false);
    expect(
      normalizeNotificationSettings({
        taskCompletionNotificationMode: TaskCompletionNotificationMode.Always,
      }).taskCompletionNotificationsEnabled,
    ).toBe(true);
  });
});

describe('handleComplete', () => {
  test('mode off suppresses notifications and attention state', () => {
    const { manager, harness } = createManager({
      settings: { taskCompletionNotificationMode: TaskCompletionNotificationMode.Off },
    });
    manager.handleComplete('session-1');
    expect(FakeNotification.instances).toHaveLength(0);
    expect(harness.trayCalls).toHaveLength(0);
  });

  test('mode unfocused skips completions while the window is foreground', () => {
    const { manager, harness } = createManager({ windowState: { focused: true } });
    manager.handleComplete('session-1');
    expect(FakeNotification.instances).toHaveLength(0);
    expect(harness.trayCalls).toHaveLength(0);
  });

  test('mode unfocused notifies and records pending state in the background', () => {
    const { manager, harness } = createManager();
    harness.titles.set('session-1', 'My Task');
    manager.handleComplete('session-1');
    expect(shownNotifications()).toHaveLength(1);
    expect(shownNotifications()[0].options.title).toBe('My Task');
    expect(harness.trayCalls).toEqual([{ count: 1, hasClick: true }]);
  });

  test('falls back to the generic title when the session has no title', () => {
    const { manager } = createManager();
    manager.handleComplete('session-1');
    expect(shownNotifications()[0].options.title).toBe(t('taskCompletionNotificationTitle'));
  });

  test('mode always notifies while foreground without pending state', () => {
    const { manager, harness } = createManager({
      windowState: { focused: true },
      settings: { taskCompletionNotificationMode: TaskCompletionNotificationMode.Always },
    });
    manager.handleComplete('session-1');
    expect(shownNotifications()).toHaveLength(1);
    expect(harness.trayCalls).toHaveLength(0);
  });

  test('mode always records pending state in the background', () => {
    const { manager, harness } = createManager({
      settings: { taskCompletionNotificationMode: TaskCompletionNotificationMode.Always },
    });
    manager.handleComplete('session-1');
    expect(shownNotifications()).toHaveLength(1);
    expect(harness.trayCalls).toEqual([{ count: 1, hasClick: true }]);
  });

  test('duplicate complete events do not double count', () => {
    const { manager, harness } = createManager();
    manager.handleComplete('session-1');
    manager.handleComplete('session-1');
    expect(FakeNotification.instances).toHaveLength(1);
    expect(harness.trayCalls).toEqual([{ count: 1, hasClick: true }]);
  });

  test('clicking a completion notification opens the session', () => {
    const { manager, harness } = createManager();
    manager.handleComplete('session-1');
    FakeNotification.instances[0].click();
    expect(harness.focusCount).toBe(1);
    expect(harness.openedSessions).toEqual(['session-1']);
  });
});

describe('completion clearing', () => {
  test('markSessionViewed clears pending state and closes the notification', () => {
    const { manager, harness } = createManager();
    manager.handleComplete('session-1');
    manager.markSessionViewed('session-1');
    expect(FakeNotification.instances[0].closed).toBe(true);
    expect(harness.trayCalls.at(-1)).toEqual({ count: 0, hasClick: false });
  });

  test('markSessionViewed for an unknown session is a no-op', () => {
    const { manager, harness } = createManager();
    manager.handleComplete('session-1');
    const trayCallsBefore = harness.trayCalls.length;
    manager.markSessionViewed('other-session');
    expect(harness.trayCalls).toHaveLength(trayCallsBefore);
  });

  test('handleSessionDeleted clears pending state', () => {
    const { manager, harness } = createManager();
    manager.handleComplete('session-1');
    manager.handleSessionDeleted('session-1');
    expect(FakeNotification.instances[0].closed).toBe(true);
    expect(harness.trayCalls.at(-1)).toEqual({ count: 0, hasClick: false });
  });

  test('handleWindowFocused clears all pending completions', () => {
    const { manager, harness } = createManager();
    manager.handleComplete('session-1');
    manager.handleComplete('session-2');
    manager.handleWindowFocused();
    expect(shownNotifications()).toHaveLength(0);
    expect(harness.trayCalls.at(-1)).toEqual({ count: 0, hasClick: false });
  });
});

describe('waiting notifications', () => {
  const request = (requestId: string, toolName = 'Bash') => ({ requestId, toolName });

  test('shows a persistent approval notification when the session is not viewed', () => {
    const { manager, harness } = createManager();
    harness.titles.set('session-1', 'My Task');
    manager.handlePermissionRequest('session-1', request('req-1'));
    const shown = shownNotifications();
    expect(shown).toHaveLength(1);
    expect(shown[0].options.title).toBe('My Task');
    expect(shown[0].options.body).toBe(t('permissionNotificationBody', { toolName: 'Bash' }));
    if (process.platform !== 'win32') {
      expect(shown[0].options.timeoutType).toBe('never');
    }
  });

  test('uses the question copy and toggle for AskUserQuestion requests', () => {
    const { manager } = createManager();
    manager.handlePermissionRequest('session-1', request('req-1', 'AskUserQuestion'));
    expect(shownNotifications()[0].options.body).toBe(t('questionNotificationBody'));
  });

  test('respects the per-kind toggles', () => {
    const { manager } = createManager({
      settings: { permissionNotificationsEnabled: false },
    });
    manager.handlePermissionRequest('session-1', request('req-1'));
    expect(FakeNotification.instances).toHaveLength(0);

    const { manager: questionManager } = createManager({
      settings: { questionNotificationsEnabled: false },
    });
    questionManager.handlePermissionRequest('session-1', request('req-2', 'AskUserQuestion'));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  test('suppresses requests for the session being viewed in the foreground', () => {
    const { manager } = createManager({ windowState: { focused: true } });
    manager.setActiveSession('session-1');
    manager.handlePermissionRequest('session-1', request('req-1'));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  test('notifies for background sessions even when the window is focused', () => {
    const { manager } = createManager({ windowState: { focused: true } });
    manager.setActiveSession('session-other');
    manager.handlePermissionRequest('session-1', request('req-1'));
    expect(shownNotifications()).toHaveLength(1);
  });

  test('notifies while the window is unfocused even for the active session', () => {
    const { manager } = createManager({ windowState: { focused: false } });
    manager.setActiveSession('session-1');
    manager.handlePermissionRequest('session-1', request('req-1'));
    expect(shownNotifications()).toHaveLength(1);
  });

  test('handlePermissionResolved closes the notification', () => {
    const { manager } = createManager();
    manager.handlePermissionRequest('session-1', request('req-1'));
    manager.handlePermissionResolved('req-1');
    expect(FakeNotification.instances[0].closed).toBe(true);
  });

  test('a request resolved before it arrives never raises a notification', () => {
    const { manager } = createManager();
    manager.handlePermissionResolved('req-1');
    manager.handlePermissionRequest('session-1', request('req-1'));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  test('a duplicate request replaces the previous notification', () => {
    const { manager } = createManager();
    manager.handlePermissionRequest('session-1', request('req-1'));
    manager.handlePermissionRequest('session-1', request('req-1'));
    expect(FakeNotification.instances).toHaveLength(2);
    expect(FakeNotification.instances[0].closed).toBe(true);
    expect(shownNotifications()).toHaveLength(1);
  });

  test('setActiveSession closes waiting notifications for that session', () => {
    const { manager } = createManager();
    manager.handlePermissionRequest('session-1', request('req-1'));
    manager.handlePermissionRequest('session-2', request('req-2'));
    manager.setActiveSession('session-1');
    expect(FakeNotification.instances[0].closed).toBe(true);
    expect(FakeNotification.instances[1].closed).toBe(false);
  });

  test('handleSessionStopped closes waiting notifications for the session', () => {
    const { manager } = createManager();
    manager.handlePermissionRequest('session-1', request('req-1'));
    manager.handleSessionStopped('session-1');
    expect(FakeNotification.instances[0].closed).toBe(true);
  });

  test('closeWaitingNotifications only closes the requested kind', () => {
    const { manager } = createManager();
    manager.handlePermissionRequest('session-1', request('req-1'));
    manager.handlePermissionRequest('session-1', request('req-2', 'AskUserQuestion'));
    manager.closeWaitingNotifications(WaitingNotificationKind.Permission, 'test');
    expect(FakeNotification.instances[0].closed).toBe(true);
    expect(FakeNotification.instances[1].closed).toBe(false);
  });

  test('clicking a waiting notification opens the session', () => {
    const { manager, harness } = createManager();
    manager.handlePermissionRequest('session-1', request('req-1'));
    FakeNotification.instances[0].click();
    expect(harness.openedSessions).toEqual(['session-1']);
  });

  test('session-agnostic requests focus the window without opening a session', () => {
    const { manager, harness } = createManager();
    manager.handlePermissionRequest(SESSION_AGNOSTIC_PERMISSION_SESSION_ID, request('req-1'));
    const shown = shownNotifications();
    expect(shown).toHaveLength(1);
    expect(shown[0].options.title).toBe(t('permissionNotificationTitle'));
    shown[0].click();
    expect(harness.focusCount).toBe(1);
    expect(harness.openedSessions).toHaveLength(0);
  });

  test('session-agnostic requests are suppressed while any session is viewed', () => {
    const { manager } = createManager({ windowState: { focused: true } });
    manager.setActiveSession('session-1');
    manager.handlePermissionRequest(SESSION_AGNOSTIC_PERMISSION_SESSION_ID, request('req-1'));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  test('window focus closes waiting notifications for the active session only', () => {
    const { manager, harness } = createManager({ windowState: { focused: false } });
    manager.handlePermissionRequest('session-1', request('req-1'));
    manager.handlePermissionRequest('session-2', request('req-2'));
    manager.setActiveSession('session-1');
    // setActiveSession already closed session-1's notification; re-raise it to
    // simulate a request arriving while the session stays active but unfocused.
    manager.handlePermissionRequest('session-1', request('req-3'));
    harness.windowState.focused = true;
    manager.handleWindowFocused();
    const stillOpenRequestBodies = shownNotifications();
    expect(stillOpenRequestBodies).toHaveLength(1);
  });
});

describe('notification reference cap', () => {
  test('closes the oldest notification beyond the cap', () => {
    const { manager } = createManager();
    for (let i = 0; i < 51; i += 1) {
      manager.handleComplete(`session-${i}`);
    }
    expect(FakeNotification.instances).toHaveLength(51);
    expect(FakeNotification.instances[0].closed).toBe(true);
    expect(shownNotifications()).toHaveLength(50);
  });
});

describe('unsupported platform', () => {
  test('falls back silently when notifications are unsupported', () => {
    FakeNotification.supported = false;
    const { manager, harness } = createManager();
    manager.handleComplete('session-1');
    expect(FakeNotification.instances).toHaveLength(0);
    // Attention state still updates so badges/tray keep working.
    expect(harness.trayCalls).toEqual([{ count: 1, hasClick: true }]);
  });
});
