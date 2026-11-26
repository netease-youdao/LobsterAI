import { describe, expect, test } from 'vitest';

import { ServerRouteContextTracker } from './serverRouteContext';

describe('server route context', () => {
  test('records an idle A → B → A while unchanged settings preserve the context', () => {
    const contexts = new ServerRouteContextTracker();
    expect(contexts.peekEpoch()).toBe(0);
    const first = contexts.capture('https://a.example', 'owner:1');
    expect(contexts.capture('https://a.example', 'owner:1')).toBe(first);
    const second = contexts.capture('https://b.example', 'owner:1');
    const third = contexts.capture('https://a.example', 'owner:1');
    expect([first.routeEpoch, second.routeEpoch, third.routeEpoch]).toEqual([1, 2, 3]);
    expect(contexts.peekEpoch()).toBe(third.routeEpoch);
    expect(first.apiBaseUrl).toBe('https://a.example');
    expect(Object.isFrozen(first)).toBe(true);
  });

  test('invalidates a same-owner re-login by auth generation without depending on token rotation', () => {
    const contexts = new ServerRouteContextTracker();
    const first = contexts.capture('https://a.example', 'owner:auth-generation-1');
    const next = contexts.capture('https://a.example', 'owner:auth-generation-2');
    expect(next.routeEpoch).toBe(first.routeEpoch + 1);
    expect(contexts.capture('https://a.example', 'owner:auth-generation-2')).toBe(next);
    expect(contexts.capture('https://a.example', 'enterprise:auth-generation-2').routeEpoch).toBe(next.routeEpoch + 1);
  });
});
