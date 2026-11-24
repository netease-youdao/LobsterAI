import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
  },
  session: {
    defaultSession: {
      setProxy: vi.fn(),
      resolveProxy: vi.fn(),
    },
  },
}));

import {
  resolveProxyForTargetsWithResolver,
  runWithProxyTimeout,
} from './systemProxy';

describe('systemProxy timeout and concurrent target resolution', () => {
  test('runWithProxyTimeout rejects promptly when underlying promise hangs', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(runWithProxyTimeout(never, 30, 'test-op')).rejects.toThrow(/timed out after 30ms/);
  });

  test('resolveProxyForTargetsWithResolver probes targets concurrently and preserves priority order', async () => {
    const started: string[] = [];
    const targets = ['https://first.example', 'https://second.example', 'https://third.example'];

    const result = await resolveProxyForTargetsWithResolver(
      targets,
      async (targetUrl) => {
        started.push(targetUrl);
        if (targetUrl === 'https://first.example') {
          await new Promise((r) => setTimeout(r, 30));
          return null;
        }
        if (targetUrl === 'https://second.example') {
          await new Promise((r) => setTimeout(r, 20));
          return 'http://127.0.0.1:7890';
        }
        return 'http://127.0.0.1:9999';
      },
      1000,
    );

    expect(started).toEqual(targets);
    expect(result).toEqual({
      targetUrl: 'https://second.example',
      proxyUrl: 'http://127.0.0.1:7890',
    });
  });

  test('resolveProxyForTargetsWithResolver falls back to DIRECT when all targets fail or time out', async () => {
    const targets = ['https://a.example', 'https://b.example'];
    const result = await resolveProxyForTargetsWithResolver(
      targets,
      async () => {
        throw new Error('proxy timeout');
      },
      50,
    );

    expect(result).toEqual({ proxyUrl: null, targetUrl: null });
  });
});
