import { afterEach, expect, test, vi } from 'vitest';

import { logSidebarExperienceDiagnostic } from './sidebarExperienceDiagnostics';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('bounds persisted renderer diagnostics and never interrupts the caller', () => {
  const fromRenderer = vi.fn((_level: string, _tag: string, _message: string) => {
    throw new Error('logging unavailable');
  });
  vi.stubGlobal('window', {
    electron: {
      log: { fromRenderer },
    },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  expect(() => logSidebarExperienceDiagnostic(
    'warn',
    `failed ${'x'.repeat(600)}`,
    new TypeError('private upstream detail'),
  )).not.toThrow();

  expect(fromRenderer).toHaveBeenCalledOnce();
  const [, tag, message] = fromRenderer.mock.calls[0];
  expect(tag).toBe('SidebarExperience');
  expect(message.length).toBeLessThanOrEqual(400);
  expect(message).toContain('errorType=TypeError');
  expect(message).not.toContain('private upstream detail');
});
