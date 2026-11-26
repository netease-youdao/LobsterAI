import { afterEach, expect, test, vi } from 'vitest';

const driverPath = '../dsh-bundles/lobsterai-channels/plugins/drivers/feishu.mjs';

afterEach(() => vi.unstubAllGlobals());

test('handles native topics and root-only topic groups, and keeps ordinary group quotes out of threads', async () => {
  const { FeishuChannelDriver } = await import(driverPath);
  const groupLookups: string[] = [];
  const outbound: Array<{ path: string; body: Record<string, unknown> }> = [];
  let messageId = 'om_Receipt';
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'test', expire: 7200 });
    if (path.includes('/chats/')) {
      groupLookups.push(path);
      return Response.json({ code: 0, data: { chat_mode: path.endsWith('oc_Topic') ? 'topic' : 'group' } });
    }
    outbound.push({ path, body: JSON.parse(String(init?.body)) });
    return Response.json({ code: 0, data: { message_id: messageId } });
  });
  const onInbound = vi.fn();
  const driver = new FeishuChannelDriver({ instanceId: 'a', config: { appId: 'test', appSecret: 'test' }, onInbound });
  async function receive(chat: string, thread?: string) {
    await driver.handleFeishuEventPayload({
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_A' } },
        message: { message_id: 'om_M', chat_id: chat, chat_type: 'group', root_id: 'om_Root',
          thread_id: thread, message_type: 'text', content: JSON.stringify({ text: 'hello' }) },
      },
    });
    return onInbound.mock.lastCall?.[0].replyContext;
  }
  const native = await receive('oc_Topic', 'omt_Case');
  expect(native).toMatchObject({ threadId: 'omt_Case', rootMessageId: 'om_Root', replyInThread: true });
  expect((await receive('oc_Topic')).threadId).toBe('om_Root');
  await receive('oc_Topic');
  const quote = await receive('oc_Group');
  expect(quote.threadId).toBeUndefined();
  expect(groupLookups.filter(p => p.endsWith('oc_Topic'))).toHaveLength(1);
  await driver.sendMessage({ chatId: 'oc_Topic', text: 'topic', replyContext: native });
  await driver.sendMessage({ chatId: 'oc_Group', text: 'group', replyContext: quote });
  expect(outbound[0]).toMatchObject({ path: '/open-apis/im/v1/messages/om_M/reply', body: { reply_in_thread: true } });
  expect(outbound[0].body).not.toHaveProperty('receive_id');
  expect(outbound[1]).toMatchObject({ path: '/open-apis/im/v1/messages', body: { receive_id: 'oc_Group' } });
  messageId = '';
  await expect(driver.sendMessage({ chatId: 'oc_Topic', text: 'retry', replyContext: native })).rejects.toThrow(/acknowledge/);
});
