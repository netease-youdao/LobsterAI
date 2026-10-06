import { app, type BrowserWindow, nativeImage, Notification } from 'electron';

import { SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../shared/cowork/constants';
import {
  classifyWaitingNotificationKind,
  normalizeNotificationSettings,
  type NotificationSettings,
  TaskCompletionNotificationMode,
  WaitingNotificationKind,
} from '../../shared/notifications/constants';
import { APP_ATTENTION_BADGE_COLOR } from '../appConstants';
import { t } from '../i18n';

interface PendingCompletionNotification {
  sessionId: string;
  completedAt: number;
}

interface WaitingNotificationRecord {
  sessionId: string;
  requestId: string;
  kind: WaitingNotificationKind;
}

interface ActiveNotificationEntry {
  notification: Notification;
  kind: 'completion' | WaitingNotificationKind;
}

export interface WaitingPermissionRequest {
  requestId: string;
  toolName: string;
}

interface DesktopNotificationManagerOptions {
  getWindow: () => BrowserWindow | null;
  getNotificationIconPath: () => string | null;
  getNotificationSettings: () => Partial<NotificationSettings> | undefined;
  getSessionTitle: (sessionId: string) => string | null;
  focusMainWindow: (reason: string) => void;
  openSession: (sessionId: string) => void;
  updateTrayReminder: (count: number, onClick?: () => void) => void;
}

const MAX_ACTIVE_NOTIFICATION_REFERENCES = 50;
const MAX_RESOLVED_REQUEST_ID_REFERENCES = 200;

export class DesktopNotificationManager {
  private pendingCompletions = new Map<string, PendingCompletionNotification>();
  private activeNotifications = new Map<string, ActiveNotificationEntry>();
  private waitingNotifications = new Map<string, WaitingNotificationRecord>();
  // Requests that resolved before (or without) a visible notification, so a
  // late-arriving request event does not raise a stale notification. Covers
  // auto-approved commands whose resolve fires before the request is emitted.
  private resolvedRequestIds = new Set<string>();
  private windowsOverlayIcons = new Map<string, Electron.NativeImage>();
  private activeSessionId: string | null = null;

  constructor(private readonly options: DesktopNotificationManagerOptions) {}

  handleComplete(sessionId: string): void {
    const settings = normalizeNotificationSettings(this.options.getNotificationSettings());
    const mode = settings.taskCompletionNotificationMode;
    if (mode === TaskCompletionNotificationMode.Off) {
      console.debug(`[DesktopNotification] skipped completed session ${sessionId} because completion notifications are off`);
      return;
    }

    const win = this.options.getWindow();
    if (this.isWindowForeground(win)) {
      if (mode !== TaskCompletionNotificationMode.Always) {
        console.debug(`[DesktopNotification] skipped completed session ${sessionId} because the app is foreground`);
        return;
      }
      // "Always" while foreground: show a transient notification only. The
      // user can already see the result, so no unread state or badge.
      this.showCompletionNotification(sessionId);
      return;
    }

    if (this.pendingCompletions.has(sessionId)) {
      console.debug(`[DesktopNotification] ignored duplicate completed session notification for ${sessionId}`);
      return;
    }

    this.pendingCompletions.set(sessionId, {
      sessionId,
      completedAt: Date.now(),
    });
    console.log(
      `[DesktopNotification] recorded completed session notification for ${sessionId}; pending count ${this.pendingCompletions.size}`,
    );

    this.updateAttentionState();
    this.showCompletionNotification(sessionId);
  }

  handlePermissionRequest(sessionId: string, request: WaitingPermissionRequest): void {
    const { requestId, toolName } = request;
    if (!requestId) return;

    if (this.resolvedRequestIds.delete(requestId)) {
      console.debug(`[DesktopNotification] skipped request ${requestId} because it was already resolved`);
      return;
    }

    const kind = classifyWaitingNotificationKind(toolName);
    const settings = normalizeNotificationSettings(this.options.getNotificationSettings());
    const enabled = kind === WaitingNotificationKind.Question
      ? settings.questionNotificationsEnabled
      : settings.permissionNotificationsEnabled;
    if (!enabled) {
      console.debug(`[DesktopNotification] skipped ${kind} request ${requestId} because ${kind} notifications are disabled`);
      return;
    }

    if (this.isViewingSession(sessionId)) {
      console.debug(`[DesktopNotification] skipped ${kind} request ${requestId} because session ${sessionId} is being viewed`);
      return;
    }

    const existing = this.waitingNotifications.get(requestId);
    if (existing) {
      this.closeNotification(this.waitingNotificationId(existing));
    }
    this.waitingNotifications.set(requestId, { sessionId, requestId, kind });
    this.showWaitingNotification(sessionId, requestId, kind, toolName);
  }

  handlePermissionResolved(requestId: string): void {
    if (!requestId) return;
    const record = this.waitingNotifications.get(requestId);
    if (!record) {
      this.rememberResolvedRequest(requestId);
      return;
    }
    this.removeWaitingNotification(record);
    console.log(`[DesktopNotification] closed ${record.kind} notification for resolved request ${requestId}`);
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    if (sessionId) {
      this.closeWaitingNotificationsForSession(sessionId, 'session viewed');
    }
  }

  handleWindowFocused(): void {
    this.clearAllCompletions('main window focused');
    if (this.activeSessionId) {
      this.closeWaitingNotificationsForSession(this.activeSessionId, 'window focused');
    }
  }

  markSessionViewed(sessionId: string): void {
    if (!this.pendingCompletions.delete(sessionId)) return;
    this.closeNotification(this.completionNotificationId(sessionId));
    console.log(
      `[DesktopNotification] cleared completed session notification for ${sessionId}; pending count ${this.pendingCompletions.size}`,
    );
    this.updateAttentionState();
  }

  handleSessionDeleted(sessionId: string): void {
    this.closeWaitingNotificationsForSession(sessionId, 'session deleted');
    if (!this.pendingCompletions.delete(sessionId)) return;
    this.closeNotification(this.completionNotificationId(sessionId));
    console.log(
      `[DesktopNotification] removed completed session notification for deleted session ${sessionId}; pending count ${this.pendingCompletions.size}`,
    );
    this.updateAttentionState();
  }

  handleSessionStopped(sessionId: string): void {
    this.closeWaitingNotificationsForSession(sessionId, 'session stopped');
  }

  clearAllCompletions(reason: string): void {
    if (this.pendingCompletions.size === 0 && !this.hasActiveNotificationOfKind('completion')) return;
    const count = this.pendingCompletions.size;
    this.pendingCompletions.clear();
    this.closeNotificationsByKind('completion');
    console.log(`[DesktopNotification] cleared ${count} completed session notifications after ${reason}`);
    this.updateAttentionState();
  }

  closeWaitingNotifications(kind: WaitingNotificationKind, reason: string): void {
    let closed = 0;
    for (const record of [...this.waitingNotifications.values()]) {
      if (record.kind !== kind) continue;
      this.removeWaitingNotification(record);
      closed += 1;
    }
    if (closed > 0) {
      console.log(`[DesktopNotification] closed ${closed} ${kind} notifications after ${reason}`);
    }
  }

  private closeWaitingNotificationsForSession(sessionId: string, reason: string): void {
    let closed = 0;
    for (const record of [...this.waitingNotifications.values()]) {
      if (record.sessionId !== sessionId) continue;
      this.removeWaitingNotification(record);
      closed += 1;
    }
    if (closed > 0) {
      console.log(`[DesktopNotification] closed ${closed} waiting notifications for session ${sessionId} after ${reason}`);
    }
  }

  private removeWaitingNotification(record: WaitingNotificationRecord): void {
    this.waitingNotifications.delete(record.requestId);
    this.closeNotification(this.waitingNotificationId(record));
  }

  private rememberResolvedRequest(requestId: string): void {
    this.resolvedRequestIds.add(requestId);
    while (this.resolvedRequestIds.size > MAX_RESOLVED_REQUEST_ID_REFERENCES) {
      const oldest = this.resolvedRequestIds.values().next().value;
      if (oldest === undefined) return;
      this.resolvedRequestIds.delete(oldest);
    }
  }

  private isWindowForeground(win: BrowserWindow | null): boolean {
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
  }

  private isViewingSession(sessionId: string): boolean {
    if (!this.isWindowForeground(this.options.getWindow())) return false;
    if (sessionId === SESSION_AGNOSTIC_PERMISSION_SESSION_ID) {
      // Session-agnostic requests surface in whichever session is open, so
      // any active session means the request is visible to the user.
      return this.activeSessionId !== null;
    }
    return this.activeSessionId === sessionId;
  }

  private completionNotificationId(sessionId: string): string {
    return `complete-${sessionId}`;
  }

  private waitingNotificationId(record: WaitingNotificationRecord): string {
    return `permission-${record.sessionId}-${record.requestId}`;
  }

  private resolveSessionTitle(sessionId: string): string | null {
    if (sessionId === SESSION_AGNOSTIC_PERMISSION_SESSION_ID) return null;
    try {
      const title = this.options.getSessionTitle(sessionId);
      const trimmed = title?.trim();
      return trimmed ? trimmed : null;
    } catch (error) {
      console.warn(`[DesktopNotification] failed to resolve title for session ${sessionId}:`, error);
      return null;
    }
  }

  private showCompletionNotification(sessionId: string): void {
    this.showSystemNotification({
      notificationId: this.completionNotificationId(sessionId),
      kind: 'completion',
      title: this.resolveSessionTitle(sessionId) ?? t('taskCompletionNotificationTitle'),
      body: t('taskCompletionNotificationBody'),
      onClick: () => {
        console.log(`[DesktopNotification] system notification clicked for session ${sessionId}`);
        this.openPendingSession(sessionId);
      },
    });
  }

  private showWaitingNotification(
    sessionId: string,
    requestId: string,
    kind: WaitingNotificationKind,
    toolName: string,
  ): void {
    const isQuestion = kind === WaitingNotificationKind.Question;
    const fallbackTitle = isQuestion ? t('questionNotificationTitle') : t('permissionNotificationTitle');
    const trimmedToolName = toolName.trim();
    const body = isQuestion
      ? t('questionNotificationBody')
      : trimmedToolName
        ? t('permissionNotificationBody', { toolName: trimmedToolName })
        : t('permissionNotificationBodyGeneric');
    const shown = this.showSystemNotification({
      notificationId: this.waitingNotificationId({ sessionId, requestId, kind }),
      kind,
      title: this.resolveSessionTitle(sessionId) ?? fallbackTitle,
      body,
      // Keep waiting notifications on screen until they are acted on where
      // the platform supports it (macOS/Linux). Windows toasts move to the
      // Action Center on their own.
      persistent: process.platform !== 'win32',
      onClick: () => {
        console.log(`[DesktopNotification] ${kind} notification clicked for session ${sessionId}, request ${requestId}`);
        this.waitingNotifications.delete(requestId);
        if (sessionId === SESSION_AGNOSTIC_PERMISSION_SESSION_ID) {
          this.options.focusMainWindow('waiting notification');
          return;
        }
        this.openPendingSession(sessionId);
      },
    });
    if (!shown) {
      this.waitingNotifications.delete(requestId);
      return;
    }
    console.log(`[DesktopNotification] showed ${kind} notification for session ${sessionId}, request ${requestId}`);
  }

  private showSystemNotification(params: {
    notificationId: string;
    kind: 'completion' | WaitingNotificationKind;
    title: string;
    body: string;
    persistent?: boolean;
    onClick: () => void;
  }): boolean {
    if (!Notification.isSupported()) {
      console.warn('[DesktopNotification] system notifications are not supported on this platform');
      return false;
    }

    try {
      this.closeNotification(params.notificationId);
      const notification = new Notification({
        title: params.title,
        body: params.body,
        icon: this.getNotificationIcon(),
        ...(params.persistent ? { timeoutType: 'never' as const } : {}),
      });
      notification.on('click', () => {
        this.activeNotifications.delete(params.notificationId);
        params.onClick();
      });
      this.activeNotifications.set(params.notificationId, {
        notification,
        kind: params.kind,
      });
      this.pruneActiveNotificationReferences();
      notification.show();
      return true;
    } catch (error) {
      console.warn(`[DesktopNotification] failed to show system notification ${params.notificationId}:`, error);
      return false;
    }
  }

  private updateAttentionState(): void {
    const count = this.pendingCompletions.size;
    const hasReminder = count > 0;
    this.updateDockBadge(count);
    this.updateWindowsAttention(count);
    this.options.updateTrayReminder(
      count,
      hasReminder ? () => this.openPendingSession(this.getMostRecentPendingSessionId()) : undefined,
    );
  }

  private updateDockBadge(count: number): void {
    if (process.platform !== 'darwin' || !app.dock) return;
    try {
      app.dock.setBadge(count > 0 ? String(count) : '');
    } catch (error) {
      console.warn('[DesktopNotification] failed to update Dock badge:', error);
    }
  }

  private updateWindowsAttention(count: number): void {
    if (process.platform !== 'win32') return;
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return;
    const hasReminder = count > 0;
    try {
      win.setOverlayIcon(
        hasReminder ? this.getWindowsOverlayIcon(count) : null,
        hasReminder ? t('taskCompletionOverlayDescription') : '',
      );
      win.flashFrame(hasReminder);
    } catch (error) {
      console.warn('[DesktopNotification] failed to update Windows taskbar attention state:', error);
    }
  }

  private getNotificationIcon(): Electron.NativeImage | undefined {
    const iconPath = this.options.getNotificationIconPath();
    if (!iconPath) return undefined;
    const image = nativeImage.createFromPath(iconPath);
    return image.isEmpty() ? undefined : image;
  }

  private closeNotification(notificationId: string): void {
    const entry = this.activeNotifications.get(notificationId);
    if (!entry) return;
    this.activeNotifications.delete(notificationId);
    try {
      entry.notification.close();
    } catch (error) {
      console.warn(`[DesktopNotification] failed to close system notification ${notificationId}:`, error);
    }
  }

  private closeNotificationsByKind(kind: 'completion' | WaitingNotificationKind): void {
    for (const [notificationId, entry] of [...this.activeNotifications.entries()]) {
      if (entry.kind !== kind) continue;
      this.closeNotification(notificationId);
    }
  }

  private hasActiveNotificationOfKind(kind: 'completion' | WaitingNotificationKind): boolean {
    for (const entry of this.activeNotifications.values()) {
      if (entry.kind === kind) return true;
    }
    return false;
  }

  private pruneActiveNotificationReferences(): void {
    while (this.activeNotifications.size > MAX_ACTIVE_NOTIFICATION_REFERENCES) {
      const oldestNotificationId = this.activeNotifications.keys().next().value;
      if (!oldestNotificationId) return;
      const oldest = this.activeNotifications.get(oldestNotificationId);
      this.closeNotification(oldestNotificationId);
      if (oldest && oldest.kind !== 'completion') {
        for (const record of [...this.waitingNotifications.values()]) {
          if (this.waitingNotificationId(record) === oldestNotificationId) {
            this.waitingNotifications.delete(record.requestId);
          }
        }
      }
      console.warn(
        `[DesktopNotification] closed the oldest system notification because more than ${MAX_ACTIVE_NOTIFICATION_REFERENCES} notifications were active`,
      );
    }
  }

  private getWindowsOverlayIcon(count: number): Electron.NativeImage {
    const label = this.formatBadgeCount(count);
    const cachedIcon = this.windowsOverlayIcons.get(label);
    if (cachedIcon && !cachedIcon.isEmpty()) return cachedIcon;

    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
      `<circle cx="16" cy="16" r="15" fill="${APP_ATTENTION_BADGE_COLOR}"/>`,
      `<text x="16" y="21" text-anchor="middle" fill="#ffffff" font-size="${label.length > 2 ? 12 : 18}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-weight="600">${label}</text>`,
      '</svg>',
    ].join('');
    const icon = nativeImage.createFromDataURL(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );
    this.windowsOverlayIcons.set(label, icon);
    return icon;
  }

  private formatBadgeCount(count: number): string {
    return count > 99 ? '99+' : String(count);
  }

  private getMostRecentPendingSessionId(): string {
    let latest: PendingCompletionNotification | null = null;
    for (const notification of this.pendingCompletions.values()) {
      if (!latest || notification.completedAt > latest.completedAt) {
        latest = notification;
      }
    }
    return latest?.sessionId ?? '';
  }

  private openPendingSession(sessionId: string): void {
    if (!sessionId) return;
    this.options.focusMainWindow('desktop notification');
    this.options.openSession(sessionId);
  }
}
