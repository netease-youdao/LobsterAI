import { afterEach, expect, test, vi } from 'vitest';

import { NeteaseMailRuntimeRpc } from '../../shared/neteaseMail/constants';
import { reloadNeteaseMailCredentials } from './neteaseMailRuntime';

afterEach(() => vi.restoreAllMocks());

test('waits for the running gateway to acknowledge credential reload', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let acknowledge!: (result: { ok: boolean; warningCount: number }) => void;
  const request = vi.fn(() => new Promise<{ ok: boolean; warningCount: number }>(resolve => { acknowledge = resolve; }));
  const reload = reloadNeteaseMailCredentials(async () => ({ request: request as never }));
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith(NeteaseMailRuntimeRpc.ReloadCredentials, {}, { timeoutMs: 15_000 });
  acknowledge({ ok: true, warningCount: 0 });
  expect(await reload).toBe(true);
});

test('an unavailable client or unsuccessful response cannot report readiness', async () => {
  expect(await reloadNeteaseMailCredentials(async () => null)).toBe(false);
  expect(await reloadNeteaseMailCredentials(async () => ({ request: vi.fn().mockResolvedValue({ ok: false }) }))).toBe(false);
});

test('a rejected reload does not expose upstream secrets or attempt a restart', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const request = vi.fn().mockRejectedValue(new Error('private-upstream-detail'));
  expect(await reloadNeteaseMailCredentials(async () => ({ request }))).toBe(false);
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-upstream-detail');
});
