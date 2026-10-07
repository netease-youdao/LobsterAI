import { randomUUID } from 'crypto';
import { type BrowserWindow, type Rectangle, screen } from 'electron';

import {
  type DesktopCompanionAttachment,
  type DesktopCompanionDropFile,
  type DesktopCompanionDropSource,
  DesktopCompanionSize,
  type DesktopCompanionStage,
  type DesktopCompanionStageCommand,
  DesktopCompanionStageCommandType,
  DesktopCompanionStageKind,
  DesktopCompanionSurface,
  DesktopCompanionTiming,
} from '../../shared/desktopCompanion/constants';
import type { CompanionFileKind } from '../../shared/desktopCompanion/fileKinds';
import { type CompanionSize, resolveCompanionStageBounds } from '../../shared/desktopCompanion/geometry';
import { type CompanionHintOutcome, CompanionHintOutcome as Outcome, type CompanionHintTopic } from '../../shared/desktopCompanion/hintPolicy';

const NONE: DesktopCompanionStage = { kind: DesktopCompanionStageKind.None };
const SHOW_FALLBACK_MS = 150;
const MAX_ATTACHMENTS = 20;

export interface StageHost {
  /** The orb's fully revealed bounds, or null when it is not on screen. */
  getOrbBounds(): Rectangle | null;
  createWindow(surface: typeof DesktopCompanionSurface.Stage, focusable: boolean): BrowserWindow;
  publish(): void;
  onStageChanged(): void;
}

export interface StageHandlers {
  onHintOutcome(topic: CompanionHintTopic, outcome: CompanionHintOutcome): void;
  onHintAccept(topic: CompanionHintTopic): void;
  onDropAsk(attachments: DesktopCompanionAttachment[]): void;
  onDropStarted(sessionId: string): void;
}

export function normalizeStageAttachments(value: unknown): DesktopCompanionAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((file): file is DesktopCompanionAttachment => !!file
    && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 4096
    && typeof file.name === 'string')
    .slice(0, MAX_ATTACHMENTS)
    .map(file => ({ path: file.path, name: file.name.slice(0, 255), isImage: file.isImage === true, isDirectory: file.isDirectory === true }));
}

/**
 * The "stage" is a small window that comes out of the orb: a hint bubble or the
 * drop zone for files. Only one of them is ever shown.
 */
export class CompanionStageController {
  private window: BrowserWindow | null = null;
  private current: DesktopCompanionStage = NONE;
  private size: CompanionSize = { ...DesktopCompanionSize.Hint };
  private hovering = false;
  private dragInFlight = false;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingShow = false;

  constructor(private readonly host: StageHost, private readonly handlers: StageHandlers) {}

  get stage(): DesktopCompanionStage {
    return this.current;
  }

  get webContentsId(): number | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents.id : null;
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  showHint(topic: CompanionHintTopic, variant: number): boolean {
    if (this.current.kind !== DesktopCompanionStageKind.None) return false;
    this.current = { kind: DesktopCompanionStageKind.Hint, id: randomUUID(), topic, variant };
    this.size = { ...DesktopCompanionSize.Hint };
    this.present();
    return true;
  }

  showDrop(source: DesktopCompanionDropSource, files: DesktopCompanionDropFile[], hintedKinds: CompanionFileKind[] = []): void {
    clearTimeout(this.lingerTimer);
    this.dragInFlight = true;
    const kinds = [...new Set([...files.map(file => file.kind), ...hintedKinds])];
    if (this.current.kind === DesktopCompanionStageKind.Drop) {
      if (files.length) this.current = { ...this.current, files, kinds };
      this.host.publish();
      return;
    }
    // A drop replaces a hint: the user is in the middle of doing something.
    this.current = { kind: DesktopCompanionStageKind.Drop, id: randomUUID(), source, files, kinds };
    this.size = { ...DesktopCompanionSize.Drop };
    this.present();
  }

  /** The drag ended elsewhere; linger briefly so a drop already in flight can still land. */
  releaseDrop(source?: DesktopCompanionDropSource): void {
    if (this.current.kind !== DesktopCompanionStageKind.Drop) return;
    if (source && this.current.source !== source && this.dragInFlight) return;
    this.dragInFlight = false;
    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      if (!this.hovering && this.current.kind === DesktopCompanionStageKind.Drop) this.clear();
    }, DesktopCompanionTiming.DropLingerMs);
  }

  clear(): void {
    clearTimeout(this.lingerTimer);
    clearTimeout(this.showTimer);
    this.pendingShow = false;
    this.hovering = false;
    this.dragInFlight = false;
    if (this.current.kind === DesktopCompanionStageKind.None) return;
    this.current = NONE;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    this.host.publish();
    this.host.onStageChanged();
  }

  reposition(): void {
    if (!this.window || this.window.isDestroyed() || this.current.kind === DesktopCompanionStageKind.None) return;
    const orb = this.host.getOrbBounds();
    if (!orb) { this.clear(); return; }
    this.window.setBounds(resolveCompanionStageBounds(orb, this.size, screen.getDisplayMatching(orb).workArea));
  }

  setContentSize(size: CompanionSize): void {
    if (this.current.kind === DesktopCompanionStageKind.None) return;
    const max = this.current.kind === DesktopCompanionStageKind.Drop ? DesktopCompanionSize.Drop : DesktopCompanionSize.Hint;
    this.size = {
      width: Math.max(160, Math.min(Math.ceil(size.width), max.width)),
      height: Math.max(60, Math.min(Math.ceil(size.height), max.height)),
    };
    this.reposition();
    if (this.pendingShow) this.reveal();
  }

  handleCommand(command: DesktopCompanionStageCommand): void {
    const current = this.current;
    switch (command?.type) {
      case DesktopCompanionStageCommandType.HintAccept:
      case DesktopCompanionStageCommandType.HintDismiss:
      case DesktopCompanionStageCommandType.HintMute:
      case DesktopCompanionStageCommandType.HintTimeout: {
        if (current.kind !== DesktopCompanionStageKind.Hint) return;
        if (command.type === DesktopCompanionStageCommandType.HintTimeout && this.hovering) return;
        const outcome = {
          [DesktopCompanionStageCommandType.HintAccept]: Outcome.Accepted,
          [DesktopCompanionStageCommandType.HintDismiss]: Outcome.Dismissed,
          [DesktopCompanionStageCommandType.HintMute]: Outcome.Muted,
          [DesktopCompanionStageCommandType.HintTimeout]: Outcome.Ignored,
        }[command.type];
        this.handlers.onHintOutcome(current.topic, outcome);
        this.clear();
        if (command.type === DesktopCompanionStageCommandType.HintAccept) this.handlers.onHintAccept(current.topic);
        return;
      }
      case DesktopCompanionStageCommandType.StageHover:
        this.hovering = command.hovering === true;
        if (!this.hovering && !this.dragInFlight && current.kind === DesktopCompanionStageKind.Drop) this.releaseDrop();
        return;
      case DesktopCompanionStageCommandType.DropAsk: {
        const attachments = normalizeStageAttachments(command.attachments);
        this.clear();
        this.handlers.onDropAsk(attachments);
        return;
      }
      case DesktopCompanionStageCommandType.DropStarted:
        this.clear();
        if (typeof command.sessionId === 'string' && command.sessionId) this.handlers.onDropStarted(command.sessionId.slice(0, 200));
        return;
      case DesktopCompanionStageCommandType.DropCancel:
        this.clear();
        return;
      default:
    }
  }

  dispose(): void {
    clearTimeout(this.lingerTimer);
    clearTimeout(this.showTimer);
    this.window?.destroy();
    this.window = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = this.host.createWindow(DesktopCompanionSurface.Stage, false);
    win.on('closed', () => { if (this.window === win) this.window = null; });
    this.window = win;
    return win;
  }

  private present(): void {
    this.ensureWindow();
    this.reposition();
    this.host.publish();
    this.host.onStageChanged();
    this.pendingShow = true;
    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => this.reveal(), SHOW_FALLBACK_MS);
  }

  private reveal(): void {
    clearTimeout(this.showTimer);
    if (!this.pendingShow || this.current.kind === DesktopCompanionStageKind.None) return;
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isLoadingMainFrame()) {
      // First use: the window shows itself once it has loaded and measured.
      return;
    }
    this.pendingShow = false;
    this.window.showInactive();
  }
}
