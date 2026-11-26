import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { initScheduledTaskHelpers, listScheduledTaskChannels } from '../src/main/ipcHandlers/scheduledTask/helpers';
import { buildDshImChannelInstances } from '../src/main/libs/dsh/dshImConfigTranslator';
import { RetainedImPlatform } from '../src/shared/dshEngine/hostConstants';
import { legacyWeixinAccountId, WeixinPlugin } from '../src/shared/im/weixin';
import { PlatformRegistry } from '../src/shared/platform';

const feishuDriver = '../dsh-bundles/lobsterai-channels/plugins/drivers/feishu.mjs';
const dingTalkDriver = '../dsh-bundles/lobsterai-channels/plugins/drivers/dingtalk.mjs';
const weixinDriver = '../dsh-bundles/lobsterai-channels/plugins/drivers/weixin.mjs';
const recipientStore = '../dsh-bundles/lobsterai-channels/plugins/drivers/direct-recipient-store.mjs';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'im-scheduled-'));
  vi.stubEnv('DSH_HOME', path.join(home, 'dsh-profile'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

test('limits restored recipients and retries persistence after a temporary write failure', async () => {
  const { DirectRecipientStore } = await import(recipientStore);
  const legacyFile = path.join(home, 'legacy.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ one: 'a', two: 'b', three: 'c' }));
  const store = new DirectRecipientStore(RetainedImPlatform.Weixin, 'bot', { legacyFile, limit: 2 });
  expect([...store.entries.keys()]).toEqual(['two', 'three']);

  const stateDir = path.join(home, 'dsh-profile');
  fs.writeFileSync(stateDir, 'temporarily unavailable');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    store.remember('two', 'new');
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
  }
  fs.unlinkSync(stateDir);
  store.remember('two', 'new');
  expect(new DirectRecipientStore(RetainedImPlatform.Weixin, 'bot').entries.get('two')).toBe('new');
});

test('lists enabled POPO accounts as separate notification destinations', () => {
  initScheduledTaskHelpers({ getIMGatewayManager: () => ({ getConfig: () => ({
    popo: { instances: [
      { instanceId: '11111111-full', instanceName: 'One', enabled: true },
      { instanceId: '22222222-full', instanceName: 'Two', enabled: true },
      { instanceId: '33333333-full', enabled: false },
    ] },
  }) }) });
  try {
    const channel = PlatformRegistry.channelOf(RetainedImPlatform.Popo);
    expect(listScheduledTaskChannels()).toEqual([
      { value: channel, label: 'One', accountId: '11111111', filterAccountId: '11111111' },
      { value: channel, label: 'Two', accountId: '22222222', filterAccountId: '22222222' },
    ]);
  } finally {
    initScheduledTaskHelpers({ getIMGatewayManager: () => null });
  }
});

test('sends Feishu reminders to a legacy open ID or a native private chat ID', async () => {
  const { FeishuChannelDriver } = await import(feishuDriver);
  const targets: Array<[string | null, string]> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    targets.push([new URL(url).searchParams.get('receive_id_type'), JSON.parse(String(init.body)).receive_id]);
    return Response.json({ code: 0, data: { message_id: 'receipt' } });
  });
  const driver = new FeishuChannelDriver({ instanceId: 'bot', config: { appId: 'app', appSecret: 'secret' } });
  await driver.sendMessage({ chatId: 'account:direct:ou_Person', text: 'one' });
  await driver.sendMessage({ chatId: 'oc_Chat', text: 'two' });
  expect(targets).toEqual([['open_id', 'ou_Person'], ['chat_id', 'oc_Chat']]);
});

test('remembers the DingTalk staff ID from a private callback across restart, and requires a business receipt', async () => {
  const { DingTalkChannelDriver } = await import(dingTalkDriver);
  vi.stubGlobal('WebSocket', class extends EventTarget {
    send() {}
    close() { this.dispatchEvent(new Event('close')); }
  });
  const options = { instanceId: 'bot', config: { clientId: 'app', clientSecret: 'secret' }, onInbound: vi.fn() };
  const first = new DingTalkChannelDriver(options);
  const controller = new AbortController();
  const connected = first.maintainStream('ws://localhost', controller.signal);
  first.ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    type: 'CALLBACK', headers: { messageId: 'message' },
    data: JSON.stringify({ conversationType: '1', conversationId: 'cidPrivate', senderStaffId: 'StaffA', msgtype: 'text', text: { content: 'hello' } }),
  }) }));
  controller.abort();
  await connected;

  let receipt: Record<string, unknown> = { processQueryKey: 'ack' };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.includes('/oauth2/')) return Response.json({ accessToken: 'token', expireIn: 7200 });
    if (new URL(url).pathname === '/v1.0/card/instances') return new Response(null, { status: 403 });
    expect(new URL(url).pathname).toBe('/v1.0/robot/oToMessages/batchSend');
    expect(JSON.parse(String(init.body)).userIds).toEqual(['StaffA']);
    return Response.json(receipt);
  });
  const restarted = new DingTalkChannelDriver(options);
  const reminder = { chatId: 'cidPrivate', text: 'reminder' };
  await expect(restarted.sendMessage(reminder)).resolves.toMatchObject({ messageId: 'ack' });
  receipt = { processQueryKey: 'ack', invalidStaffIdList: ['StaffA'] };
  await expect(restarted.sendMessage(reminder)).rejects.toThrow('did not accept');
  receipt = {};
  await expect(restarted.sendMessage(reminder)).rejects.toThrow('did not accept');
});

test('restores the selected Weixin bot’s case-sensitive recipient and context after an upgrade and a restart', async () => {
  const { WeixinChannelDriver } = await import(weixinDriver);
  const accountId = 'bot@im.bot';
  const accountDir = path.join(home, 'openclaw', 'state', WeixinPlugin.Id, 'accounts');
  fs.mkdirSync(accountDir, { recursive: true });
  const oldFile = path.join(accountDir, legacyWeixinAccountId(accountId) + '.context-tokens.json');
  fs.writeFileSync(oldFile, JSON.stringify({ 'Mixed@im.wechat': 'old-context' }));
  function driver(bot: string) {
    const [options] = buildDshImChannelInstances({ userDataDir: home, imConfig: {
      weixin: { accountId: bot, botToken: 'token', enabled: true },
    } });
    return new WeixinChannelDriver(options);
  }
  const sent: Array<{ to_user_id: string; context_token?: string }> = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).msg);
    return Response.json({ ret: 0 });
  });
  const first = driver(accountId);
  const reminder = { chatId: 'direct:mixed@im.wechat', text: 'reminder' };
  await first.sendMessage(reminder);
  first.rememberContextToken('Mixed@im.wechat', 'fresh-context');
  await driver(accountId).sendMessage(reminder);
  await driver('other@im.bot').sendMessage(reminder);
  expect(sent[0]).toMatchObject({ to_user_id: 'Mixed@im.wechat', context_token: 'old-context' });
  expect(sent[1]).toMatchObject({ to_user_id: 'Mixed@im.wechat', context_token: 'fresh-context' });
  expect(sent[2]).toMatchObject({ to_user_id: 'mixed@im.wechat' });
  expect(sent[2]).not.toHaveProperty('context_token');
});
