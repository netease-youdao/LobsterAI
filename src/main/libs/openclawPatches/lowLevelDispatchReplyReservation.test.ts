import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('openclaw-low-level-dispatch-reply-reservation.patch', () => {
  test('releases the reply reservation after low-level channel dispatches', () => {
    // Feishu, POPO and Bee dispatch without withReplyDispatcher(), so the leaked
    // reservation kept every later channel reload waiting on settled replies.
    expectPatchContains('openclaw-low-level-dispatch-reply-reservation.patch', [
      '+    return await dispatchReplyFromConfigWithQueuePolicy(params, true);',
      '+    params.dispatcher.markComplete();',
      'releases the dispatcher reservation once the channel dispatch settles',
    ]);
  });
});
