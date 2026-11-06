import { describe, expect, test, vi } from 'vitest';

import { SettingsRuntime, SettingsWriterCoordinator } from '../../../openclaw-extensions/lobster-agent-settings/coordinator';

const own = { agentId: 'main', sessionKey: 'agent:main:lobsterai:s', runId: 'run', toolCallId: 'settings' };
describe('settings runtime coordination', () => {
  test('holds automatic memory writer lock and excludes only the initiating settings tool', async () => {
    const coordinator = new SettingsWriterCoordinator();
    coordinator.bindRun(own);
    coordinator.enter(own, SettingsRuntime.Tool);
    const other = { ...own, runId: 'other', toolCallId: 'write' };
    expect(coordinator.enter(other, 'write')).toBe(true);
    await expect(coordinator.acquire('main', '/workspace', async (_path, fn) => fn(), own)).rejects.toThrow('AGENT_BUSY');
    coordinator.exit(other);
    let held = false;
    const lease = await coordinator.acquire('main', '/workspace', async (_path, fn) => { held = true; try { return await fn(); } finally { held = false; } }, own);
    expect(held).toBe(true);
    expect(coordinator.enter(other, 'write')).toBe(false);
    expect(coordinator.release('main', 'wrong')).toBe(false);
    expect(coordinator.release('main', lease.token)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(held).toBe(false);
    expect(coordinator.enter(other, 'write')).toBe(true);
  });
  test('blocks a protected run from falling back to shell, even after settings failure', () => {
    const coordinator = new SettingsWriterCoordinator();
    coordinator.bindRun(own);
    coordinator.enter(own, SettingsRuntime.Tool);
    coordinator.exit(own);
    expect(coordinator.enter({ ...own, toolCallId: 'fallback' }, 'exec')).toBe(false);
    coordinator.end(own);
    expect(coordinator.enter({ ...own, runId: 'new', toolCallId: 'normal' }, 'exec')).toBe(true);
  });
  test('does not grant another call the initiating tool exemption', async () => {
    const coordinator = new SettingsWriterCoordinator();
    coordinator.bindRun(own);
    coordinator.enter(own, SettingsRuntime.Tool);
    await expect(coordinator.acquire('main', '/workspace', async (_path, fn) => fn(), { ...own, toolCallId: 'forged' })).rejects.toThrow('CONVERSATION_SOURCE_INVALID');
  });
  test('abandons a timed-out memory lock wait and rejects a late callback', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new SettingsWriterCoordinator();
      let enter: (() => Promise<unknown>) | undefined;
      const pending = coordinator.acquire('main', '/workspace', async (_path, fn) => {
        return await new Promise((resolve, reject) => { enter = () => fn().then(resolve, reject); });
      });
      const rejected = expect(pending).rejects.toThrow('SETTINGS_WRITE_COORDINATION_REQUIRED');
      await vi.advanceTimersByTimeAsync(10_000); await rejected;
      coordinator.bindRun(own);
      expect(coordinator.enter(own, SettingsRuntime.Tool)).toBe(true);
      await enter?.();
      const lease = await coordinator.acquire('main', '/workspace', async (_path, fn) => fn(), own);
      expect(coordinator.release('main', lease.token)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  test('an unregistered local settings call cannot poison normal local tools', () => {
    const coordinator = new SettingsWriterCoordinator();
    expect(coordinator.enter(own, SettingsRuntime.Tool)).toBe(false);
    expect(coordinator.enter({ ...own, toolCallId: 'local-exec' }, 'exec')).toBe(true);
    expect(coordinator.hasRun(own)).toBe(false);
  });
  test('registrations are exact, bounded and released by agent_end', () => {
    const coordinator = new SettingsWriterCoordinator();
    for (let index = 0; index < 512; index++) coordinator.bindRun({ ...own, runId: `run-${index}` });
    coordinator.bindRun({ ...own, runId: 'run-0' });
    expect(() => coordinator.bindRun({ ...own, runId: 'overflow' })).toThrow('SETTINGS_RATE_LIMITED');
    expect(coordinator.hasRun({ ...own, runId: 'run-0' })).toBe(true);
    expect(coordinator.hasRun({ ...own, runId: 'other' })).toBe(false);
    coordinator.end({ ...own, runId: 'run-0' });
    expect(coordinator.hasRun({ ...own, runId: 'run-0' })).toBe(false);
    expect(() => coordinator.bindRun({ ...own, runId: 'replacement' })).not.toThrow();
    expect(() => coordinator.bindRun({ ...own, sessionKey: 'agent:another:lobsterai:s' })).toThrow('CONVERSATION_SOURCE_INVALID');
  });

});
