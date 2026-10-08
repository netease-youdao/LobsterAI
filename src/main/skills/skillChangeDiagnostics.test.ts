import { afterEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

import { SkillChangeSource, SkillWatchDiagnostics, SkillWatchScope } from './skillChangeDiagnostics';
import { SkillManager } from './skillManager';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('watch diagnostics coalesce fixed counters without retaining paths', () => {
  const diagnostics = new SkillWatchDiagnostics();
  diagnostics.record(SkillWatchScope.Root, 'rename');
  diagnostics.record(SkillWatchScope.Definition, 'change');
  const batch = diagnostics.take();
  expect(batch).toMatchObject({ source: SkillChangeSource.Watcher, eventCount: 2, rootEvents: 1, definitionEvents: 1, renameEvents: 1 });
  expect(diagnostics.take().eventCount).toBe(0);
});

test('watcher debounce still sends one notification and explicit changes keep their source', async () => {
  vi.useFakeTimers();
  const manager = new SkillManager(() => ({} as never)) as any;
  manager.startWatching = vi.fn(() => manager.stopWatching());
  const listener = vi.fn();
  manager.onSkillsChanged(listener);
  manager.scheduleNotify(SkillWatchScope.Root, 'rename');
  manager.scheduleNotify(SkillWatchScope.Definition, 'change');
  expect(listener).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener.mock.calls[0][0]).toMatchObject({ source: SkillChangeSource.Watcher, eventCount: 2 });
  manager.handleWorkingDirectoryChange();
  expect(listener.mock.calls[1][0]).toMatchObject({ source: SkillChangeSource.WorkingDirectory, eventCount: 1 });
  expect(listener.mock.calls[1][0].batchId).toBeGreaterThan(listener.mock.calls[0][0].batchId);
  manager.scheduleNotify(SkillWatchScope.Root, 'rename');
  manager.stopWatching();
  await vi.runAllTimersAsync();
  expect(listener).toHaveBeenCalledTimes(2);
});
