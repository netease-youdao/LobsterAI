import { afterEach, expect, test, vi } from 'vitest';

import { buildOpenClawLocalTimeContextPrompt } from '../openclawLocalTimeContextPrompt';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([true, false])('samples fresh local time after slow startup and preparation (bridged=%s)', async (bridged) => {
  const start = new Date('2026-10-27T01:00:00Z');
  const ready = new Date('2026-10-27T01:10:00Z');
  const afterRehydration = new Date('2026-10-27T01:12:00Z');
  const afterHistory = new Date('2026-10-27T01:13:00Z');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ready);
  const adapter = new OpenClawRuntimeAdapter({
    getSession: () => null,
    getAgent: () => null,
  } as never, {} as never);
  const internal = adapter as unknown as {
    bridgedSessions: Set<string>;
    buildWorkspaceRehydrationBridge: (id: string) => Promise<string>;
    requireGatewayClient: () => { request: () => Promise<{ messages: unknown[] }> };
    buildOutboundPrompt: (
      id: string, prompt: string, system?: string, agent?: string,
      media?: undefined, selection?: undefined, annotations?: undefined,
      timing?: { turnStartedAtMs: number },
    ) => Promise<string>;
  };
  if (bridged) internal.bridgedSessions.add('session-1');
  vi.spyOn(internal, 'buildWorkspaceRehydrationBridge').mockImplementation(async () => {
    await Promise.resolve();
    vi.setSystemTime(afterRehydration);
    return '';
  });
  vi.spyOn(internal, 'requireGatewayClient').mockReturnValue({
    request: async () => {
      await Promise.resolve();
      vi.setSystemTime(afterHistory);
      return { messages: [] };
    },
  });

  const prompt = await internal.buildOutboundPrompt(
    'session-1', 'remind me in one minute', undefined, undefined, undefined, undefined, undefined,
    { turnStartedAtMs: start.getTime() },
  );
  const sampled = bridged ? afterRehydration : afterHistory;
  expect(prompt.endsWith(buildOpenClawLocalTimeContextPrompt(sampled))).toBe(true);
  expect(prompt).not.toContain(String(start.getTime()));
  expect(prompt.indexOf('Local time: ')).toBeGreaterThan(prompt.indexOf('[Current user request]'));
  // Once assembled, the exact turn is reused. Clock advancement cannot rewrite it.
  vi.setSystemTime(new Date('2026-10-27T01:20:00Z'));
  expect(prompt.endsWith(buildOpenClawLocalTimeContextPrompt(sampled))).toBe(true);
});
