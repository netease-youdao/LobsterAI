import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('openclaw-browser-blocked-hostnames.patch', () => {
  test('keeps browser SSRF blocklist schema and runtime support', () => {
    expectPatchContains('openclaw-browser-blocked-hostnames.patch', [
      'diff --git a/src/config/types.browser.ts',
      'blockedHostnames?: string[];',
      'diff --git a/src/config/zod-schema.ts',
      'blockedHostnames: z.array(z.string()).optional()',
      'diff --git a/extensions/browser/src/browser/config.ts',
      'normalizeStringList(rawPolicy?.blockedHostnames)',
      'diff --git a/src/infra/net/ssrf.ts',
      'isHostnameBlockedByPolicy',
      'Blocked hostname (configured blocklist)',
    ]);
  });

  test('adds OpenClaw coverage for normalized and wildcard blocked hostnames', () => {
    expectPatchContains('openclaw-browser-blocked-hostnames.patch', [
      'diff --git a/extensions/browser/src/browser/config.test.ts',
      'blockedHostnames: [" www.baidu.com ", ""]',
      'diff --git a/src/infra/net/ssrf.pinning.test.ts',
      'blocks configured hostnames before DNS lookup',
      'supports wildcard hostname blocklist patterns',
      'expect(lookup).not.toHaveBeenCalled()',
    ]);
  });
});
