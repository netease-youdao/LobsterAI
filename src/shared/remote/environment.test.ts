import { describe, expect, it } from 'vitest';

import { legacyRemoteEnvironments, RemoteEnvironment, sameRemoteEnvironment } from './environment';

describe('remote client modes', () => {
  it('recognizes historical test addresses without merging production', () => {
    for (const address of legacyRemoteEnvironments(RemoteEnvironment.Test, 'http://127.0.0.1:8080')) {
      if (!address.startsWith('https://')) continue;
      expect(sameRemoteEnvironment(address, RemoteEnvironment.Test)).toBe(true);
      expect(sameRemoteEnvironment(address, RemoteEnvironment.Production)).toBe(false);
    }
    expect(sameRemoteEnvironment('https://lobsterai-server.youdao.com/', RemoteEnvironment.Production)).toBe(true);
    expect(sameRemoteEnvironment(RemoteEnvironment.Test, RemoteEnvironment.Production)).toBe(false);
  });

  it('migrates the current development address without treating it as a new mode', () => {
    expect(legacyRemoteEnvironments(RemoteEnvironment.Test, 'http://127.0.0.1:8080/'))
      .toContain('http://127.0.0.1:8080');
    expect(legacyRemoteEnvironments(RemoteEnvironment.Test, 'https://lobsterai-server.youdao.com'))
      .not.toContain('https://lobsterai-server.youdao.com');
  });

  it('requires exact identity for unclassified historical signed scopes', () => {
    expect(sameRemoteEnvironment('https://unknown.example', 'https://unknown.example')).toBe(true);
    expect(sameRemoteEnvironment('https://unknown.example', 'https://unknown.example/')).toBe(false);
    expect(sameRemoteEnvironment('https://unknown.example', RemoteEnvironment.Test)).toBe(false);
  });
});
