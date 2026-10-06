import { describe, expect, test } from 'vitest';

import { resolveShellAppFileIconSize } from './shellAppIconPolicy';

describe('resolveShellAppFileIconSize', () => {
  test.each([
    ['darwin', 'normal'],
    ['win32', 'normal'],
    ['linux', 'large'],
  ] as const)('uses %s-safe Electron file icon size %s', (platform, expectedSize) => {
    expect(resolveShellAppFileIconSize(platform)).toBe(expectedSize);
  });
});
