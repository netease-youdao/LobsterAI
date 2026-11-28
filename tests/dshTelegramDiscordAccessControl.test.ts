import { afterEach, describe, expect, test, vi } from 'vitest';

const TELEGRAM_MODULE = '../dsh-bundles/lobsterai-channels/plugins/drivers/telegram.mjs';
const DISCORD_MODULE = '../dsh-bundles/lobsterai-channels/plugins/drivers/discord.mjs';
const BASE_DRIVER_MODULE = '../dsh-bundles/lobsterai-channels/plugins/drivers/base-driver.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('Telegram and Discord fail-closed access control', () => {
  test('Telegram DM fails closed by default and under empty allowlist, silently dropping strangers before media fetches', async () => {
    const { TelegramChannelDriver } = await import(TELEGRAM_MODULE);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const dmMsg = {
      message_id: 1,
      from: { id: 8813390588, username: 'scanner' },
      chat: { id: 8813390588, type: 'private' },
      text: '/status',
      photo: [{ file_id: 'attacker-photo', width: 100, height: 100 }],
    };

    for (const config of [
      {},
      { dmPolicy: 'allowlist', allowFrom: [] },
      { dmPolicy: 'allowlist', allowFrom: ['   '] },
      { dmPolicy: 'pairing', allowFrom: [] },
      { dmPolicy: 'disabled', allowFrom: ['8813390588'] },
      { dmPolicy: 'unknown', allowFrom: ['8813390588'] },
    ]) {
      const onInbound = vi.fn();
      const driver = new TelegramChannelDriver({ instanceId: 'tg-1', config, onInbound });
      await driver.handleMessage(dmMsg);
      expect(onInbound).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('Telegram DM allowlist matches exact IDs, prefixed IDs (tg:/telegram:), and wildcard while blocking others', async () => {
    const { TelegramChannelDriver } = await import(TELEGRAM_MODULE);

    const ownerMsg = {
      message_id: 10,
      from: { id: 8322789714, username: 'owner' },
      chat: { id: 8322789714, type: 'private' },
      text: 'hello',
    };
    const strangerMsg = {
      message_id: 11,
      from: { id: 8813390588, username: 'stranger' },
      chat: { id: 8813390588, type: 'private' },
      text: '/status',
    };

    for (const allowFrom of [['8322789714'], ['tg:8322789714'], ['telegram:8322789714'], ['user:8322789714']]) {
      const onInbound = vi.fn();
      const driver = new TelegramChannelDriver({
        instanceId: 'tg-1',
        config: { dmPolicy: 'allowlist', allowFrom },
        onInbound,
      });
      await driver.handleMessage(strangerMsg);
      await driver.handleMessage(ownerMsg);
      expect(onInbound).toHaveBeenCalledTimes(1);
      expect(onInbound.mock.calls[0]?.[0]).toMatchObject({ senderId: '8322789714', text: 'hello' });
    }

    const wildcardInbound = vi.fn();
    const wildcardDriver = new TelegramChannelDriver({
      instanceId: 'tg-1',
      config: { dmPolicy: 'allowlist', allowFrom: ['*'] },
      onInbound: wildcardInbound,
    });
    await wildcardDriver.handleMessage(strangerMsg);
    expect(wildcardInbound).toHaveBeenCalledTimes(1);

    const openInbound = vi.fn();
    const openDriver = new TelegramChannelDriver({
      instanceId: 'tg-1',
      config: { dmPolicy: 'open', allowFrom: [] },
      onInbound: openInbound,
    });
    await openDriver.handleMessage(strangerMsg);
    expect(openInbound).toHaveBeenCalledTimes(1);
  });

  test('Telegram group fails closed when groupAllowFrom is empty and enforces groupAllowFrom + per-group sender allowFrom', async () => {
    const { TelegramChannelDriver } = await import(TELEGRAM_MODULE);

    const mentionedGroupMsg = {
      message_id: 20,
      from: { id: 40 },
      chat: { id: -1200, type: 'supergroup' },
      text: '@Our_Bot ping',
      entities: [{ type: 'mention', offset: 0, length: 8 }],
    };

    // Default / empty groupAllowFrom denies even when mentioned
    for (const config of [
      {},
      { groupPolicy: 'allowlist', groupAllowFrom: [] },
      { groupPolicy: 'disabled', groupAllowFrom: ['-1200'] },
    ]) {
      const onInbound = vi.fn();
      const driver = new TelegramChannelDriver({ instanceId: 'tg-1', config, onInbound });
      driver.setState('connected', null, { id: 50, username: 'Our_Bot' });
      await driver.handleMessage(mentionedGroupMsg);
      expect(onInbound).not.toHaveBeenCalled();
    }

    // Explicit groupAllowFrom allows that group (independent of DM allowFrom) and rejects other groups
    const onInbound = vi.fn();
    const driver = new TelegramChannelDriver({
      instanceId: 'tg-1',
      config: {
        dmPolicy: 'allowlist',
        allowFrom: ['999999'],
        groupPolicy: 'allowlist',
        groupAllowFrom: ['tg:-1200'],
        groups: { '-1200': { requireMention: true, allowFrom: ['40'] } },
      },
      onInbound,
    });
    driver.setState('connected', null, { id: 50, username: 'Our_Bot' });

    await driver.handleMessage({ ...mentionedGroupMsg, chat: { id: -9999, type: 'supergroup' } });
    await driver.handleMessage({ ...mentionedGroupMsg, from: { id: 41 } });
    await driver.handleMessage(mentionedGroupMsg);

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound.mock.calls[0]?.[0]).toMatchObject({ chatId: '-1200', senderId: '40', chatType: 'group' });
  });

  test('Discord DM fails closed by default and enforces allowFrom with prefix normalization', async () => {
    const { DiscordChannelDriver } = await import(DISCORD_MODULE);

    const ownerDm = { id: 'm1', author: { id: '40', username: 'owner' }, channel_id: 'dm-1', content: 'hi' };
    const strangerDm = { id: 'm2', author: { id: '99', username: 'stranger' }, channel_id: 'dm-2', content: '/status' };

    for (const config of [
      {},
      { dmPolicy: 'allowlist', allowFrom: [] },
      { dmPolicy: 'pairing', allowFrom: [] },
      { dmPolicy: 'disabled', allowFrom: ['40'] },
    ]) {
      const onInbound = vi.fn();
      const driver = new DiscordChannelDriver({ instanceId: 'dc-1', config, onInbound });
      driver.botUserId = '50';
      await driver.handleMessage(ownerDm);
      expect(onInbound).not.toHaveBeenCalled();
    }

    const onInbound = vi.fn();
    const driver = new DiscordChannelDriver({
      instanceId: 'dc-1',
      config: { dmPolicy: 'allowlist', allowFrom: ['discord:40'] },
      onInbound,
    });
    driver.botUserId = '50';
    await driver.handleMessage(strangerDm);
    await driver.handleMessage(ownerDm);
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound.mock.calls[0]?.[0]).toMatchObject({ senderId: '40', chatType: 'direct' });
  });

  test('Discord guild fails closed when groupAllowFrom is empty and matches server or channel IDs', async () => {
    const { DiscordChannelDriver } = await import(DISCORD_MODULE);

    const guildMsg = {
      id: 'm3',
      author: { id: '40', username: 'member' },
      guild_id: '80',
      channel_id: '81',
      content: '<@50> status',
      mentions: [{ id: '50' }],
    };

    for (const config of [
      {},
      { groupPolicy: 'allowlist', groupAllowFrom: [] },
      { groupPolicy: 'disabled', groupAllowFrom: ['80'] },
    ]) {
      const onInbound = vi.fn();
      const driver = new DiscordChannelDriver({ instanceId: 'dc-1', config, onInbound });
      driver.botUserId = '50';
      await driver.handleMessage(guildMsg);
      expect(onInbound).not.toHaveBeenCalled();
    }

    const onInbound = vi.fn();
    const driver = new DiscordChannelDriver({
      instanceId: 'dc-1',
      config: {
        dmPolicy: 'allowlist',
        allowFrom: ['999'],
        groupPolicy: 'allowlist',
        groupAllowFrom: ['server:80'],
        guilds: { '80': { requireMention: true, allowFrom: ['user:40'] } },
      },
      onInbound,
    });
    driver.botUserId = '50';

    await driver.handleMessage({ ...guildMsg, guild_id: '999', channel_id: '998' });
    await driver.handleMessage({ ...guildMsg, author: { id: '41', username: 'other' } });
    await driver.handleMessage(guildMsg);

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound.mock.calls[0]?.[0]).toMatchObject({ chatId: '81', senderId: '40', chatType: 'group' });
  });

  test('BaseChannelDriver.isSenderAllowed remains unchanged for domestic IM drivers', async () => {
    const { BaseChannelDriver } = await import(BASE_DRIVER_MODULE);
    const driver = new BaseChannelDriver({
      platform: 'feishu',
      instanceId: 'fs-1',
      config: { dmPolicy: 'open', allowFrom: [] },
      onInbound: async () => {},
    });
    expect(driver.isSenderAllowed('ou_anyone')).toBe(true);
  });
});
