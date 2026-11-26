import { afterEach, expect, it, vi } from 'vitest';

import { RemoteDiagnostics } from './remoteDiagnostics';

afterEach(() => vi.useRealTimers());
it('keeps a bounded numeric allowlist without content and distinguishes unknown samples from zero', () => {
  const diagnostics = new RemoteDiagnostics();
  diagnostics.record('files.failed', 2); diagnostics.record('files.failed', Number.NaN);
  diagnostics.record('unsafe raw body' as never, 1); diagnostics.gauge('cache.bytes', 0);
  diagnostics.gauge('pendingSessions', Number.NaN); diagnostics.gauge('untrusted path' as never, 123);
  expect(diagnostics.snapshot()).toMatchObject({ 'files.failed': 2, 'cache.bytes': 0, pendingSessions: null });
  expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/unsafe|untrusted/u);
});
it('contains sampler and logger failures and stops periodic work', () => {
  vi.useFakeTimers(); const diagnostics = new RemoteDiagnostics();
  const sample = vi.fn(() => { throw new Error('private path'); }); const log = vi.fn(() => { throw new Error('unavailable'); });
  diagnostics.start(sample, log); diagnostics.start(sample, log);
  expect(() => vi.advanceTimersByTime(120000)).not.toThrow(); expect(sample).toHaveBeenCalledTimes(2);
  diagnostics.stop(); vi.advanceTimersByTime(60000); expect(sample).toHaveBeenCalledTimes(2);
});
