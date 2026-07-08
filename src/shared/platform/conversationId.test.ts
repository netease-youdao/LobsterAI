import { describe, expect, test } from 'vitest';

import { imConversationDisplayName, parseImConversationId } from './conversationId';

describe('parseImConversationId', () => {
  test('parses peerKind:peerId form', () => {
    expect(parseImConversationId('direct:alice@corp.example.com')).toEqual({
      peerKind: 'direct',
      peerId: 'alice@corp.example.com',
    });
  });

  test('parses accountId:peerKind:peerId form', () => {
    expect(parseImConversationId('cebef798:direct:8368898190')).toEqual({
      accountId: 'cebef798',
      peerKind: 'direct',
      peerId: '8368898190',
    });
  });

  test('parses group conversations', () => {
    expect(parseImConversationId('bot1:group:12345@popo.netease.com')).toEqual({
      accountId: 'bot1',
      peerKind: 'group',
      peerId: '12345@popo.netease.com',
    });
  });

  test('keeps colons inside the peer id', () => {
    expect(parseImConversationId('acc:channel:room:sub')).toEqual({
      accountId: 'acc',
      peerKind: 'channel',
      peerId: 'room:sub',
    });
  });

  test('returns the raw id when no peer kind is present', () => {
    expect(parseImConversationId('oc_a1b2c3')).toEqual({ peerId: 'oc_a1b2c3' });
    expect(parseImConversationId('dm:ou_123')).toEqual({ peerId: 'dm:ou_123' });
  });

  test('treats a trailing peer kind with no id as plain', () => {
    expect(parseImConversationId('direct:')).toEqual({ peerId: 'direct:' });
  });
});

describe('imConversationDisplayName', () => {
  test('strips peer kind and email domain', () => {
    expect(imConversationDisplayName('direct:alice@corp.example.com')).toBe('alice');
  });

  test('strips account prefix for weixin-style ids', () => {
    expect(imConversationDisplayName('direct:wxid_abc@im.wechat')).toBe('wxid_abc');
  });

  test('keeps plain numeric ids as-is', () => {
    expect(imConversationDisplayName('cebef798:direct:8368898190')).toBe('8368898190');
  });

  test('falls back to the raw id when stripping empties the value', () => {
    expect(imConversationDisplayName('@im.wechat')).toBe('@im.wechat');
  });
});
