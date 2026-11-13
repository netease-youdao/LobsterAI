import { describe, expect, test, vi } from 'vitest';

import { DSH_INSTANCE_HEADER, DSH_OBSERVER_READY_PREFIX } from '../../shared/dshEngine/analytics';
import { buildDshObservationPluginSource } from './dshObservationPlugin';

type HeaderListener = (request: { baseURL: string }, headers: Headers, next: () => Headers) => Headers;
const instanceId = '01234567-89ab-4def-8123-456789abcdef';
const baseUrl = 'http://127.0.0.1:34567/v1';

function loadPlugin() {
  const on = vi.fn();
  const log = vi.fn();
  // Execute exactly the generated, dependency-free child module's apply().
  const apply = new Function('console', `${buildDshObservationPluginSource().replace('export function', 'function')}; return apply;`)({ log });
  apply({ on }, { instanceId, baseUrl });
  return { apply, on, log, listener: on.mock.calls[0][1] as HeaderListener };
}

describe('DSH observation plugin', () => {
  test('only contributes to the exact proxy base, preserving credentials and other headers', () => {
    const { on, log, listener } = loadPlugin();
    expect(on.mock.calls[0][0]).toBe('llm-pi-ai/request-headers');
    expect(log).toHaveBeenCalledWith(DSH_OBSERVER_READY_PREFIX + instanceId);
    for (const url of [baseUrl, `${baseUrl}/`]) {
      const headers = new Headers({ authorization: 'Bearer unchanged', custom: 'preserved' });
      const next = vi.fn(() => headers);
      expect(listener({ baseURL: url }, headers, next)).toBe(headers);
      expect(next).toHaveBeenCalledOnce();
      expect(headers.get(DSH_INSTANCE_HEADER)).toBe(instanceId);
      expect(headers.get('authorization')).toBe('Bearer unchanged');
      expect(headers.get('custom')).toBe('preserved');
    }
    for (const url of ['https://api.example/v1', 'http://127.0.0.1:34568/v1', `${baseUrl}/other`, `${baseUrl}?redirect=1`, 'bad-url']) {
      const headers = new Headers();
      listener({ baseURL: url }, headers, () => headers);
      expect(headers.has(DSH_INSTANCE_HEADER)).toBe(false);
    }
  });

  test('isolates its own failures and never retries the downstream waterfall', () => {
    const { apply, listener } = loadPlugin();
    const headers = new Headers();
    vi.spyOn(headers, 'set').mockImplementation(() => { throw new Error('read only'); });
    const next = vi.fn(() => headers);
    expect(listener({ baseURL: baseUrl }, headers, next)).toBe(headers);
    expect(next).toHaveBeenCalledOnce();
    const downstream = vi.fn(() => { throw new Error('downstream'); });
    expect(() => listener({ baseURL: baseUrl }, headers, downstream)).toThrow('downstream');
    expect(downstream).toHaveBeenCalledOnce();
    expect(() => apply({ on: () => { throw new Error('missing hook'); } }, { instanceId, baseUrl })).not.toThrow();
  });
});
