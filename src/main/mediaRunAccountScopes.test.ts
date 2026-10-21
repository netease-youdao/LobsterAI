import { describe, expect, test } from 'vitest';

import { MediaRunAccountScopes } from './mediaRunAccountScopes';

const account = { ownerAccountKey: 'personal:123', accountGeneration: 1 };
const otherAccount = { ownerAccountKey: 'enterprise:456:123', accountGeneration: 2 };

describe('native media run account isolation', () => {
  test.each([
    'agent:main:feishu:direct:user-1',
    'agent:main:cron:job-1:run:execution-1',
  ])('captures an account without desktop IPC for %s', sessionKey => {
    const scopes = new MediaRunAccountScopes();
    const run = { sessionKey, runId: 'run-1' };
    scopes.begin(run, account);
    expect(scopes.resolve(run, account)).toEqual(account);
    expect(scopes.resolve(run, otherAccount)).toBeNull();
    expect(scopes.resolve(run, { ...account, accountGeneration: 3 })).toBeNull();
    expect(scopes.resolve(run, null)).toBeNull();
  });

  test('a repeated start after switching accounts cannot claim the new account', () => {
    const scopes = new MediaRunAccountScopes();
    const run = { sessionKey: 'agent:main:main', runId: 'run-1' };
    scopes.begin(run, account);
    scopes.begin(run, otherAccount);
    expect(scopes.resolve(run, otherAccount)).toBeNull();
    expect(scopes.resolve(run, account)).toEqual(account);
  });

  test('a run started logged out remains unauthenticated after login', () => {
    const scopes = new MediaRunAccountScopes();
    const run = { sessionKey: 'agent:main:main', runId: 'run-1' };
    scopes.begin(run, null);
    scopes.begin(run, account);
    expect(scopes.resolve(run, account)).toBeNull();
  });

  test('late cleanup and callbacks cannot use another run in the same session', () => {
    const scopes = new MediaRunAccountScopes();
    const first = { sessionKey: 'agent:main:main', runId: 'run-1' };
    const second = { ...first, runId: 'run-2' };
    scopes.begin(first, account);
    scopes.begin(second, otherAccount);
    scopes.end(first);
    expect(scopes.resolve(first, otherAccount)).toBeNull();
    expect(scopes.resolve(second, otherAccount)).toEqual(otherAccount);
    expect(scopes.resolve({ ...second, sessionKey: 'agent:other:main' }, otherAccount)).toBeNull();
    expect(scopes.resolve({ sessionKey: second.sessionKey }, otherAccount)).toBeNull();
  });
});
