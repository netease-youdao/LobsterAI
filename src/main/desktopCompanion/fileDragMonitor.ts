import { type ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

import { CompanionCapability } from '../../shared/desktopCompanion/constants';
import { loadWindowsNative } from './windowsNative';

const MARKER = '@@LOBSTER_DRAG ';
const WINDOWS_IDLE_POLL_MS = 140;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

export const FileDragEvent = { Start: 'drag-start', End: 'drag-end' } as const;

export interface FileDragStart {
  /** Absolute paths when the platform exposes them before the drop (macOS). */
  paths: string[];
}

/**
 * macOS: a JXA sidecar polls the drag pasteboard. A new drag session bumps its
 * change count while the left button is held, and file drags carry
 * NSFilenamesPboardType (or public.file-url items). Running out of process
 * keeps AppKit polling away from the Electron main thread and needs no native
 * module or permission. It exits on its own if LobsterAI goes away.
 */
export function macDragScript(parentPid: number): string {
  return `
ObjC.import('AppKit');
ObjC.import('stdlib');
var parentPid = ${Math.trunc(parentPid)};
var pb = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);
var last = Number(pb.changeCount);
var emitted = false;
var ticks = 0;
function out(value) { console.log('${MARKER}' + JSON.stringify(value)); }
out({ type: 'ready' });
while (true) {
  if (++ticks % 8 === 0) {
    // JXA wraps nil in a truthy object, so test it with isNil().
    var parent = $.NSRunningApplication.runningApplicationWithProcessIdentifier(parentPid);
    if (parent.isNil() || parent.terminated) $.exit(0);
  }
  var pressed = (Number($.NSEvent.pressedMouseButtons) & 1) === 1;
  if (pressed) {
    var count = Number(pb.changeCount);
    if (!emitted && count !== last) {
      last = count;
      var files = [];
      var list = pb.propertyListForType('NSFilenamesPboardType');
      if (!list.isNil() && Number(list.count) > 0) {
        for (var i = 0; i < Math.min(Number(list.count), 20); i++) files.push(ObjC.unwrap(list.objectAtIndex(i)));
      }
      if (!files.length) {
        var items = pb.pasteboardItems;
        for (var j = 0; !items.isNil() && j < Math.min(Number(items.count), 20); j++) {
          var url = items.objectAtIndex(j).stringForType('public.file-url');
          if (url.isNil()) continue;
          var fileUrl = $.NSURL.URLWithString(url);
          if (!fileUrl.isNil() && fileUrl.isFileURL) files.push(ObjC.unwrap(fileUrl.path));
        }
      }
      if (files.length) { emitted = true; out({ type: '${FileDragEvent.Start}', paths: files }); }
    }
  } else {
    if (emitted) out({ type: '${FileDragEvent.End}' });
    emitted = false;
    last = Number(pb.changeCount);
  }
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(pressed ? 0.08 : 0.3));
}
`;
}

export function parseFileDragLine(line: string): { type: string; paths?: string[] } | null {
  const index = line.indexOf(MARKER);
  if (index < 0) return null;
  try {
    const value = JSON.parse(line.slice(index + MARKER.length)) as { type?: unknown; paths?: unknown };
    if (typeof value.type !== 'string') return null;
    const paths = Array.isArray(value.paths) ? value.paths.filter((item): item is string => typeof item === 'string') : undefined;
    return { type: value.type, paths };
  } catch {
    return null;
  }
}

export interface FileDragMonitor extends EventEmitter {
  readonly capability: CompanionCapability;
  start(): void;
  stop(): void;
}

/** Emits `drag-start` when the user starts dragging files anywhere, and `drag-end` on release. */
export class CompanionFileDragMonitor extends EventEmitter implements FileDragMonitor {
  readonly capability: CompanionCapability;
  private child: ChildProcess | null = null;
  private wanted = false;
  private restarts: number[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private dragging = false;

  constructor() {
    super();
    if (process.platform === 'darwin') this.capability = CompanionCapability.Ready;
    else if (process.platform === 'win32') this.capability = loadWindowsNative() ? CompanionCapability.Ready : CompanionCapability.Unsupported;
    else this.capability = CompanionCapability.Unsupported;
  }

  start(): void {
    if (this.capability !== CompanionCapability.Ready || this.wanted) return;
    this.wanted = true;
    if (process.platform === 'darwin') this.spawnSidecar();
    else this.pollWindows();
  }

  stop(): void {
    this.wanted = false;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.child) {
      this.child.removeAllListeners();
      this.child.kill();
      this.child = null;
    }
    if (this.dragging) {
      this.dragging = false;
      this.emit(FileDragEvent.End);
    }
  }

  private spawnSidecar(): void {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macDragScript(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let buffer = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    });
    child.on('error', error => console.warn('[DesktopCompanion] Drag sidecar failed to start:', error));
    child.on('exit', code => {
      if (this.child !== child) return;
      this.child = null;
      if (this.dragging) { this.dragging = false; this.emit(FileDragEvent.End); }
      if (!this.wanted) return;
      const now = Date.now();
      this.restarts = this.restarts.filter(at => now - at < RESTART_WINDOW_MS);
      if (this.restarts.length >= MAX_RESTARTS) {
        console.warn(`[DesktopCompanion] Drag sidecar exited (${code}); giving up until the feature is toggled.`);
        return;
      }
      this.restarts.push(now);
      setTimeout(() => { if (this.wanted && !this.child) this.spawnSidecar(); }, 1_000);
    });
  }

  private handleLine(line: string): void {
    const event = parseFileDragLine(line);
    if (!event) return;
    if (event.type === FileDragEvent.Start) {
      this.dragging = true;
      this.emit(FileDragEvent.Start, { paths: event.paths ?? [] } satisfies FileDragStart);
    } else if (event.type === FileDragEvent.End && this.dragging) {
      this.dragging = false;
      this.emit(FileDragEvent.End);
    }
  }

  private pollWindows(): void {
    const native = loadWindowsNative();
    if (!native || !this.wanted) return;
    try {
      const down = native.isLeftButtonDown();
      if (down && !this.dragging && native.isShellDragVisible()) {
        this.dragging = true;
        // Explorer does not expose the dragged paths before the drop; the
        // stage refines its targets from the drag's MIME types on hover.
        this.emit(FileDragEvent.Start, { paths: [] } satisfies FileDragStart);
      } else if (!down && this.dragging) {
        this.dragging = false;
        this.emit(FileDragEvent.End);
      }
    } catch (error) {
      console.warn('[DesktopCompanion] Drag poll failed:', error);
    }
    this.pollTimer = setTimeout(() => this.pollWindows(), WINDOWS_IDLE_POLL_MS);
  }
}
