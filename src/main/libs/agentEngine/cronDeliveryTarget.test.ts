import { describe, expect, test } from 'vitest';

import { extractCronDeliveredTarget } from './cronDeliveryTarget';

function finishedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: 'job-1',
    action: 'finished',
    status: 'ok',
    delivered: true,
    deliveryStatus: 'delivered',
    delivery: {
      intended: { channel: 'openclaw-weixin', to: 'WxId_ZhangSan@im.wechat' },
      resolved: {
        ok: true,
        channel: 'openclaw-weixin',
        to: 'WxId_ZhangSan@im.wechat',
        accountId: 'weixin-bot-1',
        source: 'explicit',
      },
      delivered: true,
    },
    sessionKey: 'agent:main:cron:job-1:run:run-1',
    ...overrides,
  };
}

describe('extractCronDeliveredTarget', () => {
  test('extracts the resolved target from a delivered finished event', () => {
    expect(extractCronDeliveredTarget(finishedPayload())).toEqual({
      channel: 'openclaw-weixin',
      to: 'WxId_ZhangSan@im.wechat',
      accountId: 'weixin-bot-1',
      agentId: 'main',
    });
  });

  test('prefers the job agent over the run session key agent', () => {
    expect(
      extractCronDeliveredTarget(
        finishedPayload({
          job: { agentId: 'agent-feishu-bot-1' },
          sessionKey: 'agent:main:cron:job-1:run:run-1',
        }),
      ),
    ).toMatchObject({ agentId: 'agent-feishu-bot-1' });
  });

  test('ignores non-finished and undelivered events', () => {
    expect(extractCronDeliveredTarget(finishedPayload({ action: 'started' }))).toBeNull();
    expect(
      extractCronDeliveredTarget(
        finishedPayload({ delivered: false, delivery: { delivered: false } }),
      ),
    ).toBeNull();
    expect(extractCronDeliveredTarget(null)).toBeNull();
    expect(extractCronDeliveredTarget('junk')).toBeNull();
  });

  test('accepts the delivered flag from the delivery object alone', () => {
    const payload = finishedPayload({ delivered: undefined });
    expect(extractCronDeliveredTarget(payload)).not.toBeNull();
  });

  test('requires a resolved channel and target', () => {
    expect(
      extractCronDeliveredTarget(finishedPayload({ delivery: { delivered: true } })),
    ).toBeNull();
    expect(
      extractCronDeliveredTarget(
        finishedPayload({
          delivery: { delivered: true, resolved: { channel: 'feishu', to: '  ' } },
        }),
      ),
    ).toBeNull();
  });

  test('omits a blank accountId', () => {
    const payload = finishedPayload({
      delivery: {
        delivered: true,
        resolved: { channel: 'feishu', to: 'ou_c167', accountId: '  ' },
      },
    });
    expect(extractCronDeliveredTarget(payload)).toEqual({
      channel: 'feishu',
      to: 'ou_c167',
      agentId: 'main',
    });
  });
});
