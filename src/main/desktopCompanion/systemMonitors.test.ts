import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ systemPreferences: {} }));
vi.mock('./windowsNative', () => ({ loadWindowsNative: () => null }));

const { parseFileDragLine } = await import('./fileDragMonitor');
const { parseRunningApplication } = await import('./foregroundAppMonitor');

describe('foreground app notifications', () => {
  test('reads the bundle id out of the NSRunningApplication description', () => {
    expect(parseRunningApplication({
      NSWorkspaceApplicationKey: '<NSRunningApplication: 0x11400f0c720 (com.apple.finder - 629) LSASN:{hi=0x0;lo=0xf00f}>',
    })).toBe('com.apple.finder');
  });

  test('ignores payloads it cannot read', () => {
    expect(parseRunningApplication({})).toBeNull();
    expect(parseRunningApplication(null)).toBeNull();
    expect(parseRunningApplication({ NSWorkspaceApplicationKey: '<NSRunningApplication: 0x1>' })).toBeNull();
  });
});

describe('drag sidecar output', () => {
  test('reads marked lines and their paths', () => {
    expect(parseFileDragLine('@@LOBSTER_DRAG {"type":"drag-start","paths":["/tmp/a.docx",3]}')).toEqual({
      type: 'drag-start',
      paths: ['/tmp/a.docx'],
    });
    expect(parseFileDragLine('2026-10-06 osascript[123] @@LOBSTER_DRAG {"type":"drag-end"}')).toEqual({ type: 'drag-end', paths: undefined });
  });

  test('ignores unrelated or broken lines', () => {
    expect(parseFileDragLine('osascript: some warning')).toBeNull();
    expect(parseFileDragLine('@@LOBSTER_DRAG {broken')).toBeNull();
    expect(parseFileDragLine('@@LOBSTER_DRAG {"paths":[]}')).toBeNull();
  });
});
