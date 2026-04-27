import { describe, expect, it } from 'vitest';

import { describeSensitiveKeyDenial, isSensitiveStoreKey } from './storeAccessControl';

describe('isSensitiveStoreKey', () => {
  it('flags the auth_tokens kv entry', () => {
    expect(isSensitiveStoreKey('auth_tokens')).toBe(true);
  });

  it('flags the github_copilot_github_token kv entry', () => {
    expect(isSensitiveStoreKey('github_copilot_github_token')).toBe(true);
  });

  it('flags any key under the copilot: prefix', () => {
    expect(isSensitiveStoreKey('copilot:access_token')).toBe(true);
    expect(isSensitiveStoreKey('copilot:refresh_token')).toBe(true);
  });

  it('flags any key under the github_copilot: prefix', () => {
    expect(isSensitiveStoreKey('github_copilot:device_token')).toBe(true);
  });

  it('treats key matching as case-sensitive', () => {
    expect(isSensitiveStoreKey('AUTH_TOKENS')).toBe(false);
    expect(isSensitiveStoreKey('Copilot:foo')).toBe(false);
  });

  it('allows benign renderer-managed keys', () => {
    expect(isSensitiveStoreKey('app_config')).toBe(false);
    expect(isSensitiveStoreKey('privacy_agreed')).toBe(false);
    expect(isSensitiveStoreKey('installation_uuid')).toBe(false);
    expect(isSensitiveStoreKey('providers_export_key')).toBe(false);
    expect(isSensitiveStoreKey('skills')).toBe(false);
    expect(isSensitiveStoreKey('skills_state')).toBe(false);
  });

  it('rejects non-string keys without throwing', () => {
    expect(isSensitiveStoreKey(undefined)).toBe(false);
    expect(isSensitiveStoreKey(null)).toBe(false);
    expect(isSensitiveStoreKey(123)).toBe(false);
    expect(isSensitiveStoreKey({})).toBe(false);
    expect(isSensitiveStoreKey('')).toBe(false);
  });

  it('does not match keys that merely contain a sensitive substring', () => {
    expect(isSensitiveStoreKey('auth_tokens_legacy_log')).toBe(false);
    expect(isSensitiveStoreKey('legacy:auth_tokens')).toBe(false);
  });
});

describe('describeSensitiveKeyDenial', () => {
  it('returns a stable message that includes the channel name', () => {
    expect(describeSensitiveKeyDenial('store:get')).toBe(
      'store:get blocked: key is reserved for the main process',
    );
    expect(describeSensitiveKeyDenial('store:set')).toBe(
      'store:set blocked: key is reserved for the main process',
    );
  });

  it('does not echo the key value back to the renderer', () => {
    const message = describeSensitiveKeyDenial('store:remove');
    expect(message).not.toContain('auth_tokens');
    expect(message).not.toContain('copilot');
  });
});
