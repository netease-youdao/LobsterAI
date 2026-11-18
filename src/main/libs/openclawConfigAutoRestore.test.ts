import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createOpenClawConfigAutoRestoreHandler,
  OPENCLAW_CONFIG_AUTO_RESTORE_SYNC_REASON,
  OpenClawConfigRestoreSource,
  parseOpenClawConfigAutoRestore,
} from './openclawConfigAutoRestore';

afterEach(() => { vi.restoreAllMocks(); });

describe('parseOpenClawConfigAutoRestore', () => {
  test('reads the size-drop restore line, including paths with spaces', () => {
    const chunk = 'starting…\nConfig auto-restored from backup: /Users/u/Library/Application Support/LobsterAI/openclaw/state/openclaw.json (size-drop-vs-last-good:33753->13837)\n';
    expect(parseOpenClawConfigAutoRestore(chunk)).toEqual({
      source: OpenClawConfigRestoreSource.Backup,
      reasons: 'size-drop-vs-last-good:33753->13837',
    });
  });

  test('reads last-known-good restores with trailing validation details', () => {
    const line = 'Config auto-restored from last-known-good: C:\\Users\\u (1)\\openclaw.json (invalid-config); Rejected validation details: models (expected object).';
    expect(parseOpenClawConfigAutoRestore(line)).toEqual({
      source: OpenClawConfigRestoreSource.LastKnownGood,
      reasons: 'invalid-config',
    });
  });

  test('ignores failed restores and unrelated output', () => {
    expect(parseOpenClawConfigAutoRestore('Config auto-restore from backup failed: /x/openclaw.json (size-drop-vs-last-good:1->0)')).toBeNull();
    expect(parseOpenClawConfigAutoRestore('[gateway] ready')).toBeNull();
  });
});

describe('createOpenClawConfigAutoRestoreHandler', () => {
  const restore = (reasons: string, gatewayGeneration = 1) => ({
    source: OpenClawConfigRestoreSource.Backup, reasons, gatewayGeneration,
  });

  test('resyncs once per distinct restore and never loops on a repeat', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resync = vi.fn();
    const handle = createOpenClawConfigAutoRestoreHandler({ isShuttingDown: () => false, resync });

    handle(restore('size-drop-vs-last-good:33753->13837'));
    handle(restore('size-drop-vs-last-good:33753->13837', 2));
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledWith(OPENCLAW_CONFIG_AUTO_RESTORE_SYNC_REASON);
    expect(error).toHaveBeenCalledTimes(1);

    handle(restore('size-drop-vs-last-good:40000->12000', 3));
    expect(resync).toHaveBeenCalledTimes(2);
  });

  test('caps resyncs per session and skips them while shutting down', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const resync = vi.fn();
    let shuttingDown = true;
    const handle = createOpenClawConfigAutoRestoreHandler({ isShuttingDown: () => shuttingDown, resync });

    handle(restore('size-drop-vs-last-good:1000->10'));
    expect(resync).not.toHaveBeenCalled();

    shuttingDown = false;
    for (let index = 0; index < 5; index += 1) handle(restore(`size-drop-vs-last-good:${1000 + index}->10`));
    expect(resync).toHaveBeenCalledTimes(3);
  });
});
