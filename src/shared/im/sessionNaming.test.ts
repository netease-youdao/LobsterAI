import { describe, expect, test } from 'vitest';

import {
  buildWeixinSessionLabel,
  extractWeixinPeerShortSuffix,
  isOpaqueWeixinPeerId,
} from './sessionNaming';

describe('sessionNaming', () => {
  test('detects full, truncated, and legacy opaque WeChat iLink peer IDs', () => {
    expect(isOpaqueWeixinPeerId('o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat')).toBe(true);
    expect(isOpaqueWeixinPeerId('o9cq809ZEC25-4jLkdw3AHTKPE9c@im.')).toBe(true);
    expect(isOpaqueWeixinPeerId('o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wec')).toBe(true);
    expect(isOpaqueWeixinPeerId('direct:o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat')).toBe(true);
    expect(isOpaqueWeixinPeerId('私聊:o9cq809ZEC25-4jLkdw3')).toBe(true);
    expect(isOpaqueWeixinPeerId('o9cq809ZEC25-4jLkdw3')).toBe(true);
  });

  test('does not misclassify human-readable names or unrelated short test strings', () => {
    expect(isOpaqueWeixinPeerId('我的微信')).toBe(false);
    expect(isOpaqueWeixinPeerId('My WeChat')).toBe(false);
    expect(isOpaqueWeixinPeerId('Alice')).toBe(false);
    expect(isOpaqueWeixinPeerId('alice@example.com')).toBe(false);
    expect(isOpaqueWeixinPeerId('group:o9cq')).toBe(false);
    expect(isOpaqueWeixinPeerId('')).toBe(false);
    expect(isOpaqueWeixinPeerId(null)).toBe(false);
  });

  test('extracts a clean 4-char suffix from opaque WeChat peer IDs', () => {
    expect(extractWeixinPeerShortSuffix('o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat')).toBe('PE9c');
    expect(extractWeixinPeerShortSuffix('direct:o9cq809ZEC25_1234@im.wechat')).toBe('1234');
  });

  test('builds owner label for scanned owner or when owner ID is absent', () => {
    expect(buildWeixinSessionLabel({
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      senderId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      ownerUserId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      ownerLabel: '我的微信',
      contactLabelPrefix: '微信联系人',
    })).toBe('我的微信');

    expect(buildWeixinSessionLabel({
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      ownerLabel: '我的微信',
      contactLabelPrefix: '微信联系人',
    })).toBe('我的微信');
  });

  test('builds short contact label for non-owner peers and respects real senderName', () => {
    expect(buildWeixinSessionLabel({
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      senderId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      ownerUserId: 'other-owner-id@im.wechat',
      ownerLabel: '我的微信',
      contactLabelPrefix: '微信联系人',
    })).toBe('微信联系人 · PE9c');

    expect(buildWeixinSessionLabel({
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      senderName: '张三',
      ownerUserId: 'other-owner-id@im.wechat',
      ownerLabel: '我的微信',
      contactLabelPrefix: '微信联系人',
    })).toBe('张三');

    expect(buildWeixinSessionLabel({
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      senderName: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      ownerUserId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      ownerLabel: '我的微信',
      contactLabelPrefix: '微信联系人',
    })).toBe('我的微信');
  });
});
