import { describe, expect, test } from 'vitest';

import { formatFeishuReplyRoute, parseFeishuReplyRoute } from './feishuTopicRoute';

describe('Feishu conversation and delivery routes', () => {
  test.each([
    ['chat:oc_G#__feishu_reply_to=om_M&__feishu_thread_id=omt_T', { chatId: 'oc_G', replyToMessageId: 'om_M', threadId: 'omt_T' }],
    ['12345678:group:oc_G:thread:omt_T', { chatId: 'oc_G', threadId: 'omt_T' }],
    ['group:oc_G:thread:om_R', { chatId: 'oc_G', threadId: 'om_R', replyToMessageId: 'om_R' }],
    ['oc_G#__feishu_reply_to=om_Quote', { chatId: 'oc_G', replyToMessageId: 'om_Quote' }],
  ] as const)('round-trips %s without changing the case of native IDs', (value, expected) => {
    expect(parseFeishuReplyRoute(value)).toEqual(expected);
    expect(parseFeishuReplyRoute(formatFeishuReplyRoute(expected))).toEqual(expected);
  });

  test.each(['group:oc_G', 'oc_DM', 'ordinary'])('leaves ordinary routes alone (%s)', value => {
    expect(parseFeishuReplyRoute(value)).toBeNull();
  });
});
