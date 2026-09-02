import { describe, expect, test } from 'vitest';

import { PayloadKind } from '../../../scheduledTask/constants';
import type { ScheduledTaskPayload } from '../../../scheduledTask/types';
import { getPayloadAnalyticsParams } from './analytics';

describe('getPayloadAnalyticsParams', () => {
  test('reports normal agent prompts', () => {
    expect(
      getPayloadAnalyticsParams({
        kind: PayloadKind.AgentTurn,
        message: 'Prepare the daily brief',
      }),
    ).toEqual({
      payloadKind: PayloadKind.AgentTurn,
      payloadTextLength: 23,
      hasPrompt: true,
    });
  });

  test('does not throw when gateway data is missing payload text', () => {
    const malformedPayload = {
      kind: PayloadKind.AgentTurn,
    } as unknown as ScheduledTaskPayload;

    expect(getPayloadAnalyticsParams(malformedPayload)).toEqual({
      payloadKind: PayloadKind.AgentTurn,
      payloadTextLength: 0,
      hasPrompt: false,
    });
  });
});
