import { afterEach, expect, test, vi } from 'vitest';

const telegramModule = '../dsh-bundles/lobsterai-channels/plugins/drivers/telegram.mjs';
const discordModule = '../dsh-bundles/lobsterai-channels/plugins/drivers/discord.mjs';
const telegramGroup = { id: -1200, type: 'supergroup' };
const telegramMessage = { message_id: 7, from: { id: 40 }, chat: telegramGroup, text: 'hello' };
const discordMessage = { id: '7', author: { id: '40' }, guild_id: '80', channel_id: '81', content: 'hello' };

afterEach(() => vi.unstubAllGlobals());

async function telegramDriver(config = {}) {
  const { TelegramChannelDriver } = await import(telegramModule);
  const onInbound = vi.fn();
  const driver = new TelegramChannelDriver({ config, onInbound });
  driver.setState('connected', null, { id: 50, username: 'Our_Bot' });
  return { driver, onInbound };
}

test.each([
  ['caption mention after emoji', { text: undefined, caption: '🎈 @OUR_BOT', caption_entities: [{ type: 'mention', offset: 3, length: 8 }] }, true],
  ['named mention', { entities: [{ type: 'text_mention', user: { id: 50 } }] }, true],
  ['addressed command', { text: '/help@our_bot', entities: [{ type: 'bot_command', offset: 0, length: 13 }] }, true],
  ['reply to this bot', { reply_to_message: { from: { id: 50 }, text: 'previous answer' } }, true],
  ['reply to a topic service event', { reply_to_message: { from: { id: 50 }, forum_topic_created: {} } }, false],
  ['other reply', { reply_to_message: { from: { id: 51 }, text: '@Our_Bot' } }, false],
  ['another bot with a similar handle', { text: '@our_bot_helper' }, false],
  ['plain message', {}, false],
] as const)('Telegram routes %s', async (_name, fields, accepted) => {
  const { driver, onInbound } = await telegramDriver();
  await driver.handleMessage({ ...telegramMessage, ...fields });
  expect(onInbound).toHaveBeenCalledTimes(accepted ? 1 : 0);
});

test('Telegram respects each group override, private chats and commands addressed to another bot', async () => {
  const { driver, onInbound } = await telegramDriver({ groups: { '*': { requireMention: true }, '-1200': { requireMention: false } } });
  await driver.handleMessage(telegramMessage);
  await driver.handleMessage({ ...telegramMessage, chat: { id: 40, type: 'private' } });
  await driver.handleMessage({ ...telegramMessage, text: '/help@other', entities: [{ type: 'bot_command', offset: 0, length: 11 }] });
  expect(onInbound.mock.calls.map(([event]) => event.chatType)).toEqual(['group', 'direct']);
});

test('Telegram uses chat-local message IDs and delivers forum replies to their native topics', async () => {
  const { driver, onInbound } = await telegramDriver({ groups: { '*': { requireMention: false } } });
  const send = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, result: { message_id: 8 } }));
  vi.stubGlobal('fetch', send);
  const forum = { id: -1300, type: 'supergroup', is_forum: true };
  await driver.handleMessage({ ...telegramMessage, message_thread_id: 93 });
  await driver.handleMessage({ ...telegramMessage, chat: forum });
  await driver.handleMessage({ ...telegramMessage, chat: forum, message_thread_id: 42, message_id: 123 });
  const events = onInbound.mock.calls.map(([event]) => event);
  expect(events.map(event => [event.chatId, event.messageId, event.replyContext.replyToMessageId])).toEqual([
    ['-1200', '-1200:7', 7], ['-1300:topic:1', '-1300:7', 7], ['-1300:topic:42', '-1300:123', 123],
  ]);
  for (const event of events) await driver.sendMessage(event);
  expect(send.mock.calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
    { chat_id: '-1200', text: 'hello' }, { chat_id: '-1300', text: 'hello' },
    { chat_id: '-1300', message_thread_id: 42, text: 'hello' },
  ]);
});

test.each([
  ['explicit mention', { mentions: [{ id: '50' }] }, true],
  ['reply to this bot', { referenced_message: { author: { id: '50' }, content: 'old' } }, true],
  ['everyone', { mention_everyone: true }, true],
  ['other mention', { mentions: [{ id: '51' }] }, false],
  ['ordinary conversation', {}, false],
  ['bot author', { mentions: [{ id: '50' }], author: { id: '51', bot: true } }, false],
  ['unrestricted guild', { guild_id: '82' }, true],
  ['direct message', { guild_id: undefined }, true],
] as const)('Discord routes %s', async (_name, fields, accepted) => {
  const { DiscordChannelDriver } = await import(discordModule);
  const onInbound = vi.fn();
  const driver = new DiscordChannelDriver({ config: { guilds: { '*': { requireMention: true }, '82': { requireMention: false } } }, onInbound });
  driver.botUserId = '50';
  await driver.handleMessage({ ...discordMessage, ...fields });
  expect(onInbound).toHaveBeenCalledTimes(accepted ? 1 : 0);
});
