import { describe, expect, test } from 'vitest';

import { MainView } from '../types/navigation';
import { describeAppDeepLinkTarget, isAppDeepLink, parseAppDeepLink } from './appDeepLink';

describe('app deep links', () => {
  test('parses settings tabs and main views', () => {
    expect(parseAppDeepLink('lobsterai://settings/im')).toEqual({ kind: 'settings', tab: 'im' });
    expect(parseAppDeepLink(' lobsterai://settings/desktopCompanion/ ')).toEqual({
      kind: 'settings',
      tab: 'desktopCompanion',
    });
    expect(parseAppDeepLink('lobsterai://view/scheduledTasks')).toEqual({ kind: 'view', view: 'scheduledTasks' });
    expect(parseAppDeepLink('lobsterai://view/skills')).toEqual({ kind: 'view', view: 'skills' });
  });

  test('rejects web urls, auth callbacks and unknown targets', () => {
    expect(parseAppDeepLink('https://lobsterai.youdao.com/#/pricing')).toBeNull();
    expect(parseAppDeepLink('lobsterai://auth/callback?code=abc')).toBeNull();
    expect(parseAppDeepLink('lobsterai://settings/billing')).toBeNull();
    expect(parseAppDeepLink('lobsterai://view/unknown')).toBeNull();
    expect(parseAppDeepLink('lobsterai://settings/im?x=1')).toBeNull();
  });

  test('names a destination the way the app labels it', () => {
    const translate = (key: string) => `<${key}>`;
    expect(describeAppDeepLinkTarget({ kind: 'view', view: MainView.Experts }, translate)).toBe('<expertPlaza>');
    expect(describeAppDeepLinkTarget({ kind: 'view', view: MainView.Connectors }, translate)).toBe('<connectors>');
    expect(describeAppDeepLinkTarget({ kind: 'settings', tab: 'desktopCompanion' }, translate))
      .toBe('<settings> · <desktopCompanionTitle>');
  });

  test('every main view a link can open has a name', () => {
    const translate = (key: string) => key;
    for (const view of Object.values(MainView)) {
      expect(describeAppDeepLinkTarget({ kind: 'view', view }, translate)).toMatch(/^[A-Za-z]+$/);
    }
  });

  test('recognises the scheme so unknown in-app links are never opened externally', () => {
    expect(isAppDeepLink('lobsterai://view/future')).toBe(true);
    expect(isAppDeepLink('LobsterAI://settings/im')).toBe(true);
    expect(isAppDeepLink('https://example.com')).toBe(false);
  });
});
