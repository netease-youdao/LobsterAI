import { expect, test } from 'vitest';

import { MediaConfirmationReason } from '../../shared/media/confirmation';
import { McpBridgeServer } from './mcpBridgeServer';

test('closing a media callback interrupts its pending confirmation and cannot submit', async () => {
  const server = new McpBridgeServer('test-secret');
  let shown!: () => void;
  const published = new Promise<void>(resolve => { shown = resolve; });
  let resolved!: (value: unknown) => void;
  const decision = new Promise(resolve => { resolved = resolve; });
  server.onAskUser(() => shown());
  server.onMediaGeneration(async request => {
    const response = await server.askUserInternal([{ question: 'Confirm?', options: [{ label: 'Generate' }] }], undefined, {
      sessionKey: request.context.sessionKey,
      recoverableMedia: { isCurrent: () => true, refresh: async () => [], onEvent: () => {}, signal: request.signal },
    });
    resolved(response);
    return { content: [], isError: true };
  });
  try {
    await server.start();
    const controller = new AbortController();
    const pending = fetch(server.mediaCallbackUrl!, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobster-media-secret': 'test-secret' },
      body: JSON.stringify({ tool: 'lobsterai_video_generate', args: {}, context: { sessionKey: 'session', toolCallId: 'call' } }),
      signal: controller.signal,
    }).catch(() => undefined);
    await published;
    controller.abort();
    expect(await decision).toMatchObject({ reason: MediaConfirmationReason.Interrupted });
    expect(server.getPendingMediaConfirmations()).toEqual([]);
    await pending;
  } finally {
    await server.stop();
  }
});
