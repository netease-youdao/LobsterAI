import { describe, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import {
  getIMSessionDisplayTitle,
  getIMSessionPlatformIconClassName,
  getIMSessionPlatformLogo,
} from './imSessionDisplay';

describe('getIMSessionDisplayTitle', () => {
  test('strips only the matching platform prefix', () => {
    expect(getIMSessionDisplayTitle('[微信] group:o9cq', 'weixin')).toEqual({
      title: 'group:o9cq',
      strippedPrefix: true,
    });
    expect(getIMSessionDisplayTitle('[微信] group:o9cq', 'feishu')).toEqual({
      title: '[微信] group:o9cq',
      strippedPrefix: false,
    });
  });

  test('keeps user-authored channel-looking titles without a platform', () => {
    expect(getIMSessionDisplayTitle('[微信] 营销方案', null)).toEqual({
      title: '[微信] 营销方案',
      strippedPrefix: false,
    });
  });

  test('strips NIM direct title prefixes without removing chat type context', () => {
    expect(getIMSessionDisplayTitle('云信-P2P-张三', 'nim')).toEqual({
      title: 'P2P-张三',
      strippedPrefix: true,
    });
  });

  test('supports the claw email IM channel display variants', () => {
    expect(getIMSessionDisplayTitle('[龙虾邮箱] inbox:user', 'email')).toEqual({
      title: 'inbox:user',
      strippedPrefix: true,
    });
    expect(getIMSessionDisplayTitle('[邮件] inbox:user', 'email')).toEqual({
      title: 'inbox:user',
      strippedPrefix: true,
    });
  });

  test('uses the shared platform registry logos', () => {
    expect(getIMSessionPlatformLogo('weixin')).toBe('weixin.png');
    expect(getIMSessionPlatformLogo('discord')).toBe('discord.svg');
  });

  test('applies session-list visual size tuning for uneven source assets', () => {
    expect(getIMSessionPlatformIconClassName('weixin')).toBe('h-4 w-4 rounded-sm object-contain scale-90');
    expect(getIMSessionPlatformIconClassName('dingtalk')).toBe('h-4 w-4 rounded-sm object-contain scale-110');
    expect(getIMSessionPlatformIconClassName('feishu')).toBe('h-4 w-4 rounded-sm object-contain scale-[1.15]');
    expect(getIMSessionPlatformIconClassName('wecom')).toBe('h-4 w-4 rounded-sm object-contain scale-110');
    expect(getIMSessionPlatformIconClassName('popo')).toBe('h-4 w-4 rounded-sm object-contain scale-110');
    expect(getIMSessionPlatformIconClassName('qq')).toBe('h-4 w-4 rounded-sm object-contain');
  });

  test('maps legacy opaque WeChat iLink IDs to a friendly owner title while preserving custom names', () => {
    const tSpy = vi.spyOn(i18nService, 't');
    try {
      tSpy.mockImplementation((key: string) => (key === 'imWeixinOwnerSessionTitle' ? '我的微信' : key));
      expect(
        getIMSessionDisplayTitle('[微信] o9cq809ZEC25-4jLkdw3AHTKPE9c@im.', 'weixin'),
      ).toEqual({
        title: '我的微信',
        strippedPrefix: true,
      });
      expect(
        getIMSessionDisplayTitle('[微信] o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat', 'weixin'),
      ).toEqual({
        title: '我的微信',
        strippedPrefix: true,
      });
      expect(
        getIMSessionDisplayTitle('老板的微信', 'weixin'),
      ).toEqual({
        title: '老板的微信',
        strippedPrefix: false,
      });

      tSpy.mockImplementation((key: string) => (key === 'imWeixinOwnerSessionTitle' ? 'My WeChat' : key));
      expect(
        getIMSessionDisplayTitle('[WeChat] o9cq809ZEC25-4jLkdw3AHTKPE9c@im.', 'weixin'),
      ).toEqual({
        title: 'My WeChat',
        strippedPrefix: true,
      });
    } finally {
      tSpy.mockRestore();
    }
  });

  test('ignores and logs unknown platforms without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(getIMSessionPlatformLogo('unknown-channel')).toBeNull();
      expect(getIMSessionPlatformLogo('unknown-channel')).toBeNull();
      expect(getIMSessionDisplayTitle('[微信] title', 'unknown-channel')).toEqual({
        title: '[微信] title',
        strippedPrefix: false,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[IMSessionDisplay] Ignoring unknown IM platform for session list:',
        'unknown-channel',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
