import { afterEach, expect, test, vi } from 'vitest';

const feishuModule = '../dsh-bundles/lobsterai-channels/plugins/drivers/feishu.mjs';
const dingTalkModule = '../dsh-bundles/lobsterai-channels/plugins/drivers/dingtalk.mjs';
const qqModule = '../dsh-bundles/lobsterai-channels/plugins/drivers/qq.mjs';
const table = '| 城市 | 天气 |\n| --- | --- |\n| 杭州 | **晴** |';
const reply = '今日天气\n' + table;

afterEach(() => vi.unstubAllGlobals());

test.each([
  { streaming: true, mode: 'auto', isGroup: false, expected: 'interactive' },
  { streaming: true, mode: 'auto', isGroup: true, expected: 'post' },
  { streaming: true, mode: 'streaming', isGroup: true, expected: 'interactive' },
  { streaming: true, mode: 'static', isGroup: false, expected: 'post' },
  { streaming: false, mode: 'streaming', isGroup: false, expected: 'post' },
])('Feishu routes $mode (streaming=$streaming, group=$isGroup) through $expected', async (example) => {
  const { FeishuChannelDriver } = await import(feishuModule);
  const driver = new FeishuChannelDriver({ config: { streaming: example.streaming, replyMode: example.mode } });
  driver.getTenantAccessToken = async () => 'token';
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ code: 0, data: { message_id: 'ack' } }));
  vi.stubGlobal('fetch', fetch);
  await driver.sendMessage({ chatId: 'oc_chat', text: reply, replyContext: {
    replyToMessageId: 'om_source', replyInThread: example.isGroup, isGroup: example.isGroup,
  } });
  const [url, init] = fetch.mock.calls[0];
  expect(new URL(url).pathname).toBe('/open-apis/im/v1/messages/om_source/reply');
  const body = JSON.parse(String(init.body));
  expect(body).toMatchObject({ msg_type: example.expected, reply_in_thread: example.isGroup });
  const content = JSON.parse(body.content);
  if (example.expected === 'post') expect(content.zh_cn.content[0]).toEqual([{ tag: 'md', text: reply }]);
  else expect(content.body.elements).toEqual([{ tag: 'markdown', content: '今日天气\n\n' + table }]);
});

test('Feishu preserves the topic and table when CardKit rejects a card', async () => {
  const { FeishuChannelDriver } = await import(feishuModule);
  const driver = new FeishuChannelDriver({ config: { streaming: true, replyMode: 'streaming' } });
  driver.getTenantAccessToken = async () => 'token';
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ code: 0, data: { message_id: 'ack' } }))
    .mockResolvedValueOnce(Response.json({ code: 230099, msg: 'card table number over limit' }, { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  await expect(driver.sendMessage({ chatId: 'oc_chat', text: reply, replyContext: {
    replyToMessageId: 'om_source', replyInThread: true, isGroup: true,
  } })).resolves.toEqual({ messageId: 'ack' });
  const [[cardUrl], [postUrl, init]] = fetch.mock.calls;
  expect(postUrl).toBe(cardUrl);
  const post = JSON.parse(String(init.body));
  expect(post).toMatchObject({ msg_type: 'post', reply_in_thread: true });
  expect(JSON.parse(post.content).zh_cn.content[0][0].text).toBe(reply);
});

test.each([
  { conversationType: '1', space: 'IM_ROBOT.staff42' },
  { conversationType: '2', space: 'IM_GROUP.cidRoom' },
])('DingTalk delivers a finished table card to $space', async ({ conversationType, space }) => {
  const { DingTalkChannelDriver } = await import(dingTalkModule);
  const driver = new DingTalkChannelDriver({ config: { clientId: 'bot', clientSecret: 'secret' } });
  driver.getAppAccessToken = async () => 'token';
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ success: true, result: [{ success: true }] }));
  vi.stubGlobal('fetch', fetch);
  const receipt = await driver.sendMessage({ chatId: 'cidRoom', text: reply, replyContext: {
    conversationType, senderStaffId: 'staff42', sessionWebhook: 'https://example.invalid/callback',
  } });
  expect(fetch.mock.calls.map(([url, init]) => [init.method, new URL(url).pathname])).toEqual([
    ['POST', '/v1.0/card/instances'],
    ['POST', '/v1.0/card/instances/deliver'],
    ['PUT', '/v1.0/card/instances'],
    ['PUT', '/v1.0/card/streaming'],
    ['PUT', '/v1.0/card/instances'],
  ]);
  const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
  expect(bodies.every(body => body.outTrackId === receipt.messageId)).toBe(true);
  const [create, deliver, inputting, stream, finished] = bodies;
  expect(create.cardData.cardParamMap).toEqual({ config: JSON.stringify({ autoLayout: true }) });
  expect(deliver.openSpaceId).toBe('dtv1.card//' + space);
  const formatted = '今日天气\n\n' + table;
  expect(inputting.cardData.cardParamMap).toMatchObject({ flowStatus: '2', msgContent: formatted });
  expect(stream).toMatchObject({
    key: 'msgContent', content: formatted, guid: expect.any(String), isFull: true, isFinalize: true, isError: false,
  });
  expect(finished).toMatchObject({
    cardData: { cardParamMap: { flowStatus: '3', msgContent: formatted } },
    cardUpdateOptions: { updateCardDataByKey: true },
  });
});

test('DingTalk reports a rejected content update without posting a duplicate', async () => {
  const { DingTalkChannelDriver } = await import(dingTalkModule);
  const driver = new DingTalkChannelDriver({ config: { clientId: 'bot', clientSecret: 'secret' } });
  driver.getAppAccessToken = async () => 'token';
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ success: true }))
    .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true }] }))
    .mockResolvedValueOnce(Response.json({ success: true }))
    .mockResolvedValueOnce(Response.json({ success: false, code: 'invalidContent' }));
  vi.stubGlobal('fetch', fetch);
  await expect(driver.sendMessage({ chatId: 'staff42', text: reply })).rejects.toThrow('invalidContent');
  expect(fetch).toHaveBeenCalledTimes(4);
});

test('DingTalk retries a lost stream acknowledgement on the same card', async () => {
  const { DingTalkChannelDriver } = await import(dingTalkModule);
  const driver = new DingTalkChannelDriver({ config: { clientId: 'bot', clientSecret: 'secret' } });
  driver.getAppAccessToken = async () => 'token';
  const frames: string[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (new URL(url).pathname.endsWith('/streaming')) {
      frames.push(String(init.body));
      if (frames.length === 1) throw new Error('connection reset');
    }
    return Response.json({ success: true, result: [{ success: true }] });
  });
  vi.stubGlobal('fetch', fetch);
  const receipt = await driver.sendMessage({ chatId: 'staff42', text: reply });
  expect(receipt.delivered).toBe(true);
  expect(frames).toHaveLength(2);
  expect(frames[1]).toEqual(frames[0]);
  expect(JSON.parse(frames[0]).outTrackId).toBe(receipt.messageId);
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2);
});

test('DingTalk falls back on explicit rejection and avoids a duplicate after ambiguous delivery', async () => {
  const { DingTalkChannelDriver } = await import(dingTalkModule);
  const driver = new DingTalkChannelDriver({ config: { clientId: 'bot', clientSecret: 'secret' } });
  driver.getAppAccessToken = async () => 'token';
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ errcode: 0 }))
    .mockResolvedValueOnce(Response.json({ success: true }))
    .mockResolvedValueOnce(Response.json({ result: [{ success: false }] }));
  vi.stubGlobal('fetch', fetch);
  const params = { chatId: 'cidChat', text: reply, replyContext: { conversationType: '2', sessionWebhook: 'https://example.invalid/webhook' } };
  await expect(driver.sendMessage(params)).resolves.toMatchObject({ delivered: true });
  const [url, init] = fetch.mock.calls[2];
  expect(url).toBe(params.replyContext.sessionWebhook);
  expect(JSON.parse(String(init.body))).toEqual({ msgtype: 'markdown', markdown: { title: '今日天气', text: reply } });

  fetch.mockClear().mockResolvedValueOnce(Response.json({ success: true })).mockRejectedValueOnce(new Error('connection reset'));
  await expect(driver.sendMessage(params)).rejects.toThrow('connection reset');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
  { groupReplyMode: 'text', msgKey: 'sampleText', chatId: 'cidRoom' },
  { groupReplyMode: 'markdown', msgKey: 'sampleMarkdown', chatId: 'group:cidRoom' },
  { groupReplyMode: 'text', msgKey: 'sampleText', chatId: 'account:group:cidRoom' },
])('DingTalk delivers $groupReplyMode to the native group for $chatId', async ({ groupReplyMode, msgKey, chatId }) => {
  const { DingTalkChannelDriver } = await import(dingTalkModule);
  const driver = new DingTalkChannelDriver({ config: { clientId: 'bot', clientSecret: 'secret', groupReplyMode } });
  driver.getAppAccessToken = async () => 'token';
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ processQueryKey: 'ack' }));
  vi.stubGlobal('fetch', fetch);
  await driver.sendMessage({ chatId, text: reply });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(new URL(url).pathname).toBe('/v1.0/robot/groupMessages/send');
  const body = JSON.parse(String(init.body));
  expect(body).toMatchObject({ openConversationId: 'cidRoom', msgKey });
  expect(JSON.parse(body.msgParam)).toEqual(groupReplyMode === 'text' ? { content: reply } : { title: '今日天气', text: reply });
});

test.each([
  { enabled: undefined, group: true, msgType: 2 },
  { enabled: true, group: false, msgType: 2 },
  { enabled: false, group: false, msgType: 0 },
])('QQ sends type $msgType for group=$group with markdownSupport=$enabled', async ({ enabled, group, msgType }) => {
  const { QQChannelDriver } = await import(qqModule);
  const driver = new QQChannelDriver({ config: { markdownSupport: enabled } });
  driver.getAccessToken = async () => 'token';
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ack' }));
  vi.stubGlobal('fetch', fetch);
  for (const seq of [1, 2]) {
    await driver.sendMessage({ chatId: 'Alice', text: reply, replyContext: { isGroup: group, msgId: 'parent' } });
    const [url, init] = fetch.mock.calls[seq - 1];
    expect(new URL(url).pathname).toBe('/v2/' + (group ? 'groups' : 'users') + '/Alice/messages');
    expect(JSON.parse(String(init.body))).toEqual({
      msg_type: msgType, msg_id: 'parent', msg_seq: seq,
      ...(msgType === 2 ? { markdown: { content: reply } } : { content: reply }),
    });
  }
});
