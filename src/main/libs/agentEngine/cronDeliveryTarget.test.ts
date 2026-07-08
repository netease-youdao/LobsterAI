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
      intended: { channel: 'openclaw-weixin', to: 'o9cq809ZEC25@im.wechat' },
      resolved: {
        ok: true,
        channel: 'openclaw-weixin',
        to: 'o9cq809ZEC25@im.wechat',
        accountId: '91fcaf18cb3a-im-bot',
        source: 'explicit',
      },
      delivered: true,
    },
    ...overrides,
  };
}

describe('extractCronDeliveredTarget', () => {
  test('extracts the resolved target from a delivered finished event', () => {
    expect(extractCronDeliveredTarget(finishedPayload())).toEqual({
      channel: 'openclaw-weixin',
      to: 'o9cq809ZEC25@im.wechat',
      accountId: '91fcaf18cb3a-im-bot',
    });
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
    expect(extractCronDeliveredTarget(payload)).toEqual({ channel: 'feishu', to: 'ou_c167' });
  });
});
